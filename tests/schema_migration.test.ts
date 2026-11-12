import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { PaymentStore } from "../src/lib/payments";

describe("identity schema migration", () => {
  let tempPath = "";
  let store: PaymentStore | null = null;

  afterEach(() => {
    if (store) (store as any).db.close();
    store = null;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.rmSync(tempPath + suffix, { force: true });
      } catch {}
    }
  });

  it("preserves legacy payment data while moving merchants and subscriptions to FK tables", () => {
    tempPath = path.resolve(
      os.tmpdir(),
      `rainbowgate-migrate-${process.pid}-${Date.now()}.db`,
    );
    const legacy = new Database(tempPath);
    legacy.exec(`
      CREATE TABLE payments (
        paymentId TEXT PRIMARY KEY, network TEXT NOT NULL, scheme TEXT NOT NULL,
        payer TEXT NOT NULL, payTo TEXT NOT NULL, asset TEXT NOT NULL, amount TEXT NOT NULL,
        status TEXT NOT NULL, txHash TEXT, quoteId TEXT, depositAddress TEXT, refundTo TEXT,
        createdAt TEXT NOT NULL, verifiedAt TEXT, settledAt TEXT, invalidReason TEXT,
        merchantId TEXT, feeBreakdown TEXT, failureKind TEXT
      );
      CREATE TABLE merchants (
        merchantId TEXT PRIMARY KEY, settlementChain TEXT NOT NULL, settlementAsset TEXT NOT NULL,
        payToJson TEXT NOT NULL, creditBalance TEXT NOT NULL, dailyGasBudget TEXT NOT NULL,
        apiKey TEXT, webhookUrl TEXT
      );
      CREATE TABLE subscriptions (
        id TEXT PRIMARY KEY, merchantId TEXT NOT NULL, payer TEXT NOT NULL, chain TEXT NOT NULL,
        asset TEXT NOT NULL, amount TEXT NOT NULL, interval TEXT NOT NULL, nextChargeAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL, maxCharges INTEGER, chargesUsed INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        firstPaymentId TEXT, latestPaymentId TEXT, failureCount INTEGER NOT NULL DEFAULT 0,
        lastAttemptAt TEXT, pendingPaymentPayload TEXT
      );
    `);
    const now = "2026-11-12T00:00:00.000Z";
    const key = "legacy-secret-key";
    legacy
      .prepare(`INSERT INTO merchants VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "legacy-merchant",
        "solana",
        "USDC",
        JSON.stringify({ "solana:mainnet": "merchant-wallet" }),
        "123",
        "456",
        key,
        null,
      );
    legacy
      .prepare(
        `INSERT INTO payments (
      paymentId,network,scheme,payer,payTo,asset,amount,status,txHash,createdAt,settledAt,merchantId,feeBreakdown,failureKind
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        "legacy-payment",
        "solana:mainnet",
        "exact",
        "legacy-payer",
        "merchant-wallet",
        "USDC",
        "1234567",
        "settled",
        "legacy-tx-hash",
        now,
        now,
        "legacy-merchant",
        '{"gas":"7"}',
        "BEFORE_MONEY_MOVED",
      );
    legacy
      .prepare(
        `INSERT INTO subscriptions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        "legacy-sub",
        "legacy-merchant",
        "legacy-payer",
        "solana:mainnet",
        "USDC",
        "1234567",
        "weekly",
        now,
        now,
        null,
        1,
        "active",
        now,
        now,
        "legacy-payment",
        "legacy-payment",
        0,
        null,
        null,
      );
    legacy.close();

    store = new PaymentStore(tempPath);
    const payment = store.getPayment("legacy-payment")!;
    expect(payment.amount).toBe("1234567");
    expect(payment.status).toBe("settled");
    expect(payment.txHash).toBe("legacy-tx-hash");
    expect(payment.feeBreakdown).toEqual({ gas: "7" });
    expect(payment.failureKind).toBe("BEFORE_MONEY_MOVED");

    const subscription = store.getSubscription("legacy-sub")!;
    expect(subscription.firstPaymentId).toBe("legacy-payment");
    expect(subscription.lastPaymentId).toBe("legacy-payment");
    expect(subscription.expiresAt).toBeNull();
    expect(subscription.status).toBe("active");

    expect(store.getMerchantByApiKey(key)?.merchantId).toBe("legacy-merchant");
    const keyHash = crypto.createHash("sha256").update(key).digest("hex");
    expect(
      (store as any).db.prepare("SELECT keyHash FROM api_keys").get().keyHash,
    ).toBe(keyHash);
    expect(
      (store as any).db
        .pragma("table_info(merchants)")
        .some((column: any) => column.name === "apiKey"),
    ).toBe(false);
    expect(
      (store as any).db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='payments_legacy_backup'",
        )
        .get(),
    ).toBeTruthy();

    const paymentFks = (store as any).db.pragma("foreign_key_list(payments)");
    const subscriptionFks = (store as any).db.pragma(
      "foreign_key_list(subscriptions)",
    );
    expect(
      paymentFks.some(
        (key: any) => key.from === "merchantId" && key.table === "merchants",
      ),
    ).toBe(true);
    expect(
      paymentFks.some(
        (key: any) =>
          key.from === "subscriptionId" && key.table === "subscriptions",
      ),
    ).toBe(true);
    expect(
      subscriptionFks.some(
        (key: any) => key.from === "userId" && key.table === "users",
      ),
    ).toBe(true);
    expect(
      subscriptionFks.some(
        (key: any) => key.from === "merchantId" && key.table === "merchants",
      ),
    ).toBe(true);
    expect(
      subscriptionFks.some(
        (key: any) => key.from === "firstPaymentId" && key.table === "payments",
      ),
    ).toBe(true);
    expect(
      subscriptionFks.some(
        (key: any) => key.from === "lastPaymentId" && key.table === "payments",
      ),
    ).toBe(true);
    expect(
      paymentFks.some(
        (key: any) =>
          key.from === "parentPaymentId" && key.table === "payments",
      ),
    ).toBe(true);

    const user = store.createUserForWallet("solana:mainnet", "legacy-payer");
    expect(store.getPayment("legacy-payment")?.userId).toBe(user.id);
  });
});
