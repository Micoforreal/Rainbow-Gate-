/**
 * stats.test.ts — Unit tests for GET /stats
 *
 * Tests:
 *  1. Public /stats returns all required fields with correct shapes
 *  2. successRate is null when there are no payments
 *  3. successRate rounds to 2 decimals
 *  4. volumeTodayUsdc only counts settled payments created today
 *  5. GET /stats?merchantId=<id> returns 401 when X-API-Key is missing
 *  6. GET /stats?merchantId=<id> returns 403 when key doesn't match the merchant
 *  7. GET /stats?merchantId=<id> returns 200 and scoped numbers with correct key
 *  8. successRateByChain returns null for chains with no payments
 *  9. volumeByChainUsdc sums only settled amounts and formats as 6-decimal string
 * 10. Cache returns same object within 30 s window
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express, { type Express } from "express";
const { getPaymentStoreMock } = vi.hoisted(() => ({
  getPaymentStoreMock: vi.fn(),
}));
vi.mock("../src/lib/payments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/payments")>();
  return { ...actual, getPaymentStore: getPaymentStoreMock };
});
import { PaymentStore } from "../src/lib/payments";
import { createStatsRouter } from "../src/routes/stats.route";
import { createSubscriptionsRouter } from "../src/routes/subscriptions.route";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create an in-memory PaymentStore using :memory: SQLite */
function makeStore(): PaymentStore {
  return new PaymentStore(":memory:");
}

async function get(
  app: Express,
  url: string,
  headers: Record<string, string> = {},
) {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Test server did not bind a TCP port");
    const response = await fetch(`http://127.0.0.1:${address.port}${url}`, {
      headers,
    });
    return { status: response.status, body: (await response.json()) as any };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function settled(
  store: PaymentStore,
  overrides: Partial<{
    paymentId: string;
    network: string;
    amount: string;
    settledAt: string;
    createdAt: string;
    merchantId: string | null;
    payTo: string;
  }> = {},
) {
  const id =
    overrides.paymentId ?? `pid_${Math.random().toString(36).slice(2)}`;
  store.savePayment({
    paymentId: id,
    network: overrides.network ?? "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    scheme: "exact",
    payer: "payer1",
    payTo: overrides.payTo ?? "merchant1",
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amount: overrides.amount ?? "1000",
    status: "settled",
    txHash: "txhash1",
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    settledAt: overrides.settledAt ?? new Date().toISOString(),
    merchantId: overrides.merchantId ?? undefined,
  });
  return id;
}

function failed(
  store: PaymentStore,
  overrides: Partial<{
    paymentId: string;
    network: string;
    amount: string;
    merchantId: string | null;
    payTo: string;
  }> = {},
) {
  const id =
    overrides.paymentId ?? `pid_${Math.random().toString(36).slice(2)}`;
  store.savePayment({
    paymentId: id,
    network: overrides.network ?? "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    scheme: "exact",
    payer: "payer1",
    payTo: overrides.payTo ?? "merchant1",
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amount: overrides.amount ?? "1000",
    status: "failed",
    createdAt: new Date().toISOString(),
    merchantId: overrides.merchantId ?? undefined,
  });
  return id;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /stats", () => {
  let store: PaymentStore;

  beforeEach(() => {
    store = makeStore();
    getPaymentStoreMock.mockReturnValue(store);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    getPaymentStoreMock.mockReset();
  });

  it("returns 200 with all required top-level fields", async () => {
    settled(store);

    // Use direct route invocation instead of http
    const { createStatsRouter: mkRouter } =
      await import("../src/routes/stats.route");
    const serverStart = new Date(Date.now() - 5000);
    const router = mkRouter(serverStart);

    // Simulate a request by calling the route handler directly via express
    const testApp = express();
    testApp.use(express.json());
    // Monkey-patch getPaymentStore on the already-imported module
    testApp.use(router);

    const response = await get(testApp, "/stats");

    // Restore
    expect(response.status).toBe(200);
    const body = response.body;

    // Required fields
    expect(typeof body.totalVolumeUsdc).toBe("string");
    expect(typeof body.totalPayments).toBe("number");
    expect(typeof body.successfulPayments).toBe("number");
    expect(typeof body.paymentsToday).toBe("number");
    expect(typeof body.volumeTodayUsdc).toBe("string");
    expect(typeof body.successRateByChain).toBe("object");
    expect(typeof body.volumeByChainUsdc).toBe("object");
    expect(typeof body.serverStartedAt).toBe("string");
    expect(typeof body.uptimeSeconds).toBe("number");
    expect(typeof body.environment).toBe("string");

    // uptimeSeconds ≥ 5 (we started 5 seconds ago)
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(5);

    // USDC format: decimal string with 6 fractional digits
    expect(body.totalVolumeUsdc).toMatch(/^\d+\.\d{6}$/);
  });

  it("keeps public stats accessible after the subscription router is mounted", async () => {
    const app = express();
    app.use(createSubscriptionsRouter());
    app.use(createStatsRouter(new Date()));

    const response = await get(app, "/stats");

    expect(response.status).toBe(200);
  });

  it("successRate is null when there are no payments", async () => {
    const { createStatsRouter: mkRouter } =
      await import("../src/routes/stats.route");
    const router = mkRouter(new Date());
    const testApp = express();
    testApp.use(express.json());
    testApp.use(router);

    const response = await get(testApp, "/stats");

    expect(response.status).toBe(200);
    expect(response.body.successRate).toBeNull();
    expect(response.body.totalPayments).toBe(0);
  });

  it("successRate rounds to 2 decimals", async () => {
    // 1 success + 2 failures = 33.33%
    settled(store);
    failed(store);
    failed(store);

    const { createStatsRouter: mkRouter } =
      await import("../src/routes/stats.route");
    const router = mkRouter(new Date());
    const testApp = express();
    testApp.use(express.json());
    testApp.use(router);

    const response = await get(testApp, "/stats");

    expect(response.status).toBe(200);
    expect(response.body.successRate).toBe(33.33);
    expect(response.body.totalPayments).toBe(3);
    expect(response.body.successfulPayments).toBe(1);
  });

  it("volumeTodayUsdc only counts settled payments with createdAt today UTC", async () => {
    // Yesterday payment (should NOT be in today volume)
    settled(store, {
      amount: "999999",
      createdAt: "2020-01-01T00:00:00.000Z",
      settledAt: "2020-01-01T00:00:01.000Z",
    });

    // Today payment
    settled(store, {
      amount: "1000",
      createdAt: new Date().toISOString(),
      settledAt: new Date().toISOString(),
    });

    const { createStatsRouter: mkRouter } =
      await import("../src/routes/stats.route");
    const router = mkRouter(new Date());
    const testApp = express();
    testApp.use(express.json());
    testApp.use(router);

    const response = await get(testApp, "/stats");

    expect(response.status).toBe(200);
    // 1000 base units = 0.001000 USDC
    expect(response.body.volumeTodayUsdc).toBe("0.001000");
    expect(response.body.paymentsToday).toBe(1);
  });

  it("does not count payments created after the current time in today stats", async () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    settled(store, {
      amount: "7000",
      createdAt: tomorrow,
      settledAt: tomorrow,
    });

    const { createStatsRouter: mkRouter } =
      await import("../src/routes/stats.route");
    const testApp = express();
    testApp.use(mkRouter(new Date()));

    const response = await get(testApp, "/stats");

    expect(response.status).toBe(200);
    expect(response.body.paymentsToday).toBe(0);
    expect(response.body.volumeTodayUsdc).toBe("0.000000");
  });

  it("returns 401 when ?merchantId is set but X-API-Key is missing", async () => {
    const { createStatsRouter: mkRouter } =
      await import("../src/routes/stats.route");
    const router = mkRouter(new Date());
    const testApp = express();
    testApp.use(express.json());
    testApp.use(router);

    const response = await get(testApp, "/stats?merchantId=acme");

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 when X-API-Key does not match the requested merchantId", async () => {
    // Register merchant "acme" with key "key-acme"
    store.setMerchant({
      merchantId: "acme",
      settlementChain: "solana",
      settlementAsset: "USDC",
      payTo: { "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "merchant1" },
      creditBalance: "0",
      dailyGasBudget: "0",
      apiKey: "key-acme",
    });

    const { createStatsRouter: mkRouter } =
      await import("../src/routes/stats.route");
    const router = mkRouter(new Date());
    const testApp = express();
    testApp.use(express.json());
    testApp.use(router);

    // Wrong merchantId (key-acme belongs to 'acme', not 'other')
    const response = await get(testApp, "/stats?merchantId=other", {
      "X-API-Key": "key-acme",
    });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("FORBIDDEN");
  });

  it("returns 200 scoped stats for a merchant with correct X-API-Key", async () => {
    store.setMerchant({
      merchantId: "acme",
      settlementChain: "solana",
      settlementAsset: "USDC",
      payTo: { "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "merchant-acme" },
      creditBalance: "0",
      dailyGasBudget: "0",
      apiKey: "key-acme",
    });
    store.setMerchant({
      merchantId: "other",
      settlementChain: "solana",
      settlementAsset: "USDC",
      payTo: { "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "merchant-other" },
      creditBalance: "0",
      dailyGasBudget: "0",
    });

    // 1 settled for acme, 1 settled for someone else
    settled(store, {
      amount: "2000",
      merchantId: "acme",
      payTo: "merchant-acme",
    });
    settled(store, { amount: "999999", merchantId: "other" });

    const { createStatsRouter: mkRouter } =
      await import("../src/routes/stats.route");
    const router = mkRouter(new Date());
    const testApp = express();
    testApp.use(express.json());
    testApp.use(router);

    const response = await get(testApp, "/stats?merchantId=acme", {
      "X-API-Key": "key-acme",
    });

    expect(response.status).toBe(200);
    // Only acme's payment counts: 2000 base units = 0.002000 USDC
    expect(response.body.totalPayments).toBe(1);
    expect(response.body.successfulPayments).toBe(1);
    expect(response.body.totalVolumeUsdc).toBe("0.002000");
    expect(response.body.successRate).toBe(100);
  });

  it("successRateByChain returns null for chains with no payments", async () => {
    // Only a Solana payment — EVM/NEAR/intents should be null
    settled(store, { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" });

    const { createStatsRouter: mkRouter } =
      await import("../src/routes/stats.route");
    const router = mkRouter(new Date());
    const testApp = express();
    testApp.use(express.json());
    testApp.use(router);

    const response = await get(testApp, "/stats");

    expect(response.status).toBe(200);
    const src = response.body.successRateByChain;
    expect(src["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]).toBe(100);
    expect(src["eip155:8453"]).toBeNull();
    expect(src["near:mainnet"]).toBeNull();
    expect(src["intents:near"]).toBeNull();
  });

  it("excludes testnet transactions from public and merchant-scoped stats", async () => {
    store.setMerchant({
      merchantId: "mainnet-merchant",
      settlementChain: "solana",
      settlementAsset: "USDC",
      payTo: { "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "mainnet-payto" },
      creditBalance: "0",
      dailyGasBudget: "0",
      apiKey: "mainnet-merchant-key",
    });
    settled(store, {
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      amount: "1000",
      merchantId: "mainnet-merchant",
      payTo: "mainnet-payto",
    });
    settled(store, {
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      amount: "9000000",
      merchantId: "mainnet-merchant",
      payTo: "mainnet-payto",
    });
    settled(store, {
      network: "eip155:84532",
      amount: "8000000",
      merchantId: "mainnet-merchant",
      payTo: "mainnet-payto",
    });
    settled(store, {
      network: "near:testnet",
      amount: "7000000",
      merchantId: "mainnet-merchant",
      payTo: "mainnet-payto",
    });

    const app = express();
    app.use(createStatsRouter(new Date()));
    const publicResponse = await get(app, "/stats");
    const merchantResponse = await get(
      app,
      "/stats?merchantId=mainnet-merchant",
      { "X-API-Key": "mainnet-merchant-key" },
    );

    for (const response of [publicResponse, merchantResponse]) {
      expect(response.status).toBe(200);
      expect(response.body.totalPayments).toBe(1);
      expect(response.body.totalVolumeUsdc).toBe("0.001000");
      expect(response.body.successRateByChain["solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"]).toBeUndefined();
      expect(response.body.successRateByChain["eip155:84532"]).toBeUndefined();
      expect(response.body.successRateByChain["near:testnet"]).toBeUndefined();
      expect(response.body.volumeByChainUsdc["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]).toBe("0.001000");
    }
  });

  it("volumeByChainUsdc sums only settled amounts per chain", async () => {
    settled(store, {
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      amount: "1000",
    });
    settled(store, {
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      amount: "2000",
    });
    // A failed payment on EVM — should NOT appear in volumeByChainUsdc
    failed(store, { network: "eip155:8453", amount: "5000000" });

    const { createStatsRouter: mkRouter } =
      await import("../src/routes/stats.route");
    const router = mkRouter(new Date());
    const testApp = express();
    testApp.use(express.json());
    testApp.use(router);

    const response = await get(testApp, "/stats");

    expect(response.status).toBe(200);
    const vol = response.body.volumeByChainUsdc;
    // 1000 + 2000 = 3000 base units = 0.003000 USDC
    expect(vol["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]).toBe("0.003000");
    // EVM had no settled amounts → absent
    expect(vol["eip155:8453"]).toBeUndefined();
  });

  it("caches the result and returns same response within TTL", async () => {
    settled(store);

    let callCount = 0;
    getPaymentStoreMock.mockImplementation(() => {
      callCount++;
      return store;
    });

    const { createStatsRouter: mkRouter } =
      await import("../src/routes/stats.route");
    const router = mkRouter(new Date());
    const testApp = express();
    testApp.use(express.json());
    testApp.use(router);

    // First request
    const r1 = await get(testApp, "/stats");
    const firstCallCount = callCount;

    // Second request immediately — should hit cache (callCount shouldn't increase by much)
    const r2 = await get(testApp, "/stats");

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // Both responses should have the same totalPayments
    expect(r1.body.totalPayments).toBe(r2.body.totalPayments);
    // The second call reuses the cached path — getPaymentStore is called the same number of times
    expect(callCount).toBe(firstCallCount); // no extra DB call on cache hit
  });
});
