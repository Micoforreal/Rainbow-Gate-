import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";
import type { Server } from "http";
import { createServer } from "../src/server";
import { FacilitatorRouter } from "../src/router";
import { getPaymentStore, PaymentStore } from "../src/lib/payments";
import {
  runSubscriptionScheduler,
  INTERVAL_MS,
} from "../src/lib/subscriptions";
import type { NetworkHandler } from "../src/types/driver.types";

describe("Subscriptions (Prepaid + Assisted Renewal)", () => {
  let server: Server;
  let baseUrl: string;
  let store: PaymentStore;
  let router: FacilitatorRouter;
  let tempDbPath: string;
  let userId: string;
  const merchantId = "merchant_sub_test";
  const apiKey = "test_api_key_sub_789";
  const payerWallet = "payer_wallet_address_xyz";

  beforeAll(async () => {
    tempDbPath = path.join(
      os.tmpdir(),
      `orangegate-subs-test-${process.pid}-${Date.now()}.db`,
    );
    process.env.DATABASE_PATH = tempDbPath;
    store = getPaymentStore(tempDbPath);

    store.setMerchant({
      merchantId,
      settlementChain: "solana",
      settlementAsset: "USDC",
      payTo: {
        "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "merchant_sol_ata_subs",
      },
      creditBalance: "10000000",
      dailyGasBudget: "100000000",
      apiKey,
    });
    (store as any).db
      .prepare("UPDATE merchants SET accepts = ? WHERE merchantId = ?")
      .run(
        JSON.stringify([
          {
            chain: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
            asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
            payTo: "merchant_sol_ata_subs",
          },
        ]),
        merchantId,
      );
    userId = store.createUserForWallet(
      "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      payerWallet,
    ).id;

    router = new FacilitatorRouter({ isTestnet: true });
    const mockSolHandler: NetworkHandler = {
      networkId: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      scheme: "exact",
      supportsNetwork: (n) => n.startsWith("solana:"),
      verify: async (payload) => ({
        isValid: true,
        payer: payload.signer ?? payerWallet,
      }),
      settle: async (payload) => ({
        success: true,
        transaction: "sub_tx_hash_" + Date.now(),
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        payer: payload.signer ?? payerWallet,
      }),
    };
    router.registerHandler("solana", mockSolHandler);

    const app = createServer(router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    try {
      if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
      const wal = tempDbPath + "-wal";
      if (fs.existsSync(wal)) fs.unlinkSync(wal);
      const shm = tempDbPath + "-shm";
      if (fs.existsSync(shm)) fs.unlinkSync(shm);
    } catch {}
  });

  function saveFirstPayment(paymentId: string, amount = "1000000") {
    const now = new Date().toISOString();
    store.savePayment({
      paymentId,
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      scheme: "exact",
      payer: payerWallet,
      payTo: "merchant_sol_ata_subs",
      asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      amount,
      status: "settled",
      txHash: `first_tx_${paymentId}`,
      createdAt: now,
      settledAt: now,
      merchantId,
      userId,
    });
  }

  it("rejects subscription creation with email instead of wallet address", async () => {
    const res = await fetch(`${baseUrl}/subscriptions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({
        payer: "user@example.com", // Invalid: email
        chain: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        amount: "1000000",
        interval: "monthly",
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe("INVALID_PAYER");
    expect(body.error).toContain("wallet address");
  });

  it("rejects a body merchantId that differs from the X-API-Key merchant", async () => {
    const response = await fetch(`${baseUrl}/subscriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ merchantId: "some-other-merchant" }),
    });
    const body = await response.json();
    expect(response.status).toBe(403);
    expect(body.code).toBe("FORBIDDEN");
  });

  it("creates subscription with valid first payment signed by connected wallet", async () => {
    saveFirstPayment("first_sub_pay_001");

    const res = await fetch(`${baseUrl}/subscriptions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({
        userId,
        payer: payerWallet,
        chain: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        amount: "1000000",
        interval: "monthly",
        firstPaymentId: "first_sub_pay_001",
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.subscription).toBeDefined();
    expect(body.subscription.payer).toBe(payerWallet);
    expect(body.subscription.status).toBe("ACTIVE");
    expect(body.subscription.chargesUsed).toBe(1);
    expect(body.model).toBe("prepaid_assisted_renewal");
    expect(body.renewalNotice).toContain("No auto-renew");
  });

  it("rejects a first payment whose amount differs from the subscription amount", async () => {
    saveFirstPayment("wrong_amount_first_payment", "999999");
    const response = await fetch(`${baseUrl}/subscriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({
        userId,
        payer: payerWallet,
        chain: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        amount: "1000000",
        interval: "monthly",
        firstPaymentId: "wrong_amount_first_payment",
      }),
    });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.code).toBe("INVALID_FIRST_PAYMENT");
  });

  it("rejects a chain and asset pair the merchant does not accept", async () => {
    saveFirstPayment("unsupported_acceptance_payment");
    const response = await fetch(`${baseUrl}/subscriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({
        userId,
        payer: payerWallet,
        chain: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        asset: "not-the-accepted-asset",
        amount: "1000000",
        interval: "monthly",
        firstPaymentId: "unsupported_acceptance_payment",
      }),
    });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.code).toBe("UNSUPPORTED_ASSET");
  });

  it("early renewal stacks time onto remaining period instead of resetting it", async () => {
    saveFirstPayment("early_renew_pay_base");
    // Create base subscription
    const createRes = await fetch(`${baseUrl}/subscriptions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({
        userId,
        payer: payerWallet,
        chain: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        amount: "1000000",
        interval: "weekly",
        firstPaymentId: "early_renew_pay_base",
      }),
    });
    const createBody = await createRes.json();

    const subId = createBody.subscription.id;
    const initialNextCharge = new Date(
      createBody.subscription.nextChargeAt,
    ).getTime();

    // Early renewal immediately after creation
    const renewRes = await fetch(
      `${baseUrl}/subscriptions/${subId}/charge-now`,
      {
        method: "POST",
        headers: {
          "X-API-Key": apiKey,
        },
      },
    );
    const renewBody = await renewRes.json();

    expect(renewRes.status).toBe(200);
    expect(renewBody.paymentRequirements.paymentId).toBe(renewBody.paymentId);
    expect(renewBody.paymentRequirements.subscriptionId).toBe(subId);
    expect(renewBody.paymentRequirements.parentPaymentId).toBe(
      "early_renew_pay_base",
    );
    expect(renewBody.paymentRequirements.amount).toBe("1000000");
    expect(renewBody.paymentRequirements.asset).toBe(
      "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    );
    expect(renewBody.paymentRequirements.network).toBe(
      "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    );
    expect(renewBody.paymentRequirements.payTo).toBe("merchant_sol_ata_subs");
    expect(renewBody.expiresAt).toBeTruthy();
    expect(renewBody.subscription.chargesUsed).toBe(1);

    const settleRes = await fetch(`${baseUrl}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentPayload: { transaction: "tx_renew", signer: payerWallet },
        paymentRequirements: renewBody.paymentRequirements,
      }),
    });
    expect(settleRes.status).toBe(200);
    const settleBody = await settleRes.json();
    expect(settleBody.transaction).toMatch(/^sub_tx_hash_/);
    const renewalPayment = store.getPayment(renewBody.paymentId)!;
    expect(renewalPayment.status).toBe("settled");
    expect(renewalPayment.txHash).toBe(settleBody.transaction);
    const settledSubscription = store.getSubscription(subId)!;
    const newNextCharge = new Date(settledSubscription.nextChargeAt).getTime();
    const expectedNextCharge = initialNextCharge + INTERVAL_MS.weekly;

    expect(Math.abs(newNextCharge - expectedNextCharge)).toBeLessThan(1000);
    expect(settledSubscription.chargesUsed).toBe(2);
  });

  it("a cancelled subscription never charges again", async () => {
    saveFirstPayment("cancel_test_pay_001");
    // 1. Create subscription
    const createRes = await fetch(`${baseUrl}/subscriptions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({
        userId,
        payer: payerWallet,
        chain: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        amount: "1000000",
        interval: "weekly",
        firstPaymentId: "cancel_test_pay_001",
      }),
    });
    const createBody = await createRes.json();
    const subId = createBody.subscription.id;

    // 2. Cancel subscription instantly
    const cancelRes = await fetch(`${baseUrl}/subscriptions/${subId}/cancel`, {
      method: "POST",
      headers: { "X-API-Key": apiKey },
    });
    const cancelBody = await cancelRes.json();

    expect(cancelRes.status).toBe(200);
    expect(cancelBody.subscription.status).toBe("CANCELLED");

    // 3. Attempt manual charge-now on cancelled subscription -> MUST FAIL
    const chargeRes = await fetch(
      `${baseUrl}/subscriptions/${subId}/charge-now`,
      {
        method: "POST",
        headers: { "X-API-Key": apiKey },
      },
    );
    const chargeBody = await chargeRes.json();

    expect(chargeRes.status).toBe(409);
    expect(chargeBody.code).toBe("INVALID_TRANSITION");
    expect(chargeBody.message).toContain("cancelled");

    // 4. Run scheduler worker when expiry is in the past -> MUST SKIP cancelled subscription
    const subInDb = store.getSubscription(subId)!;
    subInDb.nextChargeAt = new Date(Date.now() - 3600000).toISOString(); // 1h in past
    store.saveSubscription(subInDb);

    await runSubscriptionScheduler(new Date());
    const refreshed = store.getSubscription(subId);
    expect(refreshed?.status).toBe("cancelled");
    expect(refreshed?.pendingPaymentPayload).toBeUndefined(); // Never charged
  });

  it("a due subscription charges once when the worker runs twice", async () => {
    const subId = "sub_worker_idempotency_test";
    const pastDueTime = new Date(Date.now() - 10000).toISOString();

    store.saveSubscription({
      id: subId,
      merchantId,
      payer: payerWallet,
      chain: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      amount: "1000000",
      interval: "weekly",
      nextChargeAt: pastDueTime,
      expiresAt: null,
      maxCharges: null,
      chargesUsed: 1,
      status: "active",
      createdAt: new Date(Date.now() - 7 * 86400000).toISOString(),
      updatedAt: new Date().toISOString(),
      failureCount: 0,
    });

    // Worker Run 1: Should find due subscription and create fresh 402 requirements
    const run1 = await runSubscriptionScheduler(new Date());
    expect(run1.processed).toBeGreaterThanOrEqual(1);
    expect(run1.promptsCreated).toBe(1);

    const subAfterRun1 = store.getSubscription(subId)!;
    expect(subAfterRun1.pendingPaymentPayload).toBeDefined();
    const prompt1 = JSON.parse(subAfterRun1.pendingPaymentPayload!);
    expect(prompt1.paymentId).toBeDefined();

    // Worker Run 2 immediately after: Must be strictly IDEMPOTENT (charges once, never twice)
    const run2 = await runSubscriptionScheduler(new Date());
    const subAfterRun2 = store.getSubscription(subId)!;
    const prompt2 = JSON.parse(subAfterRun2.pendingPaymentPayload!);

    // Identical prompt preserved — no duplicate charge or prompt generated
    expect(prompt2.paymentId).toBe(prompt1.paymentId);
    expect(run2.promptsCreated).toBe(0);
    expect(subAfterRun2.chargesUsed).toBe(1); // chargesUsed only increments on settled payment
  });

  it("marks an unsettled prompt past due after 24 hours, retries daily three times, then cancels", async () => {
    const id = "sub_daily_retry_schedule";
    const now = Date.now();
    const startedAt = new Date(now - 8 * 86400000).toISOString();
    store.saveSubscription({
      id,
      userId,
      merchantId,
      payer: payerWallet,
      chain: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      amount: "1000000",
      interval: "weekly",
      nextChargeAt: new Date(now - 7 * 86400000).toISOString(),
      expiresAt: null,
      maxCharges: null,
      chargesUsed: 1,
      status: "active",
      createdAt: startedAt,
      updatedAt: startedAt,
      failureCount: 0,
      lastAttemptAt: new Date(now - 24 * 3600000).toISOString(),
      pendingPaymentPayload: JSON.stringify({
        paymentId: "expired-initial-prompt",
      }),
    });

    await runSubscriptionScheduler(new Date(now));
    let subscription = store.getSubscription(id)!;
    expect(subscription.status).toBe("past_due");
    expect(subscription.failureCount).toBe(1);
    expect(subscription.pendingPaymentPayload).toBeDefined();

    for (let retry = 2; retry <= 3; retry++) {
      const nextAttempt =
        new Date(subscription.lastAttemptAt!).getTime() + 24 * 3600000;
      await runSubscriptionScheduler(new Date(nextAttempt));
      subscription = store.getSubscription(id)!;
      expect(subscription.status).toBe("past_due");
      expect(subscription.failureCount).toBe(retry);
      expect(subscription.pendingPaymentPayload).toBeDefined();
    }

    const cancelAt =
      new Date(subscription.lastAttemptAt!).getTime() + 24 * 3600000;
    await runSubscriptionScheduler(new Date(cancelAt));
    subscription = store.getSubscription(id)!;
    expect(subscription.status).toBe("cancelled");
    expect(subscription.failureCount).toBe(3);
    expect(subscription.pendingPaymentPayload).toBeUndefined();
  });

  it("resumes PAUSED subscriptions and rejects resume from CANCELLED with 409", async () => {
    saveFirstPayment("resume_first_payment");
    const createRes = await fetch(`${baseUrl}/subscriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({
        userId,
        payer: payerWallet,
        chain: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        amount: "1000000",
        interval: "weekly",
        firstPaymentId: "resume_first_payment",
      }),
    });
    const created = await createRes.json();
    const id = created.subscription.id as string;
    const originalNextChargeAt = created.subscription.nextChargeAt;

    await fetch(`${baseUrl}/subscriptions/${id}/pause`, {
      method: "POST",
      headers: { "X-API-Key": apiKey },
    });
    const resumedResponse = await fetch(
      `${baseUrl}/subscriptions/${id}/resume`,
      {
        method: "POST",
        headers: { "X-API-Key": apiKey },
      },
    );
    const resumed = await resumedResponse.json();
    expect(resumedResponse.status).toBe(200);
    expect(resumed.subscription.status).toBe("ACTIVE");
    expect(resumed.subscription.nextChargeAt).toBe(originalNextChargeAt);

    await fetch(`${baseUrl}/subscriptions/${id}/cancel`, {
      method: "POST",
      headers: { "X-API-Key": apiKey },
    });
    const rejected = await fetch(`${baseUrl}/subscriptions/${id}/resume`, {
      method: "POST",
      headers: { "X-API-Key": apiKey },
    });
    expect(rejected.status).toBe(409);
  });

  it("ends a due subscription when chargesUsed reaches maxCharges", async () => {
    const id = "sub_max_charge_limit";
    const now = new Date().toISOString();
    store.saveSubscription({
      id,
      userId,
      merchantId,
      payer: payerWallet,
      chain: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      amount: "1000000",
      interval: "weekly",
      nextChargeAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: null,
      maxCharges: 2,
      chargesUsed: 2,
      status: "active",
      createdAt: now,
      updatedAt: now,
      failureCount: 0,
    });
    await runSubscriptionScheduler(new Date());
    expect(store.getSubscription(id)?.status).toBe("ended");
    expect(store.getSubscription(id)?.pendingPaymentPayload).toBeUndefined();
  });

  it("ends an expired paused subscription without creating a renewal prompt", async () => {
    const id = "sub_expired_paused";
    const now = new Date().toISOString();
    store.saveSubscription({
      id,
      userId,
      merchantId,
      payer: payerWallet,
      chain: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      amount: "1000000",
      interval: "weekly",
      nextChargeAt: new Date(Date.now() - 86400000).toISOString(),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      maxCharges: null,
      chargesUsed: 1,
      status: "paused",
      createdAt: now,
      updatedAt: now,
      failureCount: 0,
    });
    await runSubscriptionScheduler(new Date());
    expect(store.getSubscription(id)?.status).toBe("ended");
    expect(store.getSubscription(id)?.pendingPaymentPayload).toBeUndefined();
  });
});
