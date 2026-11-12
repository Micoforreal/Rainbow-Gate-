import crypto from "crypto";
import { getPaymentStore } from "./payments";

export type WebhookEventType =
  | "payment.failed"
  | "payment.refunded"
  | "payment.succeeded"
  | "subscription.past_due"
  | "subscription.cancelled"
  | "subscription.created"
  | "subscription.charge_succeeded";

export interface WebhookPayload {
  event: WebhookEventType;
  createdAt: string;
  merchantId: string;
  data: any;
}

export interface SendWebhookOptions {
  maxRetries?: number;
  initialBackoffMs?: number;
  timeoutMs?: number;
}

/**
 * Creates HMAC-SHA256 signature for webhook payload.
 * Signature format: t=<timestamp>,v1=<hexDigest>
 */
export function signWebhookPayload(
  secret: string,
  timestamp: string,
  bodyJson: string,
): string {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(`${timestamp}.${bodyJson}`);
  return `t=${timestamp},v1=${hmac.digest("hex")}`;
}

/**
 * Sends a signed JSON webhook to the merchant's configured webhookUrl with retry and backoff.
 * Retries up to 3 times on failure.
 */
export async function sendMerchantWebhook(
  merchantId: string,
  event: WebhookEventType,
  data: any,
  options?: SendWebhookOptions,
): Promise<{ delivered: boolean; attempts: number; error?: string }> {
  const store = getPaymentStore();
  const merchant = store.getMerchant(merchantId);

  if (!merchant || !merchant.webhookUrl) {
    return {
      delivered: false,
      attempts: 0,
      error: "Merchant has no configured webhookUrl",
    };
  }

  const signingSecret = store.getWebhookSigningSecret(merchantId);
  if (!signingSecret) {
    return {
      delivered: false,
      attempts: 0,
      error: "Merchant has no active API key for webhook signing",
    };
  }

  const webhookUrl = merchant.webhookUrl;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const createdAt = new Date(Number(timestamp) * 1000).toISOString();

  const payload: WebhookPayload = {
    event,
    createdAt,
    merchantId,
    data,
  };

  const bodyJson = JSON.stringify(payload);
  const signature = signWebhookPayload(signingSecret, timestamp, bodyJson);

  const maxRetries = options?.maxRetries ?? 3;
  let backoffMs = options?.initialBackoffMs ?? 200;
  const timeoutMs = options?.timeoutMs ?? 5000;

  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "RainbowGate-Webhooks/1.0",
          "X-RainbowGate-Signature": signature,
          "X-RainbowGate-Event": event,
        },
        body: bodyJson,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (response.ok) {
        return { delivered: true, attempts: attempt };
      }

      lastError = `HTTP ${response.status}: ${response.statusText}`;
    } catch (err: any) {
      lastError = err.message ?? String(err);
    }

    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      backoffMs *= 2;
    }
  }

  return { delivered: false, attempts: maxRetries, error: lastError };
}
