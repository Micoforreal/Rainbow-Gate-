import crypto from "crypto";
import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { getPaymentStore } from "../lib/payments";
import {
  makeWalletAuthMessage,
  normalizeWalletAddress,
  verifyWalletSignature,
} from "../lib/wallet-auth";
import {
  cancelSubscription,
  serializeSubscription,
  SUBSCRIPTION_MODEL,
  SUBSCRIPTION_RENEWAL_NOTICE,
} from "../lib/subscriptions";
import { getExplorerUrl } from "../lib/payments";
import type { UserRecord } from "../types/driver.types";

type UserRequest = Request & { user?: UserRecord };

function requireUser(req: Request, res: Response, next: NextFunction): void {
  const authorization = req.header("Authorization");
  const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const user = token ? getPaymentStore().getSessionUser(token) : null;
  if (!user) {
    res.status(401).json({
      error: "Unauthorized",
      code: "UNAUTHORIZED",
      message: "A valid Bearer session token is required",
    });
    return;
  }
  (req as UserRequest).user = user;
  next();
}

function asUser(req: Request): UserRecord {
  return (req as UserRequest).user!;
}

function validWalletInput(
  chain: unknown,
  walletAddress: unknown,
): chain is string {
  if (
    typeof chain !== "string" ||
    typeof walletAddress !== "string" ||
    !walletAddress.trim()
  )
    return false;
  if (chain.startsWith("eip155:"))
    return (
      /^eip155:\d+$/.test(chain) && /^0x[0-9a-f]{40}$/i.test(walletAddress)
    );
  if (chain.startsWith("solana:")) return true;
  if (chain.startsWith("near:") || chain === "intents:near") return true;
  return false;
}

function publicStatus(status: string): string {
  if (status === "settled") return "SUCCESS";
  if (status === "verified") return "PROCESSING";
  if (status === "pending") return "PENDING_DEPOSIT";
  if (status === "failed") return "FAILED";
  if (status === "refunded") return "REFUNDED";
  return status;
}

function publicPayment(
  store: ReturnType<typeof getPaymentStore>,
  payment: NonNullable<ReturnType<typeof store.getPayment>>,
) {
  const events = store.getPaymentEvents(payment.paymentId);
  const isOneClick = Boolean(
    payment.quoteId ||
    payment.depositAddress ||
    payment.network.startsWith("intents:"),
  );
  return {
    id: payment.paymentId,
    status: publicStatus(payment.status),
    amount: payment.amount,
    asset: payment.asset,
    network: payment.network,
    payer: payment.payer,
    payTo: payment.payTo,
    txHash: payment.txHash ?? null,
    explorerUrl:
      payment.explorerUrl ??
      getExplorerUrl(payment.network, payment.txHash) ??
      null,
    feeBreakdown: payment.feeBreakdown ?? {
      gas: "0",
      gasMargin30Pct: "0",
      oneClickFee: "0",
      totalFee: "0",
    },
    quote: isOneClick
      ? {
          quoteId: payment.quoteId ?? null,
          depositAddress: payment.depositAddress ?? null,
          refundTo: payment.refundTo ?? null,
        }
      : null,
    deposit: isOneClick
      ? { depositAddress: payment.depositAddress ?? null, depositTxHash: null }
      : null,
    events: events.map((event) => ({
      oldStatus: event.oldStatus ? publicStatus(event.oldStatus) : null,
      newStatus: publicStatus(event.newStatus),
      reason: event.reason ?? null,
      createdAt: event.createdAt,
    })),
    failureReason: payment.failureReason ?? payment.invalidReason ?? null,
    parentPaymentId: payment.parentPaymentId ?? null,
    attemptNumber: payment.attemptNumber ?? 1,
    createdAt: payment.createdAt,
    settledAt: payment.settledAt ?? null,
  };
}

export function createAccountsRouter(): Router {
  const routes = Router();
  const store = getPaymentStore();

  routes.post("/auth/nonce", (req: Request, res: Response) => {
    const { chain, walletAddress } = req.body ?? {};
    if (!validWalletInput(chain, walletAddress)) {
      res.status(400).json({
        error: "Invalid chain or walletAddress",
        code: "INVALID_WALLET",
      });
      return;
    }
    const normalizedAddress = normalizeWalletAddress(
      chain,
      walletAddress.trim(),
    );
    const nonce = crypto.randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const message = makeWalletAuthMessage(
      chain,
      normalizedAddress,
      nonce,
      expiresAt,
    );
    store.createAuthNonce(nonce, chain, normalizedAddress, message, expiresAt);
    res.status(200).json({ nonce, message, expiresAt });
  });

  routes.post("/auth/verify", async (req: Request, res: Response) => {
    const { chain, walletAddress, signature, nonce } = req.body ?? {};
    if (
      !validWalletInput(chain, walletAddress) ||
      typeof signature !== "string" ||
      typeof nonce !== "string"
    ) {
      res.status(400).json({
        error: "chain, walletAddress, signature, and nonce are required",
        code: "INVALID_AUTH_REQUEST",
      });
      return;
    }
    const address = normalizeWalletAddress(chain, walletAddress.trim());
    const message = store.getAuthNonceMessage(nonce, chain, address);
    if (
      !message ||
      !(await verifyWalletSignature(chain, address, message, signature))
    ) {
      res.status(401).json({
        error: "Invalid wallet signature or expired nonce",
        code: "UNAUTHORIZED",
      });
      return;
    }
    if (store.consumeAuthNonce(nonce, chain, address) !== message) {
      res.status(401).json({
        error: "Nonce was expired or already used",
        code: "UNAUTHORIZED",
      });
      return;
    }
    try {
      const user = store.createUserForWallet(chain, address);
      const token = crypto.randomBytes(32).toString("base64url");
      const expiresAt = new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString();
      store.createSession(user.id, chain, address, token, expiresAt);
      res
        .status(200)
        .json({ user: store.getUserProfile(user.id), token, expiresAt });
    } catch (error: any) {
      res.status(409).json({ error: error.message, code: "WALLET_CONFLICT" });
    }
  });

  routes.post("/auth/logout", requireUser, (req: Request, res: Response) => {
    const token = req.header("Authorization")!.match(/^Bearer\s+(\S+)$/i)![1];
    store.revokeSession(token);
    res.status(200).json({ success: true });
  });

  routes.post(
    "/auth/link-wallet",
    requireUser,
    async (req: Request, res: Response) => {
      const { chain, walletAddress, signature, nonce } = req.body ?? {};
      if (
        !validWalletInput(chain, walletAddress) ||
        typeof signature !== "string" ||
        typeof nonce !== "string"
      ) {
        res.status(400).json({
          error: "chain, walletAddress, signature, and nonce are required",
          code: "INVALID_AUTH_REQUEST",
        });
        return;
      }
      const address = normalizeWalletAddress(chain, walletAddress.trim());
      const message = store.getAuthNonceMessage(nonce, chain, address);
      if (
        !message ||
        !(await verifyWalletSignature(chain, address, message, signature)) ||
        store.consumeAuthNonce(nonce, chain, address) !== message
      ) {
        res.status(401).json({
          error: "Invalid wallet signature or expired nonce",
          code: "UNAUTHORIZED",
        });
        return;
      }
      try {
        const wallet = store.linkWalletToUser(asUser(req).id, chain, address);
        res.status(201).json({ wallet });
      } catch (error: any) {
        res.status(409).json({ error: error.message, code: "WALLET_CONFLICT" });
      }
    },
  );

  routes.get("/me", requireUser, (req: Request, res: Response) => {
    res.status(200).json(store.getUserProfile(asUser(req).id));
  });

  routes.post("/merchants", requireUser, (req: Request, res: Response) => {
    const { name, email, webhookUrl, accepts } = req.body ?? {};
    if (
      typeof name !== "string" ||
      !name.trim() ||
      (email !== undefined && email !== null && typeof email !== "string") ||
      (webhookUrl !== undefined &&
        webhookUrl !== null &&
        typeof webhookUrl !== "string") ||
      !Array.isArray(accepts) ||
      accepts.length === 0 ||
      accepts.some(
        (item: any) =>
          !item ||
          typeof item.chain !== "string" ||
          typeof item.asset !== "string" ||
          typeof item.payTo !== "string",
      )
    ) {
      res.status(400).json({
        error:
          "name and a non-empty accepts array of { chain, asset, payTo } are required",
        code: "INVALID_MERCHANT",
      });
      return;
    }
    try {
      const created = store.createMerchantAccount(asUser(req).id, {
        name: name.trim(),
        email: email ?? null,
        webhookUrl: webhookUrl ?? null,
        accepts,
      });
      res
        .status(201)
        .json({ merchant: created.merchant, apiKey: created.apiKey });
    } catch (error: any) {
      res
        .status(400)
        .json({ error: error.message, code: "MERCHANT_CREATION_FAILED" });
    }
  });

  routes.get("/merchants", requireUser, (req: Request, res: Response) => {
    res
      .status(200)
      .json({ merchants: store.listOwnedMerchants(asUser(req).id) });
  });

  function ownedMerchant(req: Request, res: Response, merchantId: string) {
    const merchant = store.getMerchantAccount(merchantId);
    if (!merchant) {
      res.status(404).json({ error: "Merchant not found", code: "NOT_FOUND" });
      return null;
    }
    if (merchant.userId !== asUser(req).id) {
      res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });
      return null;
    }
    return merchant;
  }

  routes.post(
    "/merchants/:id/api-keys",
    requireUser,
    (req: Request, res: Response) => {
      const merchant = ownedMerchant(req, res, String(req.params.id));
      if (!merchant) return;
      try {
        const created = store.createApiKey(
          merchant.id,
          typeof req.body?.name === "string" ? req.body.name : "api-key",
        );
        res.status(201).json({ key: created.key, apiKey: created.apiKey });
      } catch (error: any) {
        res
          .status(400)
          .json({ error: error.message, code: "API_KEY_CREATION_FAILED" });
      }
    },
  );

  routes.get(
    "/merchants/:id/api-keys",
    requireUser,
    (req: Request, res: Response) => {
      const merchant = ownedMerchant(req, res, String(req.params.id));
      if (!merchant) return;
      res.status(200).json({ apiKeys: store.listApiKeys(merchant.id) });
    },
  );

  routes.post(
    "/merchants/:id/api-keys/:keyId/revoke",
    requireUser,
    (req: Request, res: Response) => {
      const merchant = ownedMerchant(req, res, String(req.params.id));
      if (!merchant) return;
      if (
        !store
          .listApiKeys(merchant.id)
          .some((key) => key.id === req.params.keyId)
      ) {
        res.status(404).json({ error: "API key not found", code: "NOT_FOUND" });
        return;
      }
      store.revokeApiKey(merchant.id, String(req.params.keyId));
      res.status(200).json({ success: true });
    },
  );

  routes.get(
    "/me/subscriptions",
    requireUser,
    (req: Request, res: Response) => {
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const offset = req.query.offset ? Number(req.query.offset) : 0;
      const result = store.listSubscriptions({
        userId: asUser(req).id,
        limit,
        offset,
      });
      res.status(200).json({
        subscriptions: result.subscriptions.map(serializeSubscription),
        total: result.total,
        limit,
        offset,
      });
    },
  );

  routes.get(
    "/me/subscriptions/:id/pending-charge",
    requireUser,
    (req: Request, res: Response) => {
      const sub = store.getSubscription(String(req.params.id));
      if (!sub) {
        res
          .status(404)
          .json({ error: "Subscription not found", code: "NOT_FOUND" });
        return;
      }
      if (sub.userId !== asUser(req).id) {
        res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });
        return;
      }
      if (!sub.pendingPaymentPayload) {
        res.status(200).json(null);
        return;
      }
      try {
        const charge = JSON.parse(sub.pendingPaymentPayload);
        if (
          charge.expiresAt &&
          new Date(charge.expiresAt).getTime() <= Date.now()
        ) {
          res.status(200).json(null);
          return;
        }
        res.status(200).json(charge);
      } catch {
        res.status(200).json(null);
      }
    },
  );

  routes.get(
    "/me/subscriptions/:id",
    requireUser,
    (req: Request, res: Response) => {
      const sub = store.getSubscription(String(req.params.id));
      if (!sub) {
        res
          .status(404)
          .json({ error: "Subscription not found", code: "NOT_FOUND" });
        return;
      }
      if (sub.userId !== asUser(req).id) {
        res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });
        return;
      }
      res.status(200).json(serializeSubscription(sub));
    },
  );

  routes.post(
    "/me/subscriptions/:id/cancel",
    requireUser,
    async (req: Request, res: Response) => {
      const sub = store.getSubscription(String(req.params.id));
      if (!sub) {
        res
          .status(404)
          .json({ error: "Subscription not found", code: "NOT_FOUND" });
        return;
      }
      if (sub.userId !== asUser(req).id) {
        res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });
        return;
      }
      try {
        const cancelled = await cancelSubscription(sub.id, sub.merchantId);
        res.status(200).json(serializeSubscription(cancelled));
      } catch (error: any) {
        res
          .status(409)
          .json({ error: error.message, code: "INVALID_TRANSITION" });
      }
    },
  );

  routes.get("/me/payments", requireUser, (req: Request, res: Response) => {
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const offset = req.query.offset ? Number(req.query.offset) : 0;
    const result = store.listPayments({
      userId: asUser(req).id,
      limit,
      offset,
    });
    res.status(200).json({
      payments: result.payments.map((payment) => publicPayment(store, payment)),
      total: result.total,
      limit,
      offset,
    });
  });

  routes.get("/me/stats", requireUser, (req: Request, res: Response) => {
    res.status(200).json(store.getUserStats(asUser(req).id));
  });

  return routes;
}
