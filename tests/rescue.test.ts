import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";
import type { Server } from "http";
import { createServer } from "../src/server";
import { FacilitatorRouter } from "../src/router";
import { getPaymentStore, PaymentStore } from "../src/lib/payments";
import { OneClickHandler } from "../src/handlers/oneclick";
import { poll1ClickRefund, classifyFailure } from "../src/lib/rescue";
import type { NetworkHandler } from "../src/types/driver.types";

describe("Failed Payment Rescue, Retry & Refund", () => {
  let server: Server;
  let baseUrl: string;
  let store: PaymentStore;
  let router: FacilitatorRouter;
  let oneClickHandler: OneClickHandler;
  let tempDbPath: string;
  const merchantId = "merchant_rescue_test";
  const apiKey = "test_api_key_rescue_456";

  beforeAll(async () => {
    tempDbPath = path.join(
      os.tmpdir(),
      `orangegate-rescue-test-${process.pid}-${Date.now()}.db`,
    );
    process.env.DATABASE_PATH = tempDbPath;
    store = getPaymentStore(tempDbPath);

    store.setMerchant({
      merchantId,
      settlementChain: "solana",
      settlementAsset: "USDC",
      payTo: {
        "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "merchant_sol_ata_rescue",
        "intents:near": "merchant.near",
      },
      creditBalance: "0", // Zero credit balance to prove merchant is never credited on refund
      dailyGasBudget: "100000000",
      apiKey,
      webhookUrl: "https://webhook.site/rescue-test",
    });

    router = new FacilitatorRouter({ isTestnet: true });
    oneClickHandler = new OneClickHandler(undefined, undefined, true); // mockMode = true

    router.registerHandler("oneclick", oneClickHandler);

    const mockSolHandler: NetworkHandler = {
      networkId: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      scheme: "exact",
      supportsNetwork: (n) => n.startsWith("solana:"),
      verify: async () => ({ isValid: true, payer: "payer_wallet_123" }),
      settle: async () => ({
        success: true,
        transaction: "sol_tx_hash_12345",
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        payer: "payer_wallet_123",
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

  it("classifies failures accurately into the 3 explicit kinds", () => {
    expect(classifyFailure("EXPIRED_BLOCKHASH").failureKind).toBe(
      "BEFORE_MONEY_MOVED",
    );
    expect(classifyFailure("EXPIRED_DELEGATE").failureKind).toBe(
      "BEFORE_MONEY_MOVED",
    );
    expect(classifyFailure("WRONG_AMOUNT").failureKind).toBe(
      "BEFORE_MONEY_MOVED",
    );
    expect(classifyFailure("INSUFFICIENT_BALANCE").failureKind).toBe(
      "BEFORE_MONEY_MOVED",
    );

    expect(classifyFailure("UNDERPAID_DEPOSIT").failureKind).toBe(
      "AFTER_1CLICK_DEPOSIT",
    );
    expect(classifyFailure("INCOMPLETE_DEPOSIT").failureKind).toBe(
      "AFTER_1CLICK_DEPOSIT",
    );
    expect(classifyFailure("SOLVER_FAILED").failureKind).toBe(
      "AFTER_1CLICK_DEPOSIT",
    );

    expect(classifyFailure("RESOURCE_NOT_DELIVERED").failureKind).toBe(
      "SETTLED_RESOURCE_NOT_DELIVERED",
    );
  });

  it("an underpaid 1Click deposit goes to refund, not to merchant credit", async () => {
    const paymentId = "pay_1click_underpaid_001";
    const depositAddress = "1click_mock_deposit_underpaid_test";

    store.savePayment({
      paymentId,
      network: "intents:near",
      scheme: "exact",
      payer: "user_refund_destination",
      payTo: "merchant.near",
      asset: "sol:SOL",
      amount: "1000000",
      status: "INCOMPLETE_DEPOSIT",
      quoteId: "quote_orig_123",
      depositAddress,
      refundTo: "user_refund_destination",
      createdAt: new Date().toISOString(),
      merchantId,
    });

    const merchantBefore = store.getMerchant(merchantId);
    const creditBefore = merchantBefore?.creditBalance;

    // Execute refund polling
    const refundRecord = await poll1ClickRefund(paymentId, oneClickHandler);

    expect(refundRecord.status).toBe("REFUNDED");
    expect(refundRecord.failureKind).toBe("AFTER_1CLICK_DEPOSIT");
    expect(refundRecord.refundTxHash).toBeDefined();
    expect(refundRecord.refundAmount).toBe("1000000");

    // Verify merchant was NEVER credited
    const merchantAfter = store.getMerchant(merchantId);
    expect(merchantAfter?.creditBalance).toBe(creditBefore);

    // Verify event timeline recorded the transition
    const events = store.getPaymentEvents(paymentId);
    const lastEvent = events[events.length - 1];
    expect(lastEvent.newStatus).toBe("REFUNDED");
  });

  it("keeps an unrefunded 1Click failure in the FAILED payment status", async () => {
    const paymentId = "pay_1click_refund_pending_001";
    store.savePayment({
      paymentId,
      network: "intents:near",
      scheme: "exact",
      payer: "user_refund_destination",
      payTo: "merchant.near",
      asset: "sol:SOL",
      amount: "1000000",
      status: "PENDING_DEPOSIT",
      quoteId: "quote_pending_refund_123",
      depositAddress: "1click_mock_deposit_pending_refund",
      refundTo: "user_refund_destination",
      createdAt: new Date().toISOString(),
      merchantId,
    });

    const payment = await poll1ClickRefund(paymentId, oneClickHandler, 0);

    expect(payment.status).toBe("FAILED");
    expect(payment.failureKind).toBe("AFTER_1CLICK_DEPOSIT");
  });

  it("a retry uses a fresh quote and never reuses the old deposit address", async () => {
    const parentPaymentId = "pay_failed_parent_002";
    const oldDepositAddress = "1click_mock_deposit_old_address_999";

    store.savePayment({
      paymentId: parentPaymentId,
      network: "intents:near",
      scheme: "exact",
      payer: "user_sol_address",
      payTo: "merchant.near",
      asset: "sol:SOL",
      amount: "5000000",
      status: "FAILED",
      failureReason: "EXPIRED_BLOCKHASH",
      failureKind: "BEFORE_MONEY_MOVED",
      quoteId: "quote_old_111",
      depositAddress: oldDepositAddress,
      refundTo: "user_sol_address",
      createdAt: new Date().toISOString(),
      merchantId,
      attemptNumber: 1,
    });

    const retryRes = await fetch(`${baseUrl}/rescue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({ paymentId: parentPaymentId, action: "retry" }),
    });
    const retryBody = await retryRes.json();

    expect(retryRes.status).toBe(200);
    expect(retryBody.payment).toBeDefined();

    const retryPayment = retryBody.payment;
    expect(retryPayment.paymentId).not.toBe(parentPaymentId);
    expect(retryPayment.parentPaymentId).toBe(parentPaymentId);
    expect(retryPayment.attemptNumber).toBe(2);

    // CRITICAL: Must never reuse the old deposit address
    expect(retryPayment.depositAddress).toBeDefined();
    expect(retryPayment.depositAddress).not.toBe(oldDepositAddress);

    // Verify retry stored in DB
    const savedRetry = store.getPayment(retryPayment.paymentId);
    expect(savedRetry).not.toBeNull();
    expect(savedRetry?.parentPaymentId).toBe(parentPaymentId);
    expect(savedRetry?.attemptNumber).toBe(2);
    expect(savedRetry?.depositAddress).not.toBe(oldDepositAddress);
  });

  it("POST /rescue preserves authentication, ownership, not-found, and transition responses", async () => {
    const paymentId = "pay_rescue_status_codes";
    store.savePayment({
      paymentId,
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      scheme: "exact",
      payer: "payer_wallet_123",
      payTo: "merchant_sol_ata_rescue",
      asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      amount: "1000",
      status: "FAILED",
      failureKind: "AFTER_1CLICK_DEPOSIT",
      createdAt: new Date().toISOString(),
      merchantId,
    });

    const missingKey = await fetch(`${baseUrl}/rescue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentId, action: "retry" }),
    });
    expect(missingKey.status).toBe(401);

    const missingPayment = await fetch(`${baseUrl}/rescue`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({
        paymentId: "unknown-rescue-payment",
        action: "retry",
      }),
    });
    expect(missingPayment.status).toBe(404);

    store.setMerchant({
      merchantId: "other_rescue_merchant",
      settlementChain: "solana",
      settlementAsset: "USDC",
      payTo: {
        "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "other_rescue_payto",
      },
      creditBalance: "0",
      dailyGasBudget: "0",
      apiKey: "other_rescue_api_key",
    });
    const forbidden = await fetch(`${baseUrl}/rescue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "other_rescue_api_key",
      },
      body: JSON.stringify({ paymentId, action: "retry" }),
    });
    expect(forbidden.status).toBe(403);

    const invalidTransition = await fetch(`${baseUrl}/rescue`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ paymentId, action: "retry" }),
    });
    expect(invalidTransition.status).toBe(409);

    const invalidRefund = await fetch(`${baseUrl}/rescue`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ paymentId, action: "refund" }),
    });
    expect(invalidRefund.status).toBe(409);
  });

  it("POST /rescue refund is merchant only, idempotent, and permanently marks REFUNDED", async () => {
    const paymentId = "pay_to_refund_settled_003";
    store.savePayment({
      paymentId,
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      scheme: "exact",
      payer: "payer_sol_wallet_456",
      payTo: "merchant_sol_ata_rescue",
      asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      amount: "2000000",
      status: "settled",
      failureKind: "SETTLED_RESOURCE_NOT_DELIVERED",
      txHash: "original_settle_tx_hash_333",
      createdAt: new Date().toISOString(),
      settledAt: new Date().toISOString(),
      merchantId,
    });

    // First refund call
    const refundRes1 = await fetch(`${baseUrl}/rescue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({
        paymentId,
        action: "refund",
        reason: "Resource not delivered",
      }),
    });
    const refundBody1 = await refundRes1.json();

    expect(refundRes1.status).toBe(200);
    expect(refundBody1.success).toBe(true);
    expect(refundBody1.status).toBe("REFUNDED");
    expect(refundBody1.refundTxHash).toBeDefined();
    expect(refundBody1.idempotent).toBe(false);

    const firstTxHash = refundBody1.refundTxHash;

    // Second refund call (idempotent test)
    const refundRes2 = await fetch(`${baseUrl}/rescue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({
        paymentId,
        action: "refund",
        reason: "Duplicate refund request",
      }),
    });
    const refundBody2 = await refundRes2.json();

    expect(refundRes2.status).toBe(200);
    expect(refundBody2.success).toBe(true);
    expect(refundBody2.status).toBe("REFUNDED");
    expect(refundBody2.refundTxHash).toBe(firstTxHash); // Identical refund tx hash returned
    expect(refundBody2.idempotent).toBe(true);

    // Verify a refunded payment can NEVER be settled again
    const settleAttempt = await router.settle(
      { transaction: "mock_tx", paymentId },
      {
        scheme: "exact",
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        amount: "2000000",
        payTo: "merchant_sol_ata_rescue",
        paymentId,
      },
    );

    expect(settleAttempt.success).toBe(false);
    expect(settleAttempt.errorReason).toContain("refunded");
  });

  it("double /settle with the same paymentId returns stored result without second payment", async () => {
    const paymentId = "pay_double_settle_guard_004";
    const requirements = {
      scheme: "exact",
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      amount: "1000000",
      asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      payTo: "merchant_sol_ata_rescue",
      paymentId,
      merchantId,
    };

    const firstSettle = await router.settle(
      { transaction: "tx1" },
      requirements,
    );
    expect(firstSettle.success).toBe(true);
    const tx = firstSettle.transaction;

    // Second settle with identical paymentId
    const secondSettle = await router.settle(
      { transaction: "tx2_duplicate" },
      requirements,
    );
    expect(secondSettle.success).toBe(true);
    expect(secondSettle.transaction).toBe(tx); // Stored result returned
  });
});
