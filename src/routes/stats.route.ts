/**
 * stats.route.ts — GET /stats
 *
 * Public (no merchantId): aggregate numbers only, no payer or merchant list.
 * With ?merchantId=<id>: requires X-API-Key that matches that merchantId.
 *
 * Cache TTL: 30 seconds (in-memory, keyed by merchantId or "__global__").
 */

import { Router, type Request, type Response } from "express";
import { getPaymentStore } from "../lib/payments";
import { config, MAINNET_NETWORKS } from "../config";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StatsPayload {
  totalVolumeUsdc: string;
  totalPayments: number;
  successfulPayments: number;
  successRate: number | null;
  paymentsToday: number;
  volumeTodayUsdc: string;
  successRateByChain: Record<string, number | null>;
  volumeByChainUsdc: Record<string, string>;
  lastSettleAt: string | null;
  serverStartedAt: string;
  uptimeSeconds: number;
  environment: string;
}

// ── Cache ─────────────────────────────────────────────────────────────────────

interface CacheEntry {
  payload: StatsPayload;
  expiresAt: number; // Date.now() ms
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();
let nextCacheNamespace = 0;

function getCached(key: string): StatsPayload | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.payload;
}

function setCached(key: string, payload: StatsPayload): void {
  cache.set(key, { payload, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Format a bigint amount (6-decimal USDC base units) as a decimal string.
 * e.g. 1000n → "0.001000"
 */
function formatUsdc(raw: bigint): string {
  const decimals = 6;
  const str = raw.toString().padStart(decimals + 1, "0");
  const intPart = str.slice(0, str.length - decimals) || "0";
  const fracPart = str.slice(str.length - decimals);
  return `${intPart}.${fracPart}`;
}

// The known chains we always want to appear in successRateByChain even with no data
const KNOWN_CHAINS = MAINNET_NETWORKS;
const MAINNET_CHAINS = [...KNOWN_CHAINS];
const MAINNET_NETWORK_FILTER = `network IN (${MAINNET_CHAINS.map(() => "?").join(", ")})`;

// ── Computation ───────────────────────────────────────────────────────────────

function computeStats(
  merchantId: string | null,
  serverStartedAt: Date,
): StatsPayload {
  const store = getPaymentStore();
  const db = (store as any).db as import("better-sqlite3").Database;

  // Build optional WHERE clause for merchant scope
  const merchantFilter = merchantId ? `AND (merchantId = ? OR payTo = ?)` : "";
  const merchantParams: string[] = merchantId ? [merchantId, merchantId] : [];

  // UTC today boundary: "YYYY-MM-DD" prefix on createdAt ISO strings
  const now = new Date();
  const todayUtc = now.toISOString().slice(0, 10); // "2026-11-12"

  // ── 1. Aggregate totals ────────────────────────────────────────────────────
  const totalsRow = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status IN ('settled','SUCCESS') THEN 1 ELSE 0 END) AS successful,
         SUM(CASE WHEN status IN ('settled','SUCCESS') THEN CAST(amount AS INTEGER) ELSE 0 END) AS volumeRaw
       FROM payments
       WHERE ${MAINNET_NETWORK_FILTER} ${merchantFilter}`,
    )
    .get(...MAINNET_CHAINS, ...merchantParams) as {
    total: number;
    successful: number;
    volumeRaw: number | null;
  };

  const totalPayments = Number(totalsRow.total ?? 0);
  const successfulPayments = Number(totalsRow.successful ?? 0);
  const volumeRaw = BigInt(Math.round(totalsRow.volumeRaw ?? 0));
  const totalVolumeUsdc = formatUsdc(volumeRaw);

  const successRate =
    totalPayments === 0
      ? null
      : Math.round((successfulPayments / totalPayments) * 100 * 100) / 100;

  // ── 2. Today ───────────────────────────────────────────────────────────────
  const todayRow = db
    .prepare(
      `SELECT
         COUNT(*) AS cnt,
         SUM(CASE WHEN status IN ('settled','SUCCESS') THEN CAST(amount AS INTEGER) ELSE 0 END) AS volRaw
       FROM payments
       WHERE ${MAINNET_NETWORK_FILTER} AND createdAt >= ? AND createdAt <= ? ${merchantFilter}`,
    )
    .get(
      ...MAINNET_CHAINS,
      todayUtc + "T00:00:00.000Z",
      now.toISOString(),
      ...merchantParams,
    ) as {
    cnt: number;
    volRaw: number | null;
  };

  const paymentsToday = Number(todayRow.cnt ?? 0);
  const volumeTodayUsdc = formatUsdc(BigInt(Math.round(todayRow.volRaw ?? 0)));

  // ── 3. Last settle ─────────────────────────────────────────────────────────
  const lastSettleRow = db
    .prepare(
      `SELECT MAX(settledAt) AS last FROM payments
       WHERE ${MAINNET_NETWORK_FILTER} AND status IN ('settled','SUCCESS') ${merchantFilter}`,
    )
    .get(...MAINNET_CHAINS, ...merchantParams) as { last: string | null };

  const lastSettleAt = lastSettleRow.last ?? null;

  // ── 4. Per-chain breakdown ─────────────────────────────────────────────────
  const chainRows = db
    .prepare(
      `SELECT
         network,
         COUNT(*) AS total,
         SUM(CASE WHEN status IN ('settled','SUCCESS') THEN 1 ELSE 0 END) AS successful,
         SUM(CASE WHEN status IN ('settled','SUCCESS') THEN CAST(amount AS INTEGER) ELSE 0 END) AS volRaw
       FROM payments
       WHERE ${MAINNET_NETWORK_FILTER} ${merchantFilter}
       GROUP BY network`,
    )
    .all(...MAINNET_CHAINS, ...merchantParams) as {
    network: string;
    total: number;
    successful: number;
    volRaw: number | null;
  }[];

  const successRateByChain: Record<string, number | null> = {};
  const volumeByChainUsdc: Record<string, string> = {};

  // Seed known chains with null
  for (const chain of KNOWN_CHAINS) {
    successRateByChain[chain] = null;
  }

  for (const row of chainRows) {
    const chain = row.network;
    const total = Number(row.total ?? 0);
    const successful = Number(row.successful ?? 0);
    const vol = BigInt(Math.round(row.volRaw ?? 0));

    successRateByChain[chain] =
      total === 0 ? null : Math.round((successful / total) * 100 * 100) / 100;

    if (vol > 0n) {
      volumeByChainUsdc[chain] = formatUsdc(vol);
    }
  }

  // ── 5. Uptime ──────────────────────────────────────────────────────────────
  const serverStartedAtIso = serverStartedAt.toISOString();
  const uptimeSeconds = Math.floor(
    (Date.now() - serverStartedAt.getTime()) / 1000,
  );

  return {
    totalVolumeUsdc,
    totalPayments,
    successfulPayments,
    successRate,
    paymentsToday,
    volumeTodayUsdc,
    successRateByChain,
    volumeByChainUsdc,
    lastSettleAt,
    serverStartedAt: serverStartedAtIso,
    uptimeSeconds,
    environment: config.NETWORK_ENVIRONMENT,
  };
}

// ── Route factory ─────────────────────────────────────────────────────────────

export function createStatsRouter(serverStartedAt: Date): Router {
  const router = Router();
  const cacheNamespace = ++nextCacheNamespace;

  /**
   * GET /stats
   *   - No ?merchantId → public, no auth, aggregate.
   *   - ?merchantId=<id> → requires X-API-Key header matching that merchant.
   */
  router.get("/stats", (req: Request, res: Response) => {
    try {
      const merchantId = req.query.merchantId as string | undefined;

      if (merchantId) {
        // ── Authenticated merchant scope ──────────────────────────────────
        const rawKey = req.headers["x-api-key"];
        const apiKey =
          typeof rawKey === "string"
            ? rawKey.trim()
            : Array.isArray(rawKey)
              ? rawKey[0]?.trim()
              : undefined;

        if (!apiKey) {
          res.status(401).json({
            error: "Missing API key",
            code: "UNAUTHORIZED",
            message:
              "X-API-Key header is required when merchantId is specified",
          });
          return;
        }

        const store = getPaymentStore();
        const merchant = store.getMerchantByApiKey(apiKey);

        if (!merchant || merchant.merchantId !== merchantId) {
          res.status(403).json({
            error: "Forbidden",
            code: "FORBIDDEN",
            message: "API key does not match the requested merchantId",
          });
          return;
        }

        const cacheKey = `${cacheNamespace}:merchant:${merchantId}`;
        const cached = getCached(cacheKey);
        if (cached) {
          res.status(200).json(cached);
          return;
        }

        const payload = computeStats(merchantId, serverStartedAt);
        setCached(cacheKey, payload);
        res.status(200).json(payload);
        return;
      }

      // ── Public aggregate (no merchantId) ──────────────────────────────
      const cacheKey = `${cacheNamespace}:__global__`;
      const cached = getCached(cacheKey);
      if (cached) {
        res.status(200).json(cached);
        return;
      }

      const payload = computeStats(null, serverStartedAt);
      setCached(cacheKey, payload);
      res.status(200).json(payload);
    } catch (err: any) {
      console.error("[Stats] Internal error:", err);
      res
        .status(500)
        .json({ error: "Internal server error", message: err.message });
    }
  });

  return router;
}
