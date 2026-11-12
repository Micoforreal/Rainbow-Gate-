import Database from "better-sqlite3";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import { activeAssets, config, EXPLORER_URLS, isTestnet } from "../config";
import type {
  PaymentRecord,
  MerchantConfig,
  PaymentEvent,
  FeeBreakdown,
  SubscriptionRecord,
  SubscriptionStatus,
  UserRecord,
  UserWalletRecord,
  MerchantAccept,
  MerchantAccountRecord,
  ApiKeyRecord,
} from "../types/driver.types";

/**
 * Builds explorer URL for transaction based on network and transaction hash.
 * Returns Solscan, NearBlocks, or BaseScan URL.
 */
export function getExplorerUrl(
  network: string,
  txHash?: string | null,
): string | null {
  if (!txHash) return null;
  const hash = txHash.trim();
  if (!hash) return null;

  if (network === activeAssets.base.network) {
    return `${isTestnet ? EXPLORER_URLS.base.testnet : EXPLORER_URLS.base.mainnet}${hash}`;
  }

  // Solana (SVM)
  if (network.startsWith("solana:")) {
    if (network === activeAssets.solana.network && isTestnet) {
      return `${EXPLORER_URLS.solana.testnet}${hash}${EXPLORER_URLS.solana.testnetQuery}`;
    }
    if (network === activeAssets.solana.network)
      return `${EXPLORER_URLS.solana.mainnet}${hash}`;
  }

  // NEAR
  if (network === activeAssets.near.network)
    return `${isTestnet ? EXPLORER_URLS.near.testnet : EXPLORER_URLS.near.mainnet}${hash}`;

  return null;
}

function dbSubscriptionStatus(status: string): string {
  return status.toUpperCase();
}

function internalSubscriptionStatus(status: string): SubscriptionStatus {
  return status.toLowerCase() as SubscriptionStatus;
}

export class PaymentStore {
  private db: Database.Database;

  private encryptApiKey(apiKey: string): string | null {
    const secret = config.API_KEY_ENCRYPTION_KEY;
    if (!secret) return null;
    const key = crypto.createHash("sha256").update(secret).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(apiKey, "utf8"),
      cipher.final(),
    ]);
    return [
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      ciphertext.toString("base64url"),
    ].join(".");
  }

  private decryptApiKey(value: string | null | undefined): string | null {
    const secret = config.API_KEY_ENCRYPTION_KEY;
    if (!secret || !value) return null;
    try {
      const [ivValue, tagValue, ciphertextValue] = value.split(".");
      const key = crypto.createHash("sha256").update(secret).digest();
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(ivValue, "base64url"),
      );
      decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextValue, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      return null;
    }
  }

  constructor(dbPath?: string) {
    // Anchor database path to app directory, avoiding working-directory trap
    const configuredPath = dbPath ?? config.DATABASE_PATH;
    const appRoot = path.resolve(__dirname, "../..");
    const finalPath =
      configuredPath === ":memory:"
        ? configuredPath
        : configuredPath
          ? path.isAbsolute(configuredPath)
            ? configuredPath
            : path.resolve(appRoot, configuredPath)
          : config.DATABASE_PATH;
    const dir = path.dirname(finalPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(finalPath);

    // SQLite Hardening: WAL mode and 5000ms busy timeout
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");

    this.initTables();
  }

  private initTables(): void {
    // 1. Payments table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS payments (
        paymentId TEXT PRIMARY KEY,
        network TEXT NOT NULL,
        scheme TEXT NOT NULL,
        payer TEXT NOT NULL,
        payTo TEXT NOT NULL,
        asset TEXT NOT NULL,
        amount TEXT NOT NULL,
        status TEXT NOT NULL,
        txHash TEXT,
        quoteId TEXT,
        depositAddress TEXT,
        refundTo TEXT,
        createdAt TEXT NOT NULL,
        verifiedAt TEXT,
        settledAt TEXT,
        invalidReason TEXT
      );
    `);

    // Ensure columns exist on pre-existing tables before creating indexes
    const paymentColumns = this.db.pragma("table_info(payments)") as any[];
    const colNames = new Set(paymentColumns.map((c) => c.name));
    const neededPaymentCols: Record<string, string> = {
      merchantId: "TEXT",
      feeBreakdown: "TEXT",
      explorerUrl: "TEXT",
      failureReason: "TEXT",
      failureKind: "TEXT",
      parentPaymentId: "TEXT",
      attemptNumber: "INTEGER DEFAULT 1",
      refundTxHash: "TEXT",
      refundAmount: "TEXT",
      refundAt: "TEXT",
    };
    for (const [col, colType] of Object.entries(neededPaymentCols)) {
      if (!colNames.has(col)) {
        try {
          this.db.exec(`ALTER TABLE payments ADD COLUMN ${col} ${colType};`);
        } catch {}
      }
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
      CREATE INDEX IF NOT EXISTS idx_payments_payer ON payments(payer);
      CREATE INDEX IF NOT EXISTS idx_payments_payTo ON payments(payTo);
      CREATE INDEX IF NOT EXISTS idx_payments_merchantId ON payments(merchantId);
      CREATE INDEX IF NOT EXISTS idx_payments_parent ON payments(parentPaymentId);
    `);

    // 2. Payment Events table (timeline of every status change)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS payment_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        paymentId TEXT NOT NULL,
        oldStatus TEXT,
        newStatus TEXT NOT NULL,
        reason TEXT,
        createdAt TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_payment_events_paymentId ON payment_events(paymentId);
      CREATE INDEX IF NOT EXISTS idx_payment_events_createdAt ON payment_events(createdAt);
    `);

    // 3. TTL caches: seen-nonces, delegate-hashes, blockhashes
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seen_items (
        category TEXT NOT NULL,
        key TEXT NOT NULL,
        expiresAt INTEGER NOT NULL,
        PRIMARY KEY (category, key)
      );

      CREATE INDEX IF NOT EXISTS idx_seen_expires ON seen_items(expiresAt);
    `);

    // 4. Merchant configs
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS merchants (
        merchantId TEXT PRIMARY KEY,
        settlementChain TEXT NOT NULL,
        settlementAsset TEXT NOT NULL,
        payToJson TEXT NOT NULL,
        creditBalance TEXT NOT NULL,
        dailyGasBudget TEXT NOT NULL
      );
    `);

    const merchantColumns = this.db.pragma("table_info(merchants)") as any[];
    const merchantColNames = new Set(merchantColumns.map((c) => c.name));
    if (!merchantColNames.has("apiKey")) {
      try {
        this.db.exec("ALTER TABLE merchants ADD COLUMN apiKey TEXT;");
      } catch {}
    }
    if (!merchantColNames.has("webhookUrl")) {
      try {
        this.db.exec("ALTER TABLE merchants ADD COLUMN webhookUrl TEXT;");
      } catch {}
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_merchants_apiKey ON merchants(apiKey);
    `);

    // 5. Daily gas spend tracking
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_gas_spend (
        keyId TEXT NOT NULL,
        dayDate TEXT NOT NULL,
        spentUnits TEXT NOT NULL,
        PRIMARY KEY (keyId, dayDate)
      );
    `);

    // 6. Subscriptions table (prepaid + assisted renewal only)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        merchantId TEXT NOT NULL,
        payer TEXT NOT NULL,
        chain TEXT NOT NULL,
        asset TEXT NOT NULL,
        amount TEXT NOT NULL,
        interval TEXT NOT NULL,
        nextChargeAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        maxCharges INTEGER,
        chargesUsed INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        firstPaymentId TEXT,
        latestPaymentId TEXT,
        failureCount INTEGER NOT NULL DEFAULT 0,
        lastAttemptAt TEXT,
        pendingPaymentPayload TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_subscriptions_merchantId ON subscriptions(merchantId);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_payer ON subscriptions(payer);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_nextChargeAt ON subscriptions(nextChargeAt);
    `);

    this.initializeIdentitySchema();
  }

  private hasColumn(table: string, column: string): boolean {
    return (this.db.pragma(`table_info(${table})`) as { name: string }[]).some(
      (item) => item.name === column,
    );
  }

  private addColumn(table: string, column: string, definition: string): void {
    if (!this.hasColumn(table, column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private initializeIdentitySchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        primaryWalletAddress TEXT NOT NULL,
        primaryChain TEXT NOT NULL,
        email TEXT,
        displayName TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(primaryChain, primaryWalletAddress)
      );
      CREATE TABLE IF NOT EXISTS user_wallets (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        chain TEXT NOT NULL,
        walletAddress TEXT NOT NULL,
        verifiedAt TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(chain, walletAddress),
        UNIQUE(userId, chain, walletAddress)
      );
      CREATE INDEX IF NOT EXISTS idx_user_wallets_userId ON user_wallets(userId);
      CREATE INDEX IF NOT EXISTS idx_users_primaryWallet ON users(primaryChain, primaryWalletAddress);
    `);

    this.addColumn("merchants", "id", "TEXT");
    this.addColumn(
      "merchants",
      "userId",
      "TEXT REFERENCES users(id) ON DELETE SET NULL",
    );
    this.addColumn("merchants", "name", "TEXT NOT NULL DEFAULT ''");
    this.addColumn("merchants", "email", "TEXT");
    this.addColumn("merchants", "accepts", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumn(
      "merchants",
      "creditBalanceUsdc",
      "TEXT NOT NULL DEFAULT '0'",
    );
    this.addColumn("merchants", "createdAt", "TEXT NOT NULL DEFAULT ''");
    this.addColumn("merchants", "updatedAt", "TEXT NOT NULL DEFAULT ''");
    this.addColumn("merchants", "webhookUrl", "TEXT");

    const now = new Date().toISOString();
    const legacyMerchants = this.db
      .prepare("SELECT * FROM merchants")
      .all() as any[];
    const updateMerchant = this.db.prepare(`
      UPDATE merchants
      SET id = COALESCE(id, merchantId),
          name = CASE WHEN name = '' THEN merchantId ELSE name END,
          accepts = CASE WHEN accepts = '[]' THEN ? ELSE accepts END,
          createdAt = CASE WHEN createdAt = '' THEN ? ELSE createdAt END,
          updatedAt = CASE WHEN updatedAt = '' THEN ? ELSE updatedAt END
      WHERE merchantId = ?
    `);
    for (const merchant of legacyMerchants) {
      let accepts: unknown[] = [];
      try {
        const payTo = JSON.parse(merchant.payToJson || "{}") as Record<
          string,
          string
        >;
        accepts = Object.entries(payTo).map(([chain, address]) => ({
          chain,
          asset: merchant.settlementAsset,
          payTo: address,
        }));
      } catch {}
      updateMerchant.run(
        JSON.stringify(accepts),
        now,
        now,
        merchant.merchantId,
      );
    }
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_merchants_id ON merchants(id)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_merchants_userId ON merchants(userId)",
    );

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        merchantId TEXT NOT NULL REFERENCES merchants(merchantId) ON DELETE CASCADE,
        keyHash TEXT NOT NULL UNIQUE,
        keyCiphertext TEXT,
        keyPrefix TEXT NOT NULL,
        name TEXT NOT NULL,
        lastUsedAt TEXT,
        revokedAt TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_api_keys_merchantId ON api_keys(merchantId);
      CREATE INDEX IF NOT EXISTS idx_api_keys_activeHash ON api_keys(keyHash, revokedAt);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tokenHash TEXT NOT NULL UNIQUE,
        chain TEXT NOT NULL,
        walletAddress TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        revokedAt TEXT,
        FOREIGN KEY(userId, chain, walletAddress)
          REFERENCES user_wallets(userId, chain, walletAddress) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_userId ON sessions(userId);
      CREATE INDEX IF NOT EXISTS idx_sessions_expiresAt ON sessions(expiresAt);
      CREATE TABLE IF NOT EXISTS auth_nonces (
        nonce TEXT PRIMARY KEY,
        chain TEXT NOT NULL,
        walletAddress TEXT NOT NULL,
        message TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        usedAt TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_auth_nonces_expiry ON auth_nonces(expiresAt, usedAt);
    `);
    this.addColumn("api_keys", "keyCiphertext", "TEXT");

    if (this.hasColumn("merchants", "apiKey")) {
      const oldKeys = this.db
        .prepare(
          "SELECT merchantId, apiKey FROM merchants WHERE apiKey IS NOT NULL AND apiKey <> ''",
        )
        .all() as { merchantId: string; apiKey: string }[];
      const insertKey = this.db.prepare(`
        INSERT OR IGNORE INTO api_keys
          (id, merchantId, keyHash, keyCiphertext, keyPrefix, name, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, 'legacy', ?, ?)
      `);
      for (const row of oldKeys) {
        const keyHash = crypto
          .createHash("sha256")
          .update(row.apiKey)
          .digest("hex");
        insertKey.run(
          `legacy_${row.merchantId}`,
          row.merchantId,
          keyHash,
          this.encryptApiKey(row.apiKey),
          row.apiKey.slice(0, 12),
          now,
          now,
        );
      }
      this.db.exec("DROP INDEX IF EXISTS idx_merchants_apiKey");
      this.db.exec("ALTER TABLE merchants DROP COLUMN apiKey");
    }

    this.ensureLegacyMerchantsExist();
    this.migrateSubscriptionAndPaymentTables();

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS subscription_events (
        id TEXT PRIMARY KEY,
        subscriptionId TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
        oldStatus TEXT,
        newStatus TEXT NOT NULL,
        reason TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_subscription_events_subscriptionId ON subscription_events(subscriptionId);
      CREATE INDEX IF NOT EXISTS idx_subscription_events_createdAt ON subscription_events(createdAt);
    `);
  }

  private ensureLegacyMerchantsExist(): void {
    const insertLegacy = this.db.prepare(`
      INSERT OR IGNORE INTO merchants (
        merchantId, id, name, settlementChain, settlementAsset, payToJson,
        creditBalance, dailyGasBudget, accepts, creditBalanceUsdc, createdAt, updatedAt
      ) VALUES (?, ?, ?, 'solana', 'USDC', '{}', '0', '0', '[]', '0', ?, ?)
    `);
    const now = new Date().toISOString();
    const ids = new Set<string>();
    for (const row of this.db
      .prepare("SELECT merchantId FROM payments WHERE merchantId IS NOT NULL")
      .all() as any[]) {
      ids.add(row.merchantId);
    }
    for (const row of this.db
      .prepare(
        "SELECT merchantId FROM subscriptions WHERE merchantId IS NOT NULL",
      )
      .all() as any[]) {
      ids.add(row.merchantId);
    }
    for (const id of ids) {
      insertLegacy.run(id, id, id, now, now);
    }
  }

  private migrateSubscriptionAndPaymentTables(): void {
    const paymentForeignKeys = this.db.pragma("foreign_key_list(payments)") as {
      from: string;
      table: string;
    }[];
    const subscriptionForeignKeys = this.db.pragma(
      "foreign_key_list(subscriptions)",
    ) as { from: string; table: string }[];
    const needsMigration =
      !paymentForeignKeys.some(
        (key) => key.from === "merchantId" && key.table === "merchants",
      ) ||
      !subscriptionForeignKeys.some(
        (key) => key.from === "merchantId" && key.table === "merchants",
      );
    if (!needsMigration) return;

    this.db.pragma("foreign_keys = OFF");
    try {
      const migrate = this.db.transaction(() => {
        for (const index of [
          "idx_payments_status",
          "idx_payments_payer",
          "idx_payments_payTo",
          "idx_payments_merchantId",
          "idx_payments_parent",
          "idx_subscriptions_merchantId",
          "idx_subscriptions_payer",
          "idx_subscriptions_status",
          "idx_subscriptions_nextChargeAt",
        ]) {
          this.db.exec(`DROP INDEX IF EXISTS ${index}`);
        }

        if (
          !this.db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name='payments_legacy_backup'",
            )
            .get()
        ) {
          this.db.exec("ALTER TABLE payments RENAME TO payments_legacy_backup");
        }
        if (
          !this.db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name='subscriptions_legacy_backup'",
            )
            .get()
        ) {
          this.db.exec(
            "ALTER TABLE subscriptions RENAME TO subscriptions_legacy_backup",
          );
        }

        this.db.exec(`
          CREATE TABLE IF NOT EXISTS subscriptions (
            id TEXT PRIMARY KEY,
            userId TEXT REFERENCES users(id) ON DELETE SET NULL,
            merchantId TEXT NOT NULL REFERENCES merchants(merchantId) ON DELETE RESTRICT,
            payer TEXT NOT NULL,
            chain TEXT NOT NULL,
            asset TEXT NOT NULL,
            amount TEXT NOT NULL,
            interval TEXT NOT NULL CHECK(interval IN ('weekly', 'monthly')),
            status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'PAUSED', 'PAST_DUE', 'CANCELLED', 'ENDED')),
            nextChargeAt TEXT NOT NULL,
            expiresAt TEXT,
            maxCharges INTEGER,
            chargesUsed INTEGER NOT NULL DEFAULT 1,
            firstPaymentId TEXT REFERENCES payments(paymentId) ON DELETE SET NULL,
            lastPaymentId TEXT REFERENCES payments(paymentId) ON DELETE SET NULL,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            pausedAt TEXT,
            cancelledAt TEXT,
            failureCount INTEGER NOT NULL DEFAULT 0,
            lastAttemptAt TEXT,
            pendingPaymentPayload TEXT,
            FOREIGN KEY(userId, chain, payer)
              REFERENCES user_wallets(userId, chain, walletAddress) ON DELETE RESTRICT
          );
          CREATE TABLE IF NOT EXISTS payments_new (
            paymentId TEXT PRIMARY KEY,
            network TEXT NOT NULL,
            scheme TEXT NOT NULL,
            payer TEXT NOT NULL,
            payTo TEXT NOT NULL,
            asset TEXT NOT NULL,
            amount TEXT NOT NULL,
            status TEXT NOT NULL,
            txHash TEXT,
            quoteId TEXT,
            depositAddress TEXT,
            refundTo TEXT,
            createdAt TEXT NOT NULL,
            verifiedAt TEXT,
            settledAt TEXT,
            invalidReason TEXT,
            merchantId TEXT REFERENCES merchants(merchantId) ON DELETE SET NULL,
            feeBreakdown TEXT,
            explorerUrl TEXT,
            failureReason TEXT,
            failureKind TEXT,
            parentPaymentId TEXT REFERENCES payments_new(paymentId) ON DELETE SET NULL,
            attemptNumber INTEGER DEFAULT 1,
            refundTxHash TEXT,
            refundAmount TEXT,
            refundAt TEXT,
            userId TEXT REFERENCES users(id) ON DELETE SET NULL,
            subscriptionId TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
            updatedAt TEXT NOT NULL DEFAULT ''
          );
        `);

        this.copyLegacySubscriptions();
        this.copyLegacyPayments();
        this.db.exec("ALTER TABLE payments_new RENAME TO payments");

        this.db.exec(`
          CREATE INDEX idx_payments_status ON payments(status);
          CREATE INDEX idx_payments_payer ON payments(payer);
          CREATE INDEX idx_payments_payTo ON payments(payTo);
          CREATE INDEX idx_payments_merchantId ON payments(merchantId);
          CREATE INDEX idx_payments_parent ON payments(parentPaymentId);
          CREATE INDEX idx_payments_userId ON payments(userId);
          CREATE INDEX idx_payments_subscriptionId ON payments(subscriptionId);
          CREATE INDEX idx_subscriptions_merchantId ON subscriptions(merchantId);
          CREATE INDEX idx_subscriptions_payer ON subscriptions(payer);
          CREATE INDEX idx_subscriptions_userId ON subscriptions(userId);
          CREATE INDEX idx_subscriptions_status ON subscriptions(status);
          CREATE INDEX idx_subscriptions_nextChargeAt ON subscriptions(nextChargeAt);
        `);
      });
      migrate();
      const violations = this.db.pragma("foreign_key_check") as any[];
      if (violations.length)
        throw new Error(
          `Identity migration produced foreign-key violations: ${JSON.stringify(violations[0])}`,
        );
    } finally {
      this.db.pragma("foreign_keys = ON");
    }
  }

  private copyLegacySubscriptions(): void {
    const legacyName = this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='subscriptions_legacy_backup'",
      )
      .get();
    if (!legacyName) return;
    const rows = this.db
      .prepare("SELECT * FROM subscriptions_legacy_backup")
      .all() as any[];
    const insert = this.db.prepare(`
      INSERT INTO subscriptions (
        id, userId, merchantId, payer, chain, asset, amount, interval, status,
        nextChargeAt, expiresAt, maxCharges, chargesUsed, firstPaymentId, lastPaymentId,
        createdAt, updatedAt, pausedAt, cancelledAt, failureCount, lastAttemptAt, pendingPaymentPayload
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
    `);
    for (const row of rows) {
      const firstPaymentId =
        row.firstPaymentId &&
        this.db
          .prepare("SELECT 1 FROM payments_legacy_backup WHERE paymentId = ?")
          .get(row.firstPaymentId)
          ? row.firstPaymentId
          : null;
      const lastPaymentId =
        (row.latestPaymentId ?? row.lastPaymentId) &&
        this.db
          .prepare("SELECT 1 FROM payments_legacy_backup WHERE paymentId = ?")
          .get(row.latestPaymentId ?? row.lastPaymentId)
          ? (row.latestPaymentId ?? row.lastPaymentId)
          : null;
      const statusMap: Record<string, string> = {
        active: "ACTIVE",
        paused: "PAUSED",
        past_due: "PAST_DUE",
        cancelled: "CANCELLED",
        ended: "ENDED",
      };
      insert.run(
        row.id,
        row.merchantId,
        row.payer,
        row.chain,
        row.asset,
        row.amount,
        row.interval,
        statusMap[String(row.status).toLowerCase()] ?? "PAST_DUE",
        row.nextChargeAt,
        row.expiresAt && row.expiresAt !== row.nextChargeAt
          ? row.expiresAt
          : null,
        row.maxCharges ?? null,
        row.chargesUsed ?? 1,
        firstPaymentId,
        lastPaymentId,
        row.createdAt,
        row.updatedAt,
        row.failureCount ?? 0,
        row.lastAttemptAt ?? null,
        row.pendingPaymentPayload ?? null,
      );
    }
  }

  private copyLegacyPayments(): void {
    const exists = this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='payments_legacy_backup'",
      )
      .get();
    if (!exists) return;
    const rows = this.db
      .prepare("SELECT * FROM payments_legacy_backup")
      .all() as any[];
    const insert = this.db.prepare(`
      INSERT INTO payments_new (
        paymentId, network, scheme, payer, payTo, asset, amount, status, txHash,
        quoteId, depositAddress, refundTo, createdAt, verifiedAt, settledAt, invalidReason,
        merchantId, feeBreakdown, explorerUrl, failureReason, failureKind, parentPaymentId,
        attemptNumber, refundTxHash, refundAmount, refundAt, userId, subscriptionId, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      const parentPaymentId =
        row.parentPaymentId &&
        this.db
          .prepare("SELECT 1 FROM payments_legacy_backup WHERE paymentId = ?")
          .get(row.parentPaymentId)
          ? row.parentPaymentId
          : null;
      const userId = this.db
        .prepare(
          `
        SELECT uw.userId FROM user_wallets uw
        WHERE uw.chain = ? AND uw.walletAddress = ? LIMIT 1
      `,
        )
        .get(row.network, row.payer) as { userId: string } | undefined;
      insert.run(
        row.paymentId,
        row.network,
        row.scheme,
        row.payer,
        row.payTo,
        row.asset,
        row.amount,
        row.status,
        row.txHash ?? null,
        row.quoteId ?? null,
        row.depositAddress ?? null,
        row.refundTo ?? null,
        row.createdAt,
        row.verifiedAt ?? null,
        row.settledAt ?? null,
        row.invalidReason ?? null,
        row.merchantId ?? null,
        row.feeBreakdown ?? null,
        row.explorerUrl ?? null,
        row.failureReason ?? null,
        row.failureKind ?? null,
        parentPaymentId,
        row.attemptNumber ?? 1,
        row.refundTxHash ?? null,
        row.refundAmount ?? null,
        row.refundAt ?? null,
        row.userId ?? userId?.userId ?? null,
        row.subscriptionId ?? null,
        row.updatedAt ?? row.createdAt,
      );
    }
  }

  // --- Payment Events Operations ---

  public recordPaymentEvent(
    paymentId: string,
    oldStatus: string | null,
    newStatus: string,
    reason?: string | null,
    createdAt?: string,
  ): void {
    const time = createdAt ?? new Date().toISOString();
    this.db
      .prepare(
        `
      INSERT INTO payment_events (paymentId, oldStatus, newStatus, reason, createdAt)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run(paymentId, oldStatus ?? "", newStatus, reason ?? null, time);
  }

  public getPaymentEvents(paymentId: string): PaymentEvent[] {
    const rows = this.db
      .prepare(
        "SELECT id, paymentId, oldStatus, newStatus, reason, createdAt FROM payment_events WHERE paymentId = ? ORDER BY id ASC",
      )
      .all(paymentId) as any[];

    return rows.map((r) => ({
      id: r.id,
      paymentId: r.paymentId,
      oldStatus: r.oldStatus ?? null,
      newStatus: r.newStatus,
      reason: r.reason ?? null,
      createdAt: r.createdAt,
    }));
  }

  // --- Payment Operations ---

  public savePayment(record: PaymentRecord): void {
    // Crucial: A settled/SUCCESS/REFUNDED record MUST NEVER be downgraded to 'verified', 'processing', or 'failed'.
    const existing = this.getPayment(record.paymentId);
    const existingStatus = existing?.status;

    // Determine final status respecting durability of terminal states
    let finalStatus = record.status;
    if (existingStatus === "settled" || existingStatus === "SUCCESS") {
      if (record.status !== "REFUNDED") {
        finalStatus = existingStatus;
      }
    } else if (existingStatus === "REFUNDED") {
      finalStatus = "REFUNDED";
    }

    // Automatically compute explorerUrl if missing and txHash is available
    const explorerUrl =
      record.explorerUrl ??
      getExplorerUrl(record.network, record.txHash ?? existing?.txHash) ??
      undefined;

    const feeBreakdownJson = record.feeBreakdown
      ? JSON.stringify(record.feeBreakdown)
      : existing?.feeBreakdown
        ? JSON.stringify(existing.feeBreakdown)
        : null;

    const stmt = this.db.prepare(`
      INSERT INTO payments (
        paymentId, network, scheme, payer, payTo, asset, amount,
        status, txHash, quoteId, depositAddress, refundTo,
        createdAt, verifiedAt, settledAt, invalidReason,
        merchantId, feeBreakdown, explorerUrl, failureReason,
        failureKind, parentPaymentId, attemptNumber, refundTxHash,
        refundAmount, refundAt, userId, subscriptionId, updatedAt
      ) VALUES (
        @paymentId, @network, @scheme, @payer, @payTo, @asset, @amount,
        @status, @txHash, @quoteId, @depositAddress, @refundTo,
        @createdAt, @verifiedAt, @settledAt, @invalidReason,
        @merchantId, @feeBreakdown, @explorerUrl, @failureReason,
        @failureKind, @parentPaymentId, @attemptNumber, @refundTxHash,
        @refundAmount, @refundAt, @userId, @subscriptionId, @updatedAt
      )
      ON CONFLICT(paymentId) DO UPDATE SET
        status = @status,
        txHash = COALESCE(@txHash, payments.txHash),
        quoteId = COALESCE(@quoteId, payments.quoteId),
        depositAddress = COALESCE(@depositAddress, payments.depositAddress),
        refundTo = COALESCE(@refundTo, payments.refundTo),
        verifiedAt = COALESCE(@verifiedAt, payments.verifiedAt),
        settledAt = CASE
          WHEN payments.status IN ('settled', 'SUCCESS') THEN payments.settledAt
          ELSE COALESCE(@settledAt, payments.settledAt)
        END,
        invalidReason = CASE
          WHEN payments.status IN ('settled', 'SUCCESS') THEN payments.invalidReason
          ELSE COALESCE(@invalidReason, payments.invalidReason)
        END,
        merchantId = COALESCE(@merchantId, payments.merchantId),
        feeBreakdown = COALESCE(@feeBreakdown, payments.feeBreakdown),
        explorerUrl = COALESCE(@explorerUrl, payments.explorerUrl),
        failureReason = COALESCE(@failureReason, payments.failureReason),
        failureKind = COALESCE(@failureKind, payments.failureKind),
        parentPaymentId = COALESCE(@parentPaymentId, payments.parentPaymentId),
        attemptNumber = COALESCE(@attemptNumber, payments.attemptNumber),
        refundTxHash = COALESCE(@refundTxHash, payments.refundTxHash),
        refundAmount = COALESCE(@refundAmount, payments.refundAmount),
        refundAt = COALESCE(@refundAt, payments.refundAt),
        userId = COALESCE(@userId, payments.userId),
        subscriptionId = COALESCE(@subscriptionId, payments.subscriptionId),
        updatedAt = @updatedAt
    `);

    stmt.run({
      ...record,
      status: finalStatus,
      txHash: record.txHash ?? null,
      quoteId: record.quoteId ?? null,
      depositAddress: record.depositAddress ?? null,
      refundTo: record.refundTo ?? null,
      verifiedAt: record.verifiedAt ?? null,
      settledAt: record.settledAt ?? null,
      invalidReason: record.invalidReason ?? null,
      merchantId: record.merchantId ?? existing?.merchantId ?? null,
      feeBreakdown: feeBreakdownJson,
      explorerUrl: explorerUrl ?? null,
      failureReason: record.failureReason ?? existing?.failureReason ?? null,
      failureKind: record.failureKind ?? existing?.failureKind ?? null,
      parentPaymentId:
        record.parentPaymentId ?? existing?.parentPaymentId ?? null,
      attemptNumber: record.attemptNumber ?? existing?.attemptNumber ?? 1,
      refundTxHash: record.refundTxHash ?? existing?.refundTxHash ?? null,
      refundAmount: record.refundAmount ?? existing?.refundAmount ?? null,
      refundAt: record.refundAt ?? existing?.refundAt ?? null,
      userId: record.userId ?? existing?.userId ?? null,
      subscriptionId: record.subscriptionId ?? existing?.subscriptionId ?? null,
      updatedAt: record.updatedAt ?? new Date().toISOString(),
    });

    // Write one event row on every status change or on initial creation
    if (!existing) {
      this.recordPaymentEvent(
        record.paymentId,
        null,
        finalStatus,
        record.failureReason ??
          record.invalidReason ??
          "Payment record created",
        record.createdAt,
      );
    } else if (existingStatus !== finalStatus) {
      this.recordPaymentEvent(
        record.paymentId,
        existingStatus ?? null,
        finalStatus,
        record.failureReason ??
          record.invalidReason ??
          `Status updated from ${existingStatus} to ${finalStatus}`,
        new Date().toISOString(),
      );
    }
  }

  public getPayment(paymentId: string): PaymentRecord | null {
    const row = this.db
      .prepare("SELECT * FROM payments WHERE paymentId = ?")
      .get(paymentId) as any;
    if (!row) return null;

    let feeBreakdown: FeeBreakdown | undefined;
    if (row.feeBreakdown) {
      try {
        feeBreakdown = JSON.parse(row.feeBreakdown);
      } catch {}
    }

    const txHash = row.txHash ?? undefined;
    const explorerUrl =
      row.explorerUrl || getExplorerUrl(row.network, txHash) || undefined;

    return {
      paymentId: row.paymentId,
      network: row.network,
      scheme: row.scheme,
      payer: row.payer,
      payTo: row.payTo,
      asset: row.asset,
      amount: row.amount,
      status: row.status,
      txHash,
      quoteId: row.quoteId ?? undefined,
      depositAddress: row.depositAddress ?? undefined,
      refundTo: row.refundTo ?? undefined,
      createdAt: row.createdAt,
      verifiedAt: row.verifiedAt ?? undefined,
      settledAt: row.settledAt ?? undefined,
      invalidReason: row.invalidReason ?? undefined,
      merchantId: row.merchantId ?? undefined,
      feeBreakdown,
      explorerUrl,
      failureReason: row.failureReason ?? undefined,
      failureKind: row.failureKind ?? undefined,
      parentPaymentId: row.parentPaymentId ?? undefined,
      userId: row.userId ?? undefined,
      subscriptionId: row.subscriptionId ?? undefined,
      attemptNumber: row.attemptNumber ?? 1,
      refundTxHash: row.refundTxHash ?? undefined,
      refundAmount: row.refundAmount ?? undefined,
      refundAt: row.refundAt ?? undefined,
    };
  }

  public listPayments(filter: {
    merchantId?: string;
    userId?: string;
    payer?: string;
    payTo?: string;
    status?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }): { payments: PaymentRecord[]; total: number } {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filter.merchantId) {
      conditions.push("(merchantId = ? OR payTo = ?)");
      params.push(filter.merchantId, filter.merchantId);
    } else if (filter.payTo) {
      conditions.push("payTo = ?");
      params.push(filter.payTo);
    }

    if (filter.userId) {
      conditions.push("userId = ?");
      params.push(filter.userId);
    }

    if (filter.payer) {
      conditions.push("payer = ?");
      params.push(filter.payer);
    }

    if (filter.status) {
      // Allow searching for SUCCESS to also match 'settled'
      if (filter.status === "SUCCESS" || filter.status === "settled") {
        conditions.push("status IN ('SUCCESS', 'settled')");
      } else {
        conditions.push("status = ?");
        params.push(filter.status);
      }
    }

    if (filter.from) {
      conditions.push("createdAt >= ?");
      params.push(filter.from);
    }

    if (filter.to) {
      conditions.push("createdAt <= ?");
      params.push(filter.to);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM payments ${whereClause}`)
      .get(...params) as any;
    const total = totalRow ? Number(totalRow.count) : 0;

    const limit = Math.max(1, Math.min(filter.limit ?? 50, 100));
    const offset = Math.max(0, filter.offset ?? 0);

    const rows = this.db
      .prepare(
        `SELECT * FROM payments ${whereClause} ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as any[];

    const payments: PaymentRecord[] = rows.map((row) => {
      let feeBreakdown: FeeBreakdown | undefined;
      if (row.feeBreakdown) {
        try {
          feeBreakdown = JSON.parse(row.feeBreakdown);
        } catch {}
      }
      const txHash = row.txHash ?? undefined;
      const explorerUrl =
        row.explorerUrl || getExplorerUrl(row.network, txHash) || undefined;
      return {
        paymentId: row.paymentId,
        network: row.network,
        scheme: row.scheme,
        payer: row.payer,
        payTo: row.payTo,
        asset: row.asset,
        amount: row.amount,
        status: row.status,
        txHash,
        quoteId: row.quoteId ?? undefined,
        depositAddress: row.depositAddress ?? undefined,
        refundTo: row.refundTo ?? undefined,
        createdAt: row.createdAt,
        verifiedAt: row.verifiedAt ?? undefined,
        settledAt: row.settledAt ?? undefined,
        invalidReason: row.invalidReason ?? undefined,
        merchantId: row.merchantId ?? undefined,
        feeBreakdown,
        explorerUrl,
        failureReason: row.failureReason ?? undefined,
        failureKind: row.failureKind ?? undefined,
        parentPaymentId: row.parentPaymentId ?? undefined,
        userId: row.userId ?? undefined,
        subscriptionId: row.subscriptionId ?? undefined,
        attemptNumber: row.attemptNumber ?? 1,
        refundTxHash: row.refundTxHash ?? undefined,
        refundAmount: row.refundAmount ?? undefined,
        refundAt: row.refundAt ?? undefined,
      };
    });

    return { payments, total };
  }

  // --- TTL Cache Operations ---

  public markSeen(
    category: "nonce" | "delegate" | "blockhash",
    key: string,
    ttlSeconds: number,
  ): boolean {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + ttlSeconds;

    // Prune expired
    this.db
      .prepare("DELETE FROM seen_items WHERE category = ? AND expiresAt <= ?")
      .run(category, now);

    const check = this.db
      .prepare(
        "SELECT expiresAt FROM seen_items WHERE category = ? AND key = ?",
      )
      .get(category, key) as any;
    if (check && check.expiresAt > now) {
      return false; // already seen and active
    }

    this.db
      .prepare(
        `
      INSERT INTO seen_items (category, key, expiresAt)
      VALUES (?, ?, ?)
      ON CONFLICT(category, key) DO UPDATE SET expiresAt = excluded.expiresAt
    `,
      )
      .run(category, key, expiresAt);
    return true;
  }

  public isSeen(
    category: "nonce" | "delegate" | "blockhash",
    key: string,
  ): boolean {
    const now = Math.floor(Date.now() / 1000);
    const row = this.db
      .prepare(
        "SELECT expiresAt FROM seen_items WHERE category = ? AND key = ?",
      )
      .get(category, key) as any;
    if (!row) return false;
    if (row.expiresAt <= now) {
      this.db
        .prepare("DELETE FROM seen_items WHERE category = ? AND key = ?")
        .run(category, key);
      return false;
    }
    return true;
  }

  public unmark(
    category: "nonce" | "delegate" | "blockhash",
    key: string,
  ): void {
    this.db
      .prepare("DELETE FROM seen_items WHERE category = ? AND key = ?")
      .run(category, key);
  }

  // --- Merchant Config & Atomic Credits ---

  public setMerchant(config: MerchantConfig): void {
    const now = new Date().toISOString();
    const accepts = Object.entries(config.payTo).map(([chain, payTo]) => ({
      chain,
      asset: config.settlementAsset,
      payTo,
    }));
    this.db
      .prepare(
        `
      INSERT INTO merchants (
        merchantId, id, name, settlementChain, settlementAsset, payToJson,
        creditBalance, dailyGasBudget, webhookUrl, accepts, creditBalanceUsdc, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0', ?, ?)
      ON CONFLICT(merchantId) DO UPDATE SET
        settlementChain = excluded.settlementChain,
        settlementAsset = excluded.settlementAsset,
        payToJson = excluded.payToJson,
        creditBalance = excluded.creditBalance,
        dailyGasBudget = excluded.dailyGasBudget,
        webhookUrl = COALESCE(excluded.webhookUrl, merchants.webhookUrl),
        accepts = excluded.accepts,
        updatedAt = excluded.updatedAt
    `,
      )
      .run(
        config.merchantId,
        config.merchantId,
        config.merchantId,
        config.settlementChain,
        config.settlementAsset,
        JSON.stringify(config.payTo),
        config.creditBalance,
        config.dailyGasBudget,
        config.webhookUrl ?? null,
        JSON.stringify(accepts),
        now,
        now,
      );
    if (config.apiKey) {
      const keyHash = crypto
        .createHash("sha256")
        .update(config.apiKey)
        .digest("hex");
      this.db
        .prepare(
          `
        INSERT OR IGNORE INTO api_keys
          (id, merchantId, keyHash, keyCiphertext, keyPrefix, name, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, 'legacy', ?, ?)
      `,
        )
        .run(
          `legacy_${config.merchantId}`,
          config.merchantId,
          keyHash,
          this.encryptApiKey(config.apiKey),
          config.apiKey.slice(0, 12),
          now,
          now,
        );
    }
  }

  public getMerchant(merchantId: string): MerchantConfig | null {
    const row = this.db
      .prepare("SELECT * FROM merchants WHERE merchantId = ?")
      .get(merchantId) as any;
    if (!row) return null;
    return {
      merchantId: row.merchantId,
      settlementChain: row.settlementChain,
      settlementAsset: row.settlementAsset,
      payTo: JSON.parse(row.payToJson),
      creditBalance: row.creditBalance,
      dailyGasBudget: row.dailyGasBudget,
      webhookUrl: row.webhookUrl ?? undefined,
    };
  }

  public getMerchantByApiKey(apiKey: string): MerchantConfig | null {
    if (!apiKey) return null;
    const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex");
    const row = this.db
      .prepare(
        `
      SELECT m.*, k.id AS apiKeyId
      FROM api_keys k JOIN merchants m ON m.merchantId = k.merchantId
      WHERE k.keyHash = ? AND k.revokedAt IS NULL
    `,
      )
      .get(keyHash) as any;
    if (!row) return null;
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE api_keys SET lastUsedAt = ?, updatedAt = ? WHERE id = ?")
      .run(now, now, row.apiKeyId);
    return {
      merchantId: row.merchantId,
      settlementChain: row.settlementChain,
      settlementAsset: row.settlementAsset,
      payTo: JSON.parse(row.payToJson),
      creditBalance: row.creditBalance,
      dailyGasBudget: row.dailyGasBudget,
      webhookUrl: row.webhookUrl ?? undefined,
    };
  }

  public getApiKeyStatus(apiKey: string): "active" | "revoked" | "unknown" {
    if (!apiKey) return "unknown";
    const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex");
    const row = this.db
      .prepare("SELECT revokedAt FROM api_keys WHERE keyHash = ?")
      .get(keyHash) as { revokedAt: string | null } | undefined;
    if (!row) return "unknown";
    return row.revokedAt ? "revoked" : "active";
  }

  public getWebhookSigningSecret(merchantId: string): string | null {
    const row = this.db
      .prepare(
        `
      SELECT keyCiphertext FROM api_keys
      WHERE merchantId = ? AND revokedAt IS NULL AND keyCiphertext IS NOT NULL
      ORDER BY createdAt LIMIT 1
    `,
      )
      .get(merchantId) as { keyCiphertext: string | null } | undefined;
    return this.decryptApiKey(row?.keyCiphertext);
  }

  public findUserWallet(
    chain: string,
    walletAddress: string,
  ): { userId: string; wallet: UserWalletRecord } | null {
    const row = this.db
      .prepare(
        `
      SELECT * FROM user_wallets WHERE chain = ? AND walletAddress = ?
    `,
      )
      .get(chain, walletAddress) as any;
    if (!row) return null;
    return { userId: row.userId, wallet: this.mapWallet(row) };
  }

  public userOwnsWallet(
    userId: string,
    chain: string,
    walletAddress: string,
  ): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM user_wallets WHERE userId = ? AND chain = ? AND walletAddress = ?",
        )
        .get(userId, chain, walletAddress),
    );
  }

  public createUserForWallet(chain: string, walletAddress: string): UserRecord {
    const existing = this.findUserWallet(chain, walletAddress);
    if (existing) {
      const now = new Date().toISOString();
      this.db
        .prepare(
          "UPDATE user_wallets SET verifiedAt = ?, updatedAt = ? WHERE id = ?",
        )
        .run(now, now, existing.wallet.id);
      this.db
        .prepare(
          `UPDATE payments SET userId = ?, updatedAt = ? WHERE userId IS NULL AND payer = ? AND network = ?`,
        )
        .run(existing.userId, now, walletAddress, chain);
      this.db
        .prepare(
          `UPDATE subscriptions SET userId = ?, updatedAt = ? WHERE userId IS NULL AND payer = ? AND chain = ?`,
        )
        .run(existing.userId, now, walletAddress, chain);
      return this.getUser(existing.userId)!;
    }

    if (chain.startsWith("eip155:")) {
      const familyWallet = this.db
        .prepare(
          `
        SELECT userId FROM user_wallets WHERE chain LIKE 'eip155:%' AND lower(walletAddress) = lower(?) LIMIT 1
      `,
        )
        .get(walletAddress) as { userId: string } | undefined;
      if (familyWallet) {
        this.linkWalletToUser(familyWallet.userId, chain, walletAddress);
        return this.getUser(familyWallet.userId)!;
      }
    }

    const now = new Date().toISOString();
    const userId = crypto.randomUUID();
    const run = this.db.transaction(() => {
      this.db
        .prepare(
          `
        INSERT INTO users (id, primaryWalletAddress, primaryChain, email, displayName, createdAt, updatedAt)
        VALUES (?, ?, ?, NULL, NULL, ?, ?)
      `,
        )
        .run(userId, walletAddress, chain, now, now);
      this.db
        .prepare(
          `
        INSERT INTO user_wallets (id, userId, chain, walletAddress, verifiedAt, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(crypto.randomUUID(), userId, chain, walletAddress, now, now, now);
      this.db
        .prepare(
          `
        UPDATE payments SET userId = ?, updatedAt = ?
        WHERE userId IS NULL AND payer = ? AND network = ?
      `,
        )
        .run(userId, now, walletAddress, chain);
      this.db
        .prepare(
          `
        UPDATE subscriptions SET userId = ?, updatedAt = ?
        WHERE userId IS NULL AND payer = ? AND chain = ?
      `,
        )
        .run(userId, now, walletAddress, chain);
    });
    run();
    return this.getUser(userId)!;
  }

  public linkWalletToUser(
    userId: string,
    chain: string,
    walletAddress: string,
  ): UserWalletRecord {
    const existing = this.findUserWallet(chain, walletAddress);
    if (existing && existing.userId !== userId) {
      throw new Error("Wallet is already linked to another user");
    }
    const now = new Date().toISOString();
    if (existing) {
      this.db
        .prepare(
          "UPDATE user_wallets SET verifiedAt = ?, updatedAt = ? WHERE id = ?",
        )
        .run(now, now, existing.wallet.id);
      return { ...existing.wallet, verifiedAt: now, updatedAt: now };
    }
    const wallet: UserWalletRecord = {
      id: crypto.randomUUID(),
      userId,
      chain,
      walletAddress,
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `
      INSERT INTO user_wallets (id, userId, chain, walletAddress, verifiedAt, createdAt, updatedAt)
      VALUES (@id, @userId, @chain, @walletAddress, @verifiedAt, @createdAt, @updatedAt)
    `,
      )
      .run(wallet);
    this.db
      .prepare(
        `
      UPDATE payments SET userId = ?, updatedAt = ?
      WHERE userId IS NULL AND payer = ? AND network = ?
    `,
      )
      .run(userId, now, walletAddress, chain);
    this.db
      .prepare(
        `
      UPDATE subscriptions SET userId = ?, updatedAt = ?
      WHERE userId IS NULL AND payer = ? AND chain = ?
    `,
      )
      .run(userId, now, walletAddress, chain);
    return wallet;
  }

  public getUser(userId: string): UserRecord | null {
    return (
      (this.db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as
        | UserRecord
        | undefined) ?? null
    );
  }

  public getUserProfile(userId: string):
    | (UserRecord & {
        wallets: UserWalletRecord[];
        merchants: MerchantAccountRecord[];
      })
    | null {
    const user = this.getUser(userId);
    if (!user) return null;
    const wallets = (
      this.db
        .prepare(
          "SELECT * FROM user_wallets WHERE userId = ? ORDER BY createdAt",
        )
        .all(userId) as any[]
    ).map((row) => this.mapWallet(row));
    return { ...user, wallets, merchants: this.listOwnedMerchants(userId) };
  }

  private mapWallet(row: any): UserWalletRecord {
    return {
      id: row.id,
      userId: row.userId,
      chain: row.chain,
      walletAddress: row.walletAddress,
      verifiedAt: row.verifiedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  public createAuthNonce(
    nonce: string,
    chain: string,
    walletAddress: string,
    message: string,
    expiresAt: string,
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "DELETE FROM auth_nonces WHERE expiresAt <= ? OR usedAt IS NOT NULL",
      )
      .run(now);
    this.db
      .prepare(
        `
      INSERT INTO auth_nonces (nonce, chain, walletAddress, message, expiresAt, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(nonce, chain, walletAddress, message, expiresAt, now, now);
  }

  public getAuthNonceMessage(
    nonce: string,
    chain: string,
    walletAddress: string,
  ): string | null {
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        `
      SELECT message FROM auth_nonces
      WHERE nonce = ? AND chain = ? AND walletAddress = ? AND usedAt IS NULL AND expiresAt > ?
    `,
      )
      .get(nonce, chain, walletAddress, now) as { message: string } | undefined;
    return row?.message ?? null;
  }

  public consumeAuthNonce(
    nonce: string,
    chain: string,
    walletAddress: string,
  ): string | null {
    const now = new Date().toISOString();
    const consume = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `
        SELECT message FROM auth_nonces
        WHERE nonce = ? AND chain = ? AND walletAddress = ? AND usedAt IS NULL AND expiresAt > ?
      `,
        )
        .get(nonce, chain, walletAddress, now) as
        | { message: string }
        | undefined;
      if (!row) return null;
      const result = this.db
        .prepare(
          `
        UPDATE auth_nonces SET usedAt = ?, updatedAt = ?
        WHERE nonce = ? AND usedAt IS NULL AND expiresAt > ?
      `,
        )
        .run(now, now, nonce, now);
      return result.changes === 1 ? row.message : null;
    });
    return consume();
  }

  public createSession(
    userId: string,
    chain: string,
    walletAddress: string,
    token: string,
    expiresAt: string,
  ): void {
    const now = new Date().toISOString();
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    this.db
      .prepare(
        `
      INSERT INTO sessions (id, userId, tokenHash, chain, walletAddress, expiresAt, createdAt, updatedAt, revokedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `,
      )
      .run(
        crypto.randomUUID(),
        userId,
        tokenHash,
        chain,
        walletAddress,
        expiresAt,
        now,
        now,
      );
  }

  public getSessionUser(token: string): UserRecord | null {
    if (!token) return null;
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        `
      SELECT u.* FROM sessions s JOIN users u ON u.id = s.userId
      WHERE s.tokenHash = ? AND s.revokedAt IS NULL AND s.expiresAt > ?
    `,
      )
      .get(tokenHash, now) as UserRecord | undefined;
    if (row)
      this.db
        .prepare("UPDATE sessions SET updatedAt = ? WHERE tokenHash = ?")
        .run(now, tokenHash);
    return row ?? null;
  }

  public revokeSession(token: string): boolean {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const now = new Date().toISOString();
    return (
      this.db
        .prepare(
          `
      UPDATE sessions SET revokedAt = ?, updatedAt = ? WHERE tokenHash = ? AND revokedAt IS NULL
    `,
        )
        .run(now, now, tokenHash).changes === 1
    );
  }

  public getMerchantAccount(merchantId: string): MerchantAccountRecord | null {
    const row = this.db
      .prepare("SELECT * FROM merchants WHERE merchantId = ?")
      .get(merchantId) as any;
    return row ? this.mapMerchantAccount(row) : null;
  }

  private mapMerchantAccount(row: any): MerchantAccountRecord {
    let accepts: MerchantAccept[] = [];
    try {
      accepts = JSON.parse(row.accepts || "[]");
    } catch {}
    return {
      id: row.id,
      userId: row.userId ?? null,
      name: row.name,
      email: row.email ?? null,
      webhookUrl: row.webhookUrl ?? null,
      accepts,
      creditBalanceUsdc: row.creditBalanceUsdc ?? "0",
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  public listOwnedMerchants(userId: string): MerchantAccountRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM merchants WHERE userId = ? ORDER BY createdAt")
        .all(userId) as any[]
    ).map((row) => this.mapMerchantAccount(row));
  }

  public createMerchantAccount(
    userId: string,
    input: {
      name: string;
      email?: string | null;
      webhookUrl?: string | null;
      accepts: MerchantAccept[];
    },
    keyName = "default",
  ): { merchant: MerchantAccountRecord; apiKey: string; key: ApiKeyRecord } {
    if (!config.API_KEY_ENCRYPTION_KEY) {
      throw new Error(
        "API_KEY_ENCRYPTION_KEY is required to create merchant API keys",
      );
    }
    const id = `mer_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();
    const payTo = Object.fromEntries(
      input.accepts.map((accept) => [accept.chain, accept.payTo]),
    );
    const network = input.accepts[0]?.chain ?? "";
    const settlementChain = network.startsWith("eip155:")
      ? "base"
      : network.startsWith("solana:")
        ? "solana"
        : "near";
    this.db
      .prepare(
        `
      INSERT INTO merchants (
        merchantId, id, userId, name, email, webhookUrl, accepts, creditBalanceUsdc,
        settlementChain, settlementAsset, payToJson, creditBalance, dailyGasBudget, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '0', ?, 'USDC', ?, '0', '0', ?, ?)
    `,
      )
      .run(
        id,
        id,
        userId,
        input.name,
        input.email ?? null,
        input.webhookUrl ?? null,
        JSON.stringify(input.accepts),
        settlementChain,
        JSON.stringify(payTo),
        now,
        now,
      );
    const { apiKey, key } = this.createApiKey(id, keyName);
    return { merchant: this.getMerchantAccount(id)!, apiKey, key };
  }

  public createApiKey(
    merchantId: string,
    name: string,
  ): { apiKey: string; key: ApiKeyRecord } {
    if (!config.API_KEY_ENCRYPTION_KEY) {
      throw new Error(
        "API_KEY_ENCRYPTION_KEY is required to create merchant API keys",
      );
    }
    const now = new Date().toISOString();
    const apiKey = `rg_${crypto.randomBytes(32).toString("base64url")}`;
    const id = crypto.randomUUID();
    const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex");
    this.db
      .prepare(
        `
      INSERT INTO api_keys (id, merchantId, keyHash, keyCiphertext, keyPrefix, name, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        merchantId,
        keyHash,
        this.encryptApiKey(apiKey),
        apiKey.slice(0, 12),
        name,
        now,
        now,
      );
    return {
      apiKey,
      key: {
        id,
        merchantId,
        keyPrefix: apiKey.slice(0, 12),
        name,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: now,
      },
    };
  }

  public listApiKeys(merchantId: string): ApiKeyRecord[] {
    return this.db
      .prepare(
        `
      SELECT id, merchantId, keyPrefix, name, lastUsedAt, revokedAt, createdAt
      FROM api_keys WHERE merchantId = ? ORDER BY createdAt
    `,
      )
      .all(merchantId) as ApiKeyRecord[];
  }

  public revokeApiKey(merchantId: string, keyId: string): boolean {
    const now = new Date().toISOString();
    return (
      this.db
        .prepare(
          `
      UPDATE api_keys SET revokedAt = ?, updatedAt = ?
      WHERE id = ? AND merchantId = ? AND revokedAt IS NULL
    `,
        )
        .run(now, now, keyId, merchantId).changes === 1
    );
  }

  public deductCredit(merchantId: string, amount: bigint): boolean {
    const runTx = this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT creditBalance FROM merchants WHERE merchantId = ?")
        .get(merchantId) as any;
      if (!row) return false;
      const current = BigInt(row.creditBalance);
      if (current < amount) return false;
      const nextBalance = (current - amount).toString();
      this.db
        .prepare("UPDATE merchants SET creditBalance = ? WHERE merchantId = ?")
        .run(nextBalance, merchantId);
      return true;
    });
    return runTx();
  }

  public recordGasSpend(
    keyId: string,
    amount: bigint,
    maxDailyBudget: bigint,
  ): boolean {
    const today = new Date().toISOString().slice(0, 10);
    const runTx = this.db.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT spentUnits FROM daily_gas_spend WHERE keyId = ? AND dayDate = ?",
        )
        .get(keyId, today) as any;
      const currentSpent = row ? BigInt(row.spentUnits) : 0n;
      if (currentSpent + amount > maxDailyBudget) {
        return false;
      }
      const newSpent = (currentSpent + amount).toString();
      this.db
        .prepare(
          `
        INSERT INTO daily_gas_spend (keyId, dayDate, spentUnits)
        VALUES (?, ?, ?)
        ON CONFLICT(keyId, dayDate) DO UPDATE SET spentUnits = excluded.spentUnits
      `,
        )
        .run(keyId, today, newSpent);
      return true;
    });
    return runTx();
  }

  // --- Subscriptions Operations ---

  public saveSubscription(sub: SubscriptionRecord): void {
    const existing = this.getSubscription(sub.id);
    const status = dbSubscriptionStatus(sub.status);
    const stmt = this.db.prepare(`
      INSERT INTO subscriptions (
        id, userId, merchantId, payer, chain, asset, amount, interval,
        nextChargeAt, expiresAt, maxCharges, chargesUsed, status,
        createdAt, updatedAt, firstPaymentId, lastPaymentId, pausedAt, cancelledAt,
        failureCount, lastAttemptAt, pendingPaymentPayload
      ) VALUES (
        @id, @userId, @merchantId, @payer, @chain, @asset, @amount, @interval,
        @nextChargeAt, @expiresAt, @maxCharges, @chargesUsed, @status,
        @createdAt, @updatedAt, @firstPaymentId, @lastPaymentId, @pausedAt, @cancelledAt,
        @failureCount, @lastAttemptAt, @pendingPaymentPayload
      )
      ON CONFLICT(id) DO UPDATE SET
        userId = COALESCE(excluded.userId, subscriptions.userId),
        merchantId = excluded.merchantId,
        payer = excluded.payer,
        chain = excluded.chain,
        asset = excluded.asset,
        amount = excluded.amount,
        interval = excluded.interval,
        nextChargeAt = excluded.nextChargeAt,
        expiresAt = excluded.expiresAt,
        maxCharges = excluded.maxCharges,
        chargesUsed = excluded.chargesUsed,
        status = excluded.status,
        updatedAt = excluded.updatedAt,
        firstPaymentId = COALESCE(excluded.firstPaymentId, subscriptions.firstPaymentId),
        lastPaymentId = COALESCE(excluded.lastPaymentId, subscriptions.lastPaymentId),
        pausedAt = excluded.pausedAt,
        cancelledAt = excluded.cancelledAt,
        failureCount = excluded.failureCount,
        lastAttemptAt = COALESCE(excluded.lastAttemptAt, subscriptions.lastAttemptAt),
        pendingPaymentPayload = excluded.pendingPaymentPayload
    `);

    const save = this.db.transaction(() => {
      stmt.run({
        ...sub,
        userId: sub.userId ?? null,
        expiresAt: sub.expiresAt ?? null,
        status,
        maxCharges: sub.maxCharges ?? null,
        firstPaymentId: sub.firstPaymentId ?? null,
        lastPaymentId: sub.lastPaymentId ?? sub.latestPaymentId ?? null,
        pausedAt: sub.pausedAt ?? null,
        cancelledAt: sub.cancelledAt ?? null,
        lastAttemptAt: sub.lastAttemptAt ?? null,
        pendingPaymentPayload: sub.pendingPaymentPayload ?? null,
      });
      if (!existing || existing.status !== sub.status) {
        this.recordSubscriptionEvent(
          sub.id,
          existing?.status ?? null,
          sub.status,
          "Subscription status changed",
          sub.updatedAt,
        );
      }
    });
    save();
  }

  public recordSubscriptionEvent(
    subscriptionId: string,
    oldStatus: string | null,
    newStatus: string,
    reason?: string | null,
    createdAt = new Date().toISOString(),
  ): void {
    this.db
      .prepare(
        `
      INSERT INTO subscription_events (id, subscriptionId, oldStatus, newStatus, reason, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        crypto.randomUUID(),
        subscriptionId,
        oldStatus ? dbSubscriptionStatus(oldStatus) : null,
        dbSubscriptionStatus(newStatus),
        reason ?? null,
        createdAt,
        createdAt,
      );
  }

  public getSubscriptionEvents(subscriptionId: string): any[] {
    return this.db
      .prepare(
        "SELECT id, subscriptionId, oldStatus, newStatus, reason, createdAt FROM subscription_events WHERE subscriptionId = ? ORDER BY createdAt, id",
      )
      .all(subscriptionId);
  }

  public getSubscription(id: string): SubscriptionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM subscriptions WHERE id = ?")
      .get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      userId: row.userId ?? null,
      merchantId: row.merchantId,
      payer: row.payer,
      chain: row.chain,
      asset: row.asset,
      amount: row.amount,
      interval: row.interval as any,
      nextChargeAt: row.nextChargeAt,
      expiresAt: row.expiresAt,
      maxCharges: row.maxCharges !== null ? Number(row.maxCharges) : null,
      chargesUsed: Number(row.chargesUsed),
      status: internalSubscriptionStatus(row.status),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      firstPaymentId: row.firstPaymentId ?? undefined,
      lastPaymentId: row.lastPaymentId ?? undefined,
      latestPaymentId: row.lastPaymentId ?? undefined,
      pausedAt: row.pausedAt ?? undefined,
      cancelledAt: row.cancelledAt ?? undefined,
      failureCount: Number(row.failureCount || 0),
      lastAttemptAt: row.lastAttemptAt ?? undefined,
      pendingPaymentPayload: row.pendingPaymentPayload ?? undefined,
    };
  }

  public listSubscriptions(filter: {
    merchantId?: string;
    userId?: string;
    payer?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): { subscriptions: SubscriptionRecord[]; total: number } {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filter.merchantId) {
      conditions.push("merchantId = ?");
      params.push(filter.merchantId);
    }
    if (filter.userId) {
      conditions.push("userId = ?");
      params.push(filter.userId);
    }
    if (filter.payer) {
      conditions.push("payer = ?");
      params.push(filter.payer);
    }
    if (filter.status) {
      conditions.push("status = ?");
      params.push(dbSubscriptionStatus(filter.status));
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM subscriptions ${whereClause}`)
      .get(...params) as any;
    const total = totalRow ? Number(totalRow.count) : 0;

    const limit = Math.max(1, Math.min(filter.limit ?? 50, 100));
    const offset = Math.max(0, filter.offset ?? 0);

    const rows = this.db
      .prepare(
        `SELECT * FROM subscriptions ${whereClause} ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as any[];

    const subscriptions: SubscriptionRecord[] = rows.map((row) => ({
      id: row.id,
      userId: row.userId ?? null,
      merchantId: row.merchantId,
      payer: row.payer,
      chain: row.chain,
      asset: row.asset,
      amount: row.amount,
      interval: row.interval as any,
      nextChargeAt: row.nextChargeAt,
      expiresAt: row.expiresAt,
      maxCharges: row.maxCharges !== null ? Number(row.maxCharges) : null,
      chargesUsed: Number(row.chargesUsed),
      status: internalSubscriptionStatus(row.status),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      firstPaymentId: row.firstPaymentId ?? undefined,
      lastPaymentId: row.lastPaymentId ?? undefined,
      latestPaymentId: row.lastPaymentId ?? undefined,
      pausedAt: row.pausedAt ?? undefined,
      cancelledAt: row.cancelledAt ?? undefined,
      failureCount: Number(row.failureCount || 0),
      lastAttemptAt: row.lastAttemptAt ?? undefined,
      pendingPaymentPayload: row.pendingPaymentPayload ?? undefined,
    }));

    return { subscriptions, total };
  }

  public getDueSubscriptions(nowIso: string): SubscriptionRecord[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM subscriptions
      WHERE (
        (status IN ('ACTIVE', 'PAST_DUE') AND nextChargeAt <= ?) OR
        (status IN ('ACTIVE', 'PAST_DUE', 'PAUSED') AND expiresAt IS NOT NULL AND expiresAt <= ?) OR
        (status IN ('ACTIVE', 'PAST_DUE', 'PAUSED') AND maxCharges IS NOT NULL AND chargesUsed >= maxCharges)
      )
    `,
      )
      .all(nowIso, nowIso) as any[];

    return rows.map((row) => ({
      id: row.id,
      userId: row.userId ?? null,
      merchantId: row.merchantId,
      payer: row.payer,
      chain: row.chain,
      asset: row.asset,
      amount: row.amount,
      interval: row.interval as any,
      nextChargeAt: row.nextChargeAt,
      expiresAt: row.expiresAt,
      maxCharges: row.maxCharges !== null ? Number(row.maxCharges) : null,
      chargesUsed: Number(row.chargesUsed),
      status: internalSubscriptionStatus(row.status),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      firstPaymentId: row.firstPaymentId ?? undefined,
      lastPaymentId: row.lastPaymentId ?? undefined,
      latestPaymentId: row.lastPaymentId ?? undefined,
      pausedAt: row.pausedAt ?? undefined,
      cancelledAt: row.cancelledAt ?? undefined,
      failureCount: Number(row.failureCount || 0),
      lastAttemptAt: row.lastAttemptAt ?? undefined,
      pendingPaymentPayload: row.pendingPaymentPayload ?? undefined,
    }));
  }

  public getUserStats(userId: string): {
    totalVolumeUsdc: string;
    totalPayments: number;
    successfulPayments: number;
    successRate: number | null;
    activeSubscriptions: number;
  } {
    const paymentCounts = this.db
      .prepare(
        `
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status IN ('settled', 'SUCCESS') THEN 1 ELSE 0 END) AS successful
      FROM payments WHERE userId = ?
    `,
      )
      .get(userId) as { total: number; successful: number | null };
    const settledAmounts = this.db
      .prepare(
        "SELECT amount FROM payments WHERE userId = ? AND status IN ('settled', 'SUCCESS')",
      )
      .all(userId) as { amount: string }[];
    const volume = settledAmounts.reduce(
      (sum, row) => sum + BigInt(row.amount),
      0n,
    );
    const raw = volume.toString().padStart(7, "0");
    const totalPayments = Number(paymentCounts.total ?? 0);
    const successfulPayments = Number(paymentCounts.successful ?? 0);
    const activeSubscriptions = Number(
      (
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM subscriptions WHERE userId = ? AND status = 'ACTIVE'",
          )
          .get(userId) as { count: number }
      ).count,
    );
    return {
      totalVolumeUsdc: `${raw.slice(0, -6)}.${raw.slice(-6)}`,
      totalPayments,
      successfulPayments,
      successRate: totalPayments
        ? Math.round((successfulPayments / totalPayments) * 10000) / 100
        : null,
      activeSubscriptions,
    };
  }

  public setSubscriptionPendingCharge(
    id: string,
    payload: string,
    nowIso: string,
  ): boolean {
    const result = this.db
      .prepare(
        `
      UPDATE subscriptions
      SET pendingPaymentPayload = ?, lastAttemptAt = ?, updatedAt = ?
      WHERE id = ? AND status IN ('ACTIVE', 'PAST_DUE') AND pendingPaymentPayload IS NULL
    `,
      )
      .run(payload, nowIso, nowIso, id);
    return result.changes === 1;
  }

  public completeSubscriptionCharge(
    subscriptionId: string,
    paymentId: string,
    settledAt: string,
  ): { applied: boolean; subscription: SubscriptionRecord | null } {
    const complete = this.db.transaction(() => {
      const sub = this.getSubscription(subscriptionId);
      const payment = this.getPayment(paymentId);
      if (
        !sub ||
        !payment ||
        !["settled", "SUCCESS"].includes(payment.status)
      ) {
        return { applied: false, subscription: sub };
      }
      if (
        sub.lastPaymentId === paymentId ||
        sub.latestPaymentId === paymentId
      ) {
        return { applied: false, subscription: sub };
      }

      const intervalMs =
        sub.interval === "weekly" ? 7 * 86400000 : 30 * 86400000;
      const previousDue = new Date(sub.nextChargeAt).getTime();
      const settledTime = new Date(settledAt).getTime();
      sub.nextChargeAt = new Date(
        Math.max(previousDue, settledTime) + intervalMs,
      ).toISOString();
      sub.chargesUsed += 1;
      sub.lastPaymentId = paymentId;
      sub.latestPaymentId = paymentId;
      sub.pendingPaymentPayload = undefined;
      sub.lastAttemptAt = undefined;
      sub.failureCount = 0;
      sub.updatedAt = settledAt;
      if (
        (sub.maxCharges !== null &&
          sub.maxCharges !== undefined &&
          sub.chargesUsed >= sub.maxCharges) ||
        (sub.expiresAt !== null &&
          sub.expiresAt !== undefined &&
          settledTime >= new Date(sub.expiresAt).getTime())
      ) {
        sub.status = "ended";
      } else {
        sub.status = "active";
      }
      this.saveSubscription(sub);
      return {
        applied: true,
        subscription: this.getSubscription(subscriptionId),
      };
    });
    return complete();
  }
}

// Global default store singleton
let defaultStore: PaymentStore | null = null;
export function getPaymentStore(dbPath?: string): PaymentStore {
  if (!defaultStore || dbPath) {
    defaultStore = new PaymentStore(dbPath);
  }
  return defaultStore;
}
