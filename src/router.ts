/**
 * router.ts — Multi-rail router matching payment requests to registered handlers
 */

import crypto from "crypto";
import type {
  NetworkHandler,
  VerifyResult,
  SettleResult,
  SupportedResponse,
  SupportedKind,
  PaymentRecord,
} from "./types/driver.types";
import { getPaymentStore } from "./lib/payments";
import {
  activeAssets,
  config,
  isNetworkForActiveEnvironment,
  isTestnet,
} from "./config";
import { canonicalizeJson } from "./handlers/near";
import { sendMerchantWebhook } from "./lib/webhooks";
import { normalizeWalletAddress } from "./lib/wallet-auth";

export interface FacilitatorRouterOptions {
  isTestnet?: boolean;
}

export class FacilitatorRouter {
  private handlers: Map<string, NetworkHandler> = new Map();
  private handlerList: NetworkHandler[] = [];
  private store = getPaymentStore();
  private isTestnet: boolean;
  private inFlightSettles: Set<string> = new Set();

  constructor(opts?: FacilitatorRouterOptions) {
    // Derive isTestnet directly from network configuration, NOT from NODE_ENV
    this.isTestnet = opts?.isTestnet ?? isTestnet;
  }

  public registerHandler(name: string, handler: NetworkHandler): void {
    // Fail-closed at boot: Reject duplicate handler registration
    if (this.handlers.has(name)) {
      throw new Error(
        `[Router Boot Error] Duplicate handler registration for name: "${name}"`,
      );
    }
    this.handlers.set(name, handler);
    this.handlerList.push(handler);
  }

  public getHandlerForNetwork(network: string): NetworkHandler | null {
    for (const handler of this.handlerList) {
      if (handler.supportsNetwork(network)) {
        return handler;
      }
    }
    return null;
  }

  public getDeployedHandlers(): string[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * GET /supported — Returns exact union of supported kinds derived directly from deployed handlers.
   * On test deployments, only testnet kinds are advertised. Never mixes mainnet and testnet.
   */
  public getSupported(): SupportedResponse {
    const kinds: SupportedKind[] = [];

    // Derive strictly from registered handlers
    for (const handler of this.handlerList) {
      if (handler.getSupportedKinds) {
        const handlerKinds = handler.getSupportedKinds(this.isTestnet);
        kinds.push(...handlerKinds);
      }
    }

    const signers: Record<string, string[]> = {};
    const relayerAccount = config.NEAR_RELAYER_ACCOUNT_ID;
    if (this.isTestnet) {
      if (relayerAccount && this.handlers.has("near")) {
        signers[activeAssets.near.network] = [relayerAccount];
      }
    } else {
      // Config rejects the testnet default and known uncreated mainnet relayer before startup.
      if (
        relayerAccount &&
        !relayerAccount.endsWith(".testnet") &&
        this.handlers.has("near")
      ) {
        signers[activeAssets.near.network] = [relayerAccount];
      }
    }

    return {
      x402Version: 2,
      kinds,
      extensions: ["payment-identifier"],
      ...(Object.keys(signers).length > 0 ? { signers } : {}),
    };
  }

  /**
   * Generates a deterministic paymentId for idempotency.
   * Canonicalizes payload to ensure key-order independence.
   */
  public generatePaymentId(payload: any, requirements: any): string {
    if (payload?.paymentId) return payload.paymentId;
    if (requirements?.paymentId) return requirements.paymentId;
    if (payload?.nonce) return payload.nonce;
    const canonicalStr = canonicalizeJson({ payload, requirements });
    return crypto.createHash("sha256").update(canonicalStr).digest("hex");
  }

  /**
   * POST /verify — Validates payment against requirements with no on-chain side effects
   */
  public async verify(payload: any, requirements: any): Promise<VerifyResult> {
    const network = requirements?.network ?? payload?.network;
    if (!network) {
      return {
        isValid: false,
        invalidReason: "Missing network in payment verification request",
      };
    }

    if (!isNetworkForActiveEnvironment(network)) {
      return {
        isValid: false,
        invalidReason: `Network ${network} is not enabled for ${config.NETWORK_ENVIRONMENT}`,
      };
    }

    const handler = this.getHandlerForNetwork(network);
    if (!handler) {
      return {
        isValid: false,
        invalidReason: `No deployed handler for network: ${network}`,
      };
    }

    const paymentId = this.generatePaymentId(payload, requirements);
    const result = await handler.verify(payload, requirements);

    // Save/update record in durable store without ever downgrading settled status
    const existing = this.store.getPayment(paymentId);
    const record: PaymentRecord = {
      paymentId,
      network,
      scheme: handler.scheme,
      payer: result.payer ?? existing?.payer ?? "unknown",
      payTo: requirements.payTo ?? existing?.payTo ?? "unknown",
      asset:
        requirements.asset ??
        requirements.price?.asset ??
        existing?.asset ??
        "unknown",
      amount: String(
        requirements.amount ??
          requirements.price?.amount ??
          existing?.amount ??
          "0",
      ),
      status:
        existing?.status === "settled"
          ? "settled"
          : result.isValid
            ? "verified"
            : "failed",
      txHash: existing?.txHash,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
      settledAt: existing?.settledAt,
      invalidReason:
        existing?.status === "settled" ? undefined : result.invalidReason,
      userId:
        existing?.userId ??
        (result.payer
          ? this.store.findUserWallet(
              network,
              normalizeWalletAddress(network, result.payer),
            )?.userId
          : undefined),
    };
    this.store.savePayment(record);

    return result;
  }

  /**
   * POST /settle — Idempotent settlement execution with durable storage
   */
  public async settle(payload: any, requirements: any): Promise<SettleResult> {
    const network = requirements?.network ?? payload?.network;
    if (!network) {
      return {
        success: false,
        errorReason: "Missing network in settlement request",
      };
    }

    if (!isNetworkForActiveEnvironment(network)) {
      return {
        success: false,
        errorReason: `Network ${network} is not enabled for ${config.NETWORK_ENVIRONMENT}`,
      };
    }

    const handler = this.getHandlerForNetwork(network);
    if (!handler) {
      return {
        success: false,
        errorReason: `No deployed handler for network: ${network}`,
      };
    }

    const paymentId = this.generatePaymentId(payload, requirements);

    const existing = this.store.getPayment(paymentId);
    const subscriptionId =
      requirements?.subscriptionId ?? requirements?.extra?.subscriptionId;
    let subscription: ReturnType<typeof this.store.getSubscription> = null;

    if (subscriptionId) {
      subscription = this.store.getSubscription(String(subscriptionId));
      if (!subscription)
        return { success: false, errorReason: "Unknown subscriptionId" };
      const expectedParent =
        subscription.lastPaymentId ??
        subscription.latestPaymentId ??
        subscription.firstPaymentId ??
        null;
      const requirementsMatch =
        subscription.merchantId === requirements.merchantId &&
        subscription.chain === network &&
        subscription.asset === requirements.asset &&
        subscription.amount === String(requirements.amount) &&
        (subscription.status === "active" ||
          subscription.status === "past_due") &&
        (!subscription.expiresAt ||
          new Date(subscription.expiresAt).getTime() > Date.now()) &&
        (subscription.maxCharges === null ||
          subscription.maxCharges === undefined ||
          subscription.chargesUsed < subscription.maxCharges) &&
        this.store.getMerchant(subscription.merchantId)?.payTo[network] ===
          requirements.payTo &&
        (requirements.parentPaymentId ??
          requirements.extra?.parentPaymentId ??
          null) === expectedParent;
      let pending: any = null;
      try {
        pending = JSON.parse(subscription.pendingPaymentPayload ?? "null");
      } catch {}
      if (
        !requirementsMatch ||
        pending?.paymentId !== paymentId ||
        (pending.expiresAt &&
          new Date(pending.expiresAt).getTime() <= Date.now())
      ) {
        return {
          success: false,
          errorReason:
            "Subscription payment requirement is stale or does not match the subscription",
        };
      }
      const payerVerification = await handler.verify(payload, requirements);
      if (
        !payerVerification.isValid ||
        !payerVerification.payer ||
        normalizeWalletAddress(network, payerVerification.payer) !==
          normalizeWalletAddress(network, subscription.payer)
      ) {
        return {
          success: false,
          errorReason:
            payerVerification.invalidReason ??
            "Subscription payment signer does not match payer",
        };
      }
    }

    // 1. Terminal Check: A refunded payment can never be settled again
    if (
      existing &&
      (existing.status === "REFUNDED" || existing.status === "refunded")
    ) {
      return {
        success: false,
        errorReason: "Payment has been refunded and cannot be settled again",
      };
    }

    // 2. Idempotency Check: Return existing result if already settled
    if (
      existing &&
      (existing.status === "settled" || existing.status === "SUCCESS") &&
      existing.txHash
    ) {
      console.log(
        `[Router] Idempotent hit: payment ${paymentId} already settled (${existing.txHash})`,
      );
      return {
        success: true,
        transaction: existing.txHash,
        network: existing.network,
        payer: existing.payer,
      };
    }

    // 2. In-flight guard: prevent concurrent double-settlement of identical payment
    if (this.inFlightSettles.has(paymentId)) {
      return {
        success: false,
        errorReason: `Settlement for payment ${paymentId} is already in flight`,
      };
    }

    this.inFlightSettles.add(paymentId);
    try {
      // 3. Perform settlement through designated handler (which re-verifies internally)
      const result = await handler.settle(payload, requirements);

      // 4. Durably save before returning
      // Critical: settledAt ONLY on success, and failure reason in invalidReason
      const record: PaymentRecord = {
        paymentId,
        network,
        scheme: handler.scheme,
        payer: result.payer ?? existing?.payer ?? "unknown",
        payTo: requirements.payTo ?? existing?.payTo ?? "unknown",
        asset:
          requirements.asset ??
          requirements.price?.asset ??
          existing?.asset ??
          "unknown",
        amount: String(
          requirements.amount ??
            requirements.price?.amount ??
            existing?.amount ??
            "0",
        ),
        status: result.success ? "settled" : "failed",
        txHash: result.success ? result.transaction : undefined,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        settledAt: result.success ? new Date().toISOString() : undefined,
        invalidReason: result.success ? undefined : result.errorReason,
        merchantId:
          (requirements as any).merchantId &&
          this.store.getMerchant((requirements as any).merchantId)
            ? (requirements as any).merchantId
            : existing?.merchantId,
        userId:
          existing?.userId ??
          (result.payer
            ? this.store.findUserWallet(
                network,
                normalizeWalletAddress(network, result.payer),
              )?.userId
            : undefined),
        subscriptionId: subscriptionId
          ? String(subscriptionId)
          : existing?.subscriptionId,
        parentPaymentId:
          (requirements as any).parentPaymentId ??
          requirements.extra?.parentPaymentId ??
          existing?.parentPaymentId,
      };
      this.store.savePayment(record);

      if (result.success && subscriptionId) {
        const completion = this.store.completeSubscriptionCharge(
          String(subscriptionId),
          paymentId,
          record.settledAt!,
        );
        if (completion.applied && completion.subscription) {
          sendMerchantWebhook(
            String(requirements.merchantId),
            "subscription.charge_succeeded",
            {
              subscriptionId: String(subscriptionId),
              paymentId,
              amount: record.amount,
              txHash: result.transaction ?? null,
            },
          ).catch(() => {});
        }
      }

      return result;
    } finally {
      this.inFlightSettles.delete(paymentId);
    }
  }
}
