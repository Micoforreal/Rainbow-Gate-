import crypto from "crypto";
import { getPaymentStore } from "./payments";
import type {
  SubscriptionRecord,
  SubscriptionInterval,
} from "../types/driver.types";
import { sendMerchantWebhook } from "./webhooks";

export const INTERVAL_MS: Record<SubscriptionInterval, number> = {
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

export const SUBSCRIPTION_MODEL = "prepaid_assisted_renewal";
export const SUBSCRIPTION_RENEWAL_NOTICE =
  "No auto-renew. Payer pays once per period and approves renewals with a fresh signed transaction. No spend permissions or escrows.";

export interface CreateSubscriptionParams {
  userId: string;
  merchantId: string;
  payer: string; // Connected wallet address
  chain: string;
  asset: string;
  amount: string;
  interval: SubscriptionInterval;
  maxCharges?: number | null;
  firstPaymentId?: string;
  expiresAt?: string | null;
}

export interface SubscriptionResponse {
  subscription: SubscriptionRecord;
  model: string;
  renewalNotice: string;
  settlement?: any;
}

export class SubscriptionTransitionError extends Error {}

export function serializeSubscription(sub: SubscriptionRecord) {
  return {
    id: sub.id,
    userId: sub.userId ?? null,
    merchantId: sub.merchantId,
    payer: sub.payer,
    chain: sub.chain,
    asset: sub.asset,
    amount: sub.amount,
    interval: sub.interval,
    status: sub.status.toUpperCase(),
    nextChargeAt: sub.nextChargeAt,
    expiresAt: sub.expiresAt ?? null,
    maxCharges: sub.maxCharges ?? null,
    chargesUsed: sub.chargesUsed,
    firstPaymentId: sub.firstPaymentId ?? null,
    lastPaymentId: sub.lastPaymentId ?? sub.latestPaymentId ?? null,
    createdAt: sub.createdAt,
    updatedAt: sub.updatedAt,
    pausedAt: sub.pausedAt ?? null,
    cancelledAt: sub.cancelledAt ?? null,
  };
}

/**
 * Creates a subscription with prepaid + assisted renewal model.
 * The payer MUST be a valid wallet address, and the first payment must be signed by that wallet.
 */
export async function createSubscription(
  params: CreateSubscriptionParams,
): Promise<SubscriptionResponse> {
  const store = getPaymentStore();
  if (!params.payer || params.payer.includes("@"))
    throw new Error("Payer must be a wallet address");
  if (!/^\d+$/.test(params.amount) || BigInt(params.amount) <= 0n)
    throw new Error("amount must be a positive integer string");
  if (params.interval !== "weekly" && params.interval !== "monthly")
    throw new Error("interval must be weekly or monthly");
  if (
    !params.userId ||
    !store.userOwnsWallet(params.userId, params.chain, params.payer)
  ) {
    throw new Error("Payer wallet does not belong to userId");
  }
  const payment = params.firstPaymentId
    ? store.getPayment(params.firstPaymentId)
    : null;
  if (!payment || !["settled", "SUCCESS"].includes(payment.status)) {
    throw new Error("firstPaymentId must reference a real settled payment");
  }
  if (
    payment.payer !== params.payer ||
    payment.network !== params.chain ||
    payment.asset !== params.asset ||
    payment.amount !== params.amount
  ) {
    throw new Error(
      "firstPaymentId does not match payer, chain, asset, or amount",
    );
  }
  const merchant = store.getMerchant(params.merchantId);
  if (
    !merchant ||
    payment.payTo !== merchant.payTo[params.chain] ||
    (payment.merchantId && payment.merchantId !== params.merchantId)
  ) {
    throw new Error("firstPaymentId does not belong to this merchant payTo");
  }

  const now = Date.now();
  const intervalMs = INTERVAL_MS[params.interval];
  const createdAt = new Date(now).toISOString();
  const nextChargeAt = new Date(now + intervalMs).toISOString();
  const expiresAt = params.expiresAt ?? null;
  const initialStatus =
    params.maxCharges !== null &&
    params.maxCharges !== undefined &&
    params.maxCharges <= 1
      ? "ended"
      : "active";

  const subscription: SubscriptionRecord = {
    id: "sub_" + crypto.randomBytes(12).toString("hex"),
    userId: params.userId,
    merchantId: params.merchantId,
    payer: params.payer,
    chain: params.chain,
    asset: params.asset,
    amount: params.amount,
    interval: params.interval,
    nextChargeAt,
    expiresAt,
    maxCharges: params.maxCharges ?? null,
    chargesUsed: 1,
    status: initialStatus,
    createdAt,
    updatedAt: createdAt,
    firstPaymentId: payment.paymentId,
    lastPaymentId: payment.paymentId,
    latestPaymentId: payment.paymentId,
    failureCount: 0,
  };

  store.saveSubscription(subscription);
  sendMerchantWebhook(params.merchantId, "subscription.created", {
    subscriptionId: subscription.id,
    payer: subscription.payer,
    amount: subscription.amount,
    chain: subscription.chain,
    asset: subscription.asset,
  }).catch(() => {});

  return {
    subscription,
    model: SUBSCRIPTION_MODEL,
    renewalNotice: SUBSCRIPTION_RENEWAL_NOTICE,
  };
}

/**
 * Cancels a subscription instantly. Takes effect immediately with no further charges.
 */
export async function cancelSubscription(
  id: string,
  merchantId: string,
): Promise<SubscriptionRecord> {
  const store = getPaymentStore();
  const sub = store.getSubscription(id);
  if (!sub) {
    throw new Error(`Subscription ${id} not found`);
  }

  if (sub.status === "cancelled" || sub.status === "ended") {
    throw new SubscriptionTransitionError(
      `Subscription ${id} cannot be cancelled from ${sub.status}`,
    );
  }

  sub.status = "cancelled";
  sub.updatedAt = new Date().toISOString();
  sub.cancelledAt = sub.updatedAt;
  sub.pendingPaymentPayload = undefined;

  store.saveSubscription(sub);

  sendMerchantWebhook(merchantId, "subscription.cancelled", {
    subscriptionId: sub.id,
    payer: sub.payer,
    cancelledAt: sub.updatedAt,
  }).catch(() => {});

  return sub;
}

/**
 * Pauses a subscription.
 */
export async function pauseSubscription(
  id: string,
  _merchantId: string,
): Promise<SubscriptionRecord> {
  const store = getPaymentStore();
  const sub = store.getSubscription(id);
  if (!sub) {
    throw new Error(`Subscription ${id} not found`);
  }

  if (sub.status !== "active" && sub.status !== "past_due") {
    throw new SubscriptionTransitionError(
      `Subscription ${id} cannot be paused from ${sub.status}`,
    );
  }

  sub.status = "paused";
  sub.updatedAt = new Date().toISOString();
  sub.pausedAt = sub.updatedAt;

  store.saveSubscription(sub);
  return sub;
}

export async function resumeSubscription(
  id: string,
  _merchantId: string,
  now = new Date(),
): Promise<SubscriptionRecord> {
  const store = getPaymentStore();
  const sub = store.getSubscription(id);
  if (!sub) throw new Error(`Subscription ${id} not found`);
  if (sub.status !== "active" && sub.status !== "paused") {
    throw new SubscriptionTransitionError(
      `Subscription ${id} cannot be resumed from ${sub.status}`,
    );
  }
  if (sub.expiresAt && now.getTime() >= new Date(sub.expiresAt).getTime()) {
    sub.status = "ended";
    sub.updatedAt = now.toISOString();
    store.saveSubscription(sub);
    throw new SubscriptionTransitionError(`Subscription ${id} has expired`);
  }
  const wasPaused = sub.status === "paused";
  const wasDue = new Date(sub.nextChargeAt).getTime() <= now.getTime();
  if (wasDue) {
    sub.nextChargeAt = new Date(
      now.getTime() + INTERVAL_MS[sub.interval],
    ).toISOString();
  }
  if (!wasPaused && !wasDue) return sub;
  sub.status = "active";
  sub.pausedAt = undefined;
  sub.updatedAt = now.toISOString();
  store.saveSubscription(sub);
  return sub;
}

/** Create a signable renewal requirement; only POST /settle can advance the paid term. */
export async function chargeSubscriptionNow(
  id: string,
  merchantId: string,
): Promise<{
  subscription: SubscriptionRecord;
  x402Version: number;
  paymentId: string;
  paymentRequirements: any;
  amount: string;
  asset: string;
  network: string;
  payTo: string;
  expiresAt: string;
  message: string;
}> {
  const store = getPaymentStore();
  const sub = store.getSubscription(id);
  if (!sub) throw new Error(`Subscription ${id} not found`);
  if (sub.merchantId !== merchantId)
    throw new Error("Subscription belongs to another merchant");

  const now = new Date();
  if (sub.status !== "active" && sub.status !== "past_due") {
    throw new SubscriptionTransitionError(
      `Subscription ${id} cannot be charged from ${sub.status}`,
    );
  }
  if (
    (sub.maxCharges !== null &&
      sub.maxCharges !== undefined &&
      sub.chargesUsed >= sub.maxCharges) ||
    (sub.expiresAt && now.getTime() >= new Date(sub.expiresAt).getTime())
  ) {
    sub.status = "ended";
    sub.updatedAt = now.toISOString();
    store.saveSubscription(sub);
    throw new SubscriptionTransitionError(`Subscription ${id} has ended`);
  }

  if (sub.pendingPaymentPayload) {
    try {
      const current = JSON.parse(sub.pendingPaymentPayload);
      if (
        current.expiresAt &&
        new Date(current.expiresAt).getTime() > now.getTime()
      ) {
        return {
          ...current,
          subscription: sub,
          message: "A pending payer-approved charge already exists.",
        };
      }
    } catch {}
    sub.pendingPaymentPayload = undefined;
    store.saveSubscription(sub);
  }

  const merchant = store.getMerchant(sub.merchantId);
  const payTo = merchant?.payTo[sub.chain];
  if (!payTo)
    throw new Error(
      `Merchant has no payTo address configured for ${sub.chain}`,
    );
  const paymentId = `sub_charge_${sub.id}_${sub.chargesUsed + 1}_${sub.failureCount}`;
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
  const parentPaymentId =
    sub.lastPaymentId ?? sub.latestPaymentId ?? sub.firstPaymentId ?? null;
  const paymentRequirements = {
    scheme: "exact",
    network: sub.chain,
    amount: sub.amount,
    asset: sub.asset,
    payTo,
    maxTimeoutSeconds: 300,
    paymentId,
    merchantId: sub.merchantId,
    subscriptionId: sub.id,
    parentPaymentId,
    extra: {
      subscriptionId: sub.id,
      parentPaymentId,
      renewalNotice: SUBSCRIPTION_RENEWAL_NOTICE,
    },
  };
  const charge = {
    x402Version: 2,
    paymentId,
    paymentRequirements,
    amount: sub.amount,
    asset: sub.asset,
    network: sub.chain,
    payTo,
    expiresAt,
  };

  store.savePayment({
    paymentId,
    network: sub.chain,
    scheme: "exact",
    payer: sub.payer,
    payTo,
    asset: sub.asset,
    amount: sub.amount,
    status: "pending",
    createdAt: now.toISOString(),
    merchantId: sub.merchantId,
    userId: sub.userId,
    subscriptionId: sub.id,
    parentPaymentId: parentPaymentId ?? undefined,
  });
  const claimed = store.setSubscriptionPendingCharge(
    sub.id,
    JSON.stringify(charge),
    now.toISOString(),
  );
  const currentSub = store.getSubscription(sub.id)!;
  if (!claimed && currentSub.pendingPaymentPayload) {
    const current = JSON.parse(currentSub.pendingPaymentPayload);
    return {
      ...current,
      subscription: currentSub,
      message: "A pending payer-approved charge already exists.",
    };
  }

  return {
    ...charge,
    subscription: store.getSubscription(sub.id)!,
    message:
      "Fresh x402 payment requirements created. Awaiting payer approval; no charge was settled.",
  };
}

/**
 * Scheduler worker: runs once an hour (not a route).
 * Finds subscriptions due (nextChargeAt <= now), creates fresh 402 requirements for one tap approval.
 * Idempotent: A due subscription charges once, never twice, even if the worker runs twice.
 * An unsettled charge becomes past_due after 24 hours, retries once daily for 3 days, then cancels.
 */
export async function runSubscriptionScheduler(now = new Date()): Promise<{
  processed: number;
  promptsCreated: number;
  pastDue: number;
  cancelled: number;
}> {
  const store = getPaymentStore();
  const nowIso = now.toISOString();
  const dueSubscriptions = store.getDueSubscriptions(nowIso);

  let processed = 0;
  let promptsCreated = 0;
  let pastDue = 0;
  let cancelled = 0;

  for (const sub of dueSubscriptions) {
    processed++;

    if (
      (sub.maxCharges !== null &&
        sub.maxCharges !== undefined &&
        sub.chargesUsed >= sub.maxCharges) ||
      (sub.expiresAt && now.getTime() >= new Date(sub.expiresAt).getTime())
    ) {
      sub.status = "ended";
      sub.updatedAt = nowIso;
      sub.pendingPaymentPayload = undefined;
      store.saveSubscription(sub);
      continue;
    }

    if (sub.status === "paused") continue;

    if (sub.pendingPaymentPayload && sub.lastAttemptAt) {
      const hoursSinceLastAttempt =
        (now.getTime() - new Date(sub.lastAttemptAt).getTime()) / 3600000;
      if (hoursSinceLastAttempt < 24) continue;
      sub.lastAttemptAt = nowIso;
      sub.updatedAt = nowIso;

      if (sub.failureCount >= 3) {
        sub.status = "cancelled";
        sub.cancelledAt = nowIso;
        sub.pendingPaymentPayload = undefined;
        cancelled++;
        store.saveSubscription(sub);

        sendMerchantWebhook(sub.merchantId, "subscription.cancelled", {
          subscriptionId: sub.id,
          payer: sub.payer,
          reason: "Three daily renewal retries remained unsettled",
          cancelledAt: nowIso,
        }).catch(() => {});
      } else {
        sub.failureCount += 1;
        sub.status = "past_due";
        sub.pendingPaymentPayload = undefined;
        pastDue++;
        store.saveSubscription(sub);

        sendMerchantWebhook(sub.merchantId, "subscription.past_due", {
          subscriptionId: sub.id,
          payer: sub.payer,
          failureCount: sub.failureCount,
          lastAttemptAt: nowIso,
        }).catch(() => {});
        const prompt = await chargeSubscriptionNow(sub.id, sub.merchantId);
        if (prompt.message.startsWith("Fresh x402")) promptsCreated++;
      }

      continue;
    }

    const prompt = await chargeSubscriptionNow(sub.id, sub.merchantId);
    if (prompt.message.startsWith("Fresh x402")) promptsCreated++;
  }

  return { processed, promptsCreated, pastDue, cancelled };
}

let schedulerTimer: NodeJS.Timeout | null = null;

/**
 * Starts the standing background subscription scheduler worker running once an hour.
 */
export function startSubscriptionSchedulerWorker(
  intervalMs = 60 * 60 * 1000,
): void {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    runSubscriptionScheduler().catch((err) => {
      console.error("[Subscription Scheduler Worker] Error:", err);
    });
  }, intervalMs);
  schedulerTimer.unref();
}

/**
 * Stops the subscription scheduler worker.
 */
export function stopSubscriptionSchedulerWorker(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}
