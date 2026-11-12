import { ORACLE_API_URL } from "../config";
/**
 * pricing.ts — 1Click executable quote pricing with oracle sanity band check
 *
 * Direct USDC leg: Price is accepts[] amount. No FX.
 * Swap leg: 1Click quote is executable price (amountIn in sats/lamports/yoctoNEAR, amountOut in USDC).
 * Sanity band: ±2% against reference oracle. Refuse if quote breaks it.
 */

export interface PriceCheckResult {
  valid: boolean;
  reason?: string;
  divergencePct?: number;
}

export const SLIPPAGE_TOLERANCE_DEFAULT_BPS = 100; // 100 bps = 1%

/**
 * Computes price in USD for 1 unit of origin asset based on amountIn and amountOut
 * For example, swapping 1 SOL (1e9 lamports) for 180 USDC (180e6 units) -> 180 USD/SOL
 */
export function computeQuotePriceUSD(
  amountIn: string,
  amountOut: string,
  inDecimals: number,
  outDecimals = 6,
): number {
  const inUnits = Number(amountIn) / 10 ** inDecimals;
  const outUnits = Number(amountOut) / 10 ** outDecimals;
  if (inUnits <= 0) return 0;
  return outUnits / inUnits;
}

/**
 * Validates 1Click quote price against an oracle reference price.
 * @param quotePriceUSD Computed price in USD from quote
 * @param oraclePriceUSD Reference price from oracle (Pyth, CoinGecko, etc.)
 * @param maxDivergencePct Maximum acceptable divergence (default 2%)
 */
export function checkOracleSanityBand(
  quotePriceUSD: number,
  oraclePriceUSD: number,
  maxDivergencePct = 2.0,
): PriceCheckResult {
  if (oraclePriceUSD <= 0 || quotePriceUSD <= 0) {
    return {
      valid: false,
      reason: "Invalid non-positive price for oracle sanity check",
    };
  }

  const diff = Math.abs(quotePriceUSD - oraclePriceUSD);
  const divergencePct = (diff / oraclePriceUSD) * 100;

  if (divergencePct > maxDivergencePct) {
    return {
      valid: false,
      divergencePct,
      reason: `Quote price ${quotePriceUSD.toFixed(4)} deviates from oracle ${oraclePriceUSD.toFixed(4)} by ${divergencePct.toFixed(2)}% (limit: ${maxDivergencePct}%)`,
    };
  }

  return {
    valid: true,
    divergencePct,
  };
}

/**
 * Reference oracle price fetcher.
 * Queries CoinGecko / public price feeds with 2000ms timeout.
 */
export async function fetchReferenceOraclePrice(
  symbol: string,
): Promise<number | null> {
  const normalized = symbol.toUpperCase().replace(/^W/, "");
  const idMap: Record<string, string> = {
    BTC: "bitcoin",
    SOL: "solana",
    NEAR: "near",
    USDC: "usd-coin",
    ETH: "ethereum",
  };
  const id = idMap[normalized];
  if (!id) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${ORACLE_API_URL}?ids=${id}&vs_currencies=usd`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    return data[id]?.usd ?? null;
  } catch {
    return null;
  }
}
