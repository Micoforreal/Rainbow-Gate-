import { Router, type Response } from "express";
import { getPaymentStore } from "../lib/payments";
import {
  requireMerchantKey,
  hasMerchantAccess,
  type AuthenticatedRequest,
} from "../lib/auth";
import {
  createSubscription,
  cancelSubscription,
  pauseSubscription,
  chargeSubscriptionNow,
  resumeSubscription,
  serializeSubscription,
  SUBSCRIPTION_MODEL,
  SUBSCRIPTION_RENEWAL_NOTICE,
  SubscriptionTransitionError,
} from "../lib/subscriptions";
import type { FacilitatorRouter } from "../router";
import { normalizeWalletAddress } from "../lib/wallet-auth";

export function createSubscriptionsRouter(router?: FacilitatorRouter): Router {
  const routes = Router();
  const store = getPaymentStore();

  // All subscription routes require merchant API key
  routes.use("/subscriptions", requireMerchantKey);

  // 1. POST /subscriptions — Create subscription. First payment is normal x402 payment.
  routes.post(
    "/subscriptions",
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const merchant = req.merchant!;
        const {
          merchantId: requestedMerchantId,
          userId,
          payer,
          chain,
          asset,
          amount,
          interval,
          maxCharges,
          firstPaymentId,
          expiresAt,
        } = req.body;

        if (
          requestedMerchantId !== undefined &&
          requestedMerchantId !== merchant.merchantId
        ) {
          res.status(403).json({
            error: "merchantId does not match the merchant authenticated by X-API-Key",
            code: "FORBIDDEN",
          });
          return;
        }

        if (!payer || typeof payer !== "string") {
          res.status(400).json({
            error: "Missing or invalid payer",
            code: "INVALID_PAYER",
            message: "Payer must be a connected wallet address",
          });
          return;
        }
        if (payer.includes("@")) {
          res.status(400).json({
            error: "Payer must be a wallet address",
            code: "INVALID_PAYER",
          });
          return;
        }

        if (
          typeof amount !== "string" ||
          !/^\d+$/.test(amount) ||
          BigInt(amount) <= 0n
        ) {
          res.status(400).json({
            error: "amount must be a positive integer string",
            code: "INVALID_AMOUNT",
          });
          return;
        }

        if (!chain || !asset) {
          res.status(400).json({
            error: "Missing subscription parameters",
            code: "MISSING_PARAMS",
            message: "chain, asset, and amount are required",
          });
          return;
        }
        const normalizedPayer = normalizeWalletAddress(chain, payer);

        if (interval !== "weekly" && interval !== "monthly") {
          res.status(400).json({
            error: "Invalid interval",
            code: "INVALID_INTERVAL",
            message: "interval must be 'weekly' or 'monthly'",
          });
          return;
        }
        if (
          maxCharges !== undefined &&
          maxCharges !== null &&
          (!Number.isInteger(Number(maxCharges)) || Number(maxCharges) < 1)
        ) {
          res.status(400).json({
            error: "maxCharges must be a positive integer",
            code: "INVALID_MAX_CHARGES",
          });
          return;
        }
        if (
          expiresAt !== undefined &&
          expiresAt !== null &&
          (typeof expiresAt !== "string" ||
            !Number.isFinite(Date.parse(expiresAt)) ||
            Date.parse(expiresAt) <= Date.now())
        ) {
          res.status(400).json({
            error: "expiresAt must be a future ISO timestamp",
            code: "INVALID_EXPIRY",
          });
          return;
        }

        if (
          typeof userId !== "string" ||
          !store.userOwnsWallet(userId, chain, normalizedPayer)
        ) {
          res.status(403).json({
            error: "Payer wallet does not belong to userId",
            code: "FORBIDDEN",
          });
          return;
        }

        const account = store.getMerchantAccount(merchant.merchantId);
        if (
          !account?.accepts.some(
            (accepted) =>
              accepted.chain === chain && accepted.asset === asset,
          )
        ) {
          res.status(400).json({
            error: "chain and asset are not in the merchant accepts list",
            code: "UNSUPPORTED_ASSET",
          });
          return;
        }

        if (typeof firstPaymentId !== "string") {
          res.status(400).json({
            error: "firstPaymentId must reference a settled payment",
            code: "INVALID_FIRST_PAYMENT",
          });
          return;
        }
        const firstPayment = store.getPayment(firstPaymentId);
        const merchantConfig = store.getMerchant(merchant.merchantId);
        if (
          !firstPayment ||
          !["settled", "SUCCESS"].includes(firstPayment.status) ||
          normalizeWalletAddress(chain, firstPayment.payer) !==
            normalizedPayer ||
          firstPayment.network !== chain ||
          firstPayment.asset !== asset ||
          firstPayment.amount !== amount ||
          firstPayment.payTo !== merchantConfig?.payTo[chain] ||
          (firstPayment.merchantId &&
            firstPayment.merchantId !== merchant.merchantId)
        ) {
          res.status(400).json({
            error:
              "firstPaymentId must match the settled payer, merchant, chain, asset, and amount",
            code: "INVALID_FIRST_PAYMENT",
          });
          return;
        }

        const result = await createSubscription({
          userId,
          merchantId: merchant.merchantId,
          payer: normalizedPayer,
          chain,
          asset,
          amount,
          interval,
          maxCharges: maxCharges !== undefined ? Number(maxCharges) : null,
          firstPaymentId,
          expiresAt: typeof expiresAt === "string" ? expiresAt : null,
        });

        res.status(201).json({
          ...result,
          subscription: serializeSubscription(result.subscription),
        });
      } catch (err: any) {
        res.status(400).json({
          error: err.message,
          code: "SUBSCRIPTION_CREATION_FAILED",
          message: err.message,
        });
      }
    },
  );

  // 2. GET /subscriptions/:id — Get subscription details
  routes.get(
    "/subscriptions/:id",
    (req: AuthenticatedRequest, res: Response) => {
      try {
        const merchant = req.merchant!;
        const id = String(req.params.id);
        const sub = store.getSubscription(id);

        if (!sub) {
          res.status(404).json({
            error: "Subscription not found",
            code: "NOT_FOUND",
            message: `No subscription found with ID: ${id}`,
          });
          return;
        }

        if (sub.merchantId !== merchant.merchantId) {
          res.status(403).json({
            error: "Forbidden",
            code: "FORBIDDEN",
            message:
              "API key does not belong to the owner of this subscription",
          });
          return;
        }

        res.status(200).json({
          subscription: serializeSubscription(sub),
          model: SUBSCRIPTION_MODEL,
          renewalNotice: SUBSCRIPTION_RENEWAL_NOTICE,
        });
      } catch (err: any) {
        res.status(500).json({
          error: "Internal server error",
          code: "INTERNAL_ERROR",
          message: err.message,
        });
      }
    },
  );

  // 3. GET /subscriptions?merchantId=&payer= — List subscriptions
  routes.get("/subscriptions", (req: AuthenticatedRequest, res: Response) => {
    try {
      const merchant = req.merchant!;
      const queryMerchant = req.query.merchantId as string | undefined;

      if (queryMerchant && queryMerchant !== merchant.merchantId) {
        res.status(403).json({
          error: "Forbidden",
          code: "FORBIDDEN",
          message: `API key does not belong to merchant: ${queryMerchant}`,
        });
        return;
      }

      const payer = req.query.payer as string | undefined;
      const status = req.query.status as string | undefined;
      const limit = req.query.limit
        ? parseInt(req.query.limit as string, 10)
        : 50;
      const offset = req.query.offset
        ? parseInt(req.query.offset as string, 10)
        : 0;

      const result = store.listSubscriptions({
        merchantId: merchant.merchantId,
        payer,
        status,
        limit,
        offset,
      });

      res.status(200).json({
        subscriptions: result.subscriptions.map(serializeSubscription),
        total: result.total,
        limit,
        offset,
        model: SUBSCRIPTION_MODEL,
        renewalNotice: SUBSCRIPTION_RENEWAL_NOTICE,
      });
    } catch (err: any) {
      res.status(500).json({
        error: "Internal server error",
        code: "INTERNAL_ERROR",
        message: err.message,
      });
    }
  });

  // 4. POST /subscriptions/:id/cancel — Instant cancel
  routes.post(
    "/subscriptions/:id/cancel",
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const merchant = req.merchant!;
        const id = String(req.params.id);
        const sub = store.getSubscription(id);

        if (!sub) {
          res.status(404).json({
            error: "Subscription not found",
            code: "NOT_FOUND",
            message: `No subscription found with ID: ${id}`,
          });
          return;
        }

        if (sub.merchantId !== merchant.merchantId) {
          res.status(403).json({
            error: "Forbidden",
            code: "FORBIDDEN",
            message:
              "API key does not belong to the owner of this subscription",
          });
          return;
        }

        const cancelled = await cancelSubscription(id, merchant.merchantId);
        res.status(200).json({
          subscription: serializeSubscription(cancelled),
          message:
            "Subscription cancelled instantly. No further charges will occur.",
          model: SUBSCRIPTION_MODEL,
          renewalNotice: SUBSCRIPTION_RENEWAL_NOTICE,
        });
      } catch (err: any) {
        res
          .status(err instanceof SubscriptionTransitionError ? 409 : 400)
          .json({
            error: err.message,
            code:
              err instanceof SubscriptionTransitionError
                ? "INVALID_TRANSITION"
                : "CANCEL_FAILED",
            message: err.message,
          });
      }
    },
  );

  // 5. POST /subscriptions/:id/pause — Pause subscription
  routes.post(
    "/subscriptions/:id/pause",
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const merchant = req.merchant!;
        const id = String(req.params.id);
        const sub = store.getSubscription(id);

        if (!sub) {
          res.status(404).json({
            error: "Subscription not found",
            code: "NOT_FOUND",
            message: `No subscription found with ID: ${id}`,
          });
          return;
        }

        if (sub.merchantId !== merchant.merchantId) {
          res.status(403).json({
            error: "Forbidden",
            code: "FORBIDDEN",
            message:
              "API key does not belong to the owner of this subscription",
          });
          return;
        }

        const paused = await pauseSubscription(id, merchant.merchantId);
        res.status(200).json({
          subscription: serializeSubscription(paused),
          message: "Subscription paused.",
          model: SUBSCRIPTION_MODEL,
          renewalNotice: SUBSCRIPTION_RENEWAL_NOTICE,
        });
      } catch (err: any) {
        res
          .status(err instanceof SubscriptionTransitionError ? 409 : 400)
          .json({
            error: err.message,
            code:
              err instanceof SubscriptionTransitionError
                ? "INVALID_TRANSITION"
                : "PAUSE_FAILED",
            message: err.message,
          });
      }
    },
  );

  // Resume a paused subscription without changing its paid-through date.
  routes.post(
    "/subscriptions/:id/resume",
    async (req: AuthenticatedRequest, res: Response) => {
      const merchant = req.merchant!;
      const id = String(req.params.id);
      const sub = store.getSubscription(id);
      if (!sub) {
        res
          .status(404)
          .json({ error: "Subscription not found", code: "NOT_FOUND" });
        return;
      }
      if (sub.merchantId !== merchant.merchantId) {
        res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });
        return;
      }
      try {
        const resumed = await resumeSubscription(id, merchant.merchantId);
        res.status(200).json({
          subscription: serializeSubscription(resumed),
          model: SUBSCRIPTION_MODEL,
          renewalNotice: SUBSCRIPTION_RENEWAL_NOTICE,
        });
      } catch (err: any) {
        res
          .status(err instanceof SubscriptionTransitionError ? 409 : 400)
          .json({
            error: err.message,
            code:
              err instanceof SubscriptionTransitionError
                ? "INVALID_TRANSITION"
                : "RESUME_FAILED",
          });
      }
    },
  );

  // 6. POST /subscriptions/:id/charge-now — Manual charge for one period
  routes.post(
    "/subscriptions/:id/charge-now",
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const merchant = req.merchant!;
        const id = String(req.params.id);
        const sub = store.getSubscription(id);

        if (!sub) {
          res.status(404).json({
            error: "Subscription not found",
            code: "NOT_FOUND",
            message: `No subscription found with ID: ${id}`,
          });
          return;
        }

        if (sub.merchantId !== merchant.merchantId) {
          res.status(403).json({
            error: "Forbidden",
            code: "FORBIDDEN",
            message:
              "API key does not belong to the owner of this subscription",
          });
          return;
        }

        const result = await chargeSubscriptionNow(id, merchant.merchantId);

        res.status(200).json({
          ...result,
          subscription: serializeSubscription(result.subscription),
          model: SUBSCRIPTION_MODEL,
          renewalNotice: SUBSCRIPTION_RENEWAL_NOTICE,
        });
      } catch (err: any) {
        res
          .status(err instanceof SubscriptionTransitionError ? 409 : 400)
          .json({
            error: err.message,
            code:
              err instanceof SubscriptionTransitionError
                ? "INVALID_TRANSITION"
                : "CHARGE_NOW_FAILED",
            message: err.message,
          });
      }
    },
  );

  return routes;
}
