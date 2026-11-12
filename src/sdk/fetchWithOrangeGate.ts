/**
 * fetchWithRainbowGate.ts — Route Selection Engine & Unified Client
 *
 * Implements Architecture C (multi-rail exact facilitator) + Architecture A (1Click Intents swap).
 * The user NEVER picks a chain. The engine evaluates the wallet and chooses:
 * - Direct x402 exact settlement (if payer already holds USDC on merchant's chain)
 * - 1Click swap (if payer holds native asset or USDC on a different chain)
 *
 * NOTE: This module implements route selection and pricing previews.
 */

import {
  OneClickHandler,
  type OneClickQuoteResponse,
} from "../handlers/oneclick";
import { SLIPPAGE_TOLERANCE_DEFAULT_BPS } from "../lib/pricing";
import { activeAssets, activeOneClickAssets } from "../config";

export type SupportedChain = "base" | "solana" | "near" | "bitcoin";
export type WalletType = "metamask" | "phantom" | "near-wallet" | "btc-wallet";
export type RouteType = "DIRECT" | "SWAP_1CLICK" | "NONE";

export interface WalletAssetBalance {
  asset: string; // "USDC", "SOL", "NEAR", "BTC"
  chain: SupportedChain;
  amount: bigint;
  decimals: number;
}

export interface WalletContext {
  walletType: WalletType;
  address: string;
  balances: WalletAssetBalance[];
}

export interface RouteDecision {
  routeType: RouteType;
  originChain?: SupportedChain;
  originAsset?: string;
  destinationChain?: SupportedChain;
  destinationAsset?: string;
  allInPriceFormatted: string;
  estimatedTime: string;
  refundPolicy?: string;
  quote?: OneClickQuoteResponse;
  error?: string;
}

export interface PaymentRequiredHeader {
  x402Version: number;
  accepts: Array<{
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    extra?: Record<string, any>;
  }>;
}

/**
 * 1Click Canonical Token Mapping (from live GET /v0/tokens)
 */
export const ONECLICK_TOKEN_IDS: Record<string, string> =
  activeOneClickAssets.tokens;

export class RainbowGateClient {
  private oneClick: OneClickHandler;

  constructor(oneClickHandler?: OneClickHandler) {
    // CRITICAL: Production default must NOT be mock. Mock is strictly explicit.
    this.oneClick = oneClickHandler ?? new OneClickHandler();
  }

  /**
   * Translates network string to internal canonical chain identifier.
   * Fail-closed: Returns null for unknown networks (no silent fallback).
   */
  public parseChain(network: string): SupportedChain | null {
    if (network === activeAssets.base.network) return "base";
    if (network.startsWith("solana:")) return "solana";
    if (network.startsWith("near:")) return "near";
    if (network.startsWith("btc:")) return "bitcoin";
    return null;
  }

  /**
   * Resolves origin asset to 1Click token ID
   */
  private resolveOrigin1ClickAsset(
    chain: SupportedChain,
    asset: string,
  ): string {
    const sym = asset.toUpperCase();
    if (sym === "BTC") return ONECLICK_TOKEN_IDS.BTC ?? "";
    if (sym === "SOL") return ONECLICK_TOKEN_IDS.SOL ?? "";
    if (sym === "NEAR" || sym === "WNEAR") return ONECLICK_TOKEN_IDS.NEAR ?? "";
    if (sym === "USDC") {
      if (chain === "base") return ONECLICK_TOKEN_IDS.USDC_BASE ?? "";
      if (chain === "solana") return ONECLICK_TOKEN_IDS.USDC_SOLANA ?? "";
      if (chain === "near") return ONECLICK_TOKEN_IDS.USDC_NEAR ?? "";
    }
    return `${chain}:${asset}`;
  }

  /**
   * Resolves destination USDC to 1Click token ID
   */
  private resolveDestination1ClickAsset(merchantChain: SupportedChain): string {
    if (merchantChain === "base") return ONECLICK_TOKEN_IDS.USDC_BASE ?? "";
    if (merchantChain === "solana") return ONECLICK_TOKEN_IDS.USDC_SOLANA ?? "";
    if (merchantChain === "near") return ONECLICK_TOKEN_IDS.USDC_NEAR ?? "";
    return ONECLICK_TOKEN_IDS.USDC_NEAR ?? "";
  }

  /**
   * The Heart of the Product: Unified Route Determination
   * Asks: Is payer asset already USDC on merchant's chain?
   * If yes -> Direct settlement (~0.4 - 2s)
   * If no  -> 1Click swap leg
   */
  public async selectRoute(
    wallet: WalletContext,
    paymentRequired: PaymentRequiredHeader,
    preferredMerchantChain?: SupportedChain,
  ): Promise<RouteDecision> {
    // 1. Identify merchant's required payment options
    const acceptedOptions = paymentRequired.accepts;
    if (!acceptedOptions || acceptedOptions.length === 0) {
      return {
        routeType: "NONE",
        allInPriceFormatted: "N/A",
        estimatedTime: "0s",
        error: "No payment requirements provided by merchant",
      };
    }

    // Pick target accept option
    let targetAccept = acceptedOptions[0];
    if (preferredMerchantChain) {
      const matched = acceptedOptions.find(
        (a) => this.parseChain(a.network) === preferredMerchantChain,
      );
      if (matched) targetAccept = matched;
    }

    const merchantChain = this.parseChain(targetAccept.network);
    if (!merchantChain) {
      return {
        routeType: "NONE",
        allInPriceFormatted: "N/A",
        estimatedTime: "0s",
        error: `Unknown merchant network: ${targetAccept.network}. No route possible.`,
      };
    }

    const requiredAmount = BigInt(targetAccept.amount);

    // 2. Direct settlement check: Does payer hold sufficient USDC on the merchant's exact chain?
    const directUsdcBalance = wallet.balances.find(
      (b) =>
        b.chain === merchantChain &&
        b.asset === "USDC" &&
        b.amount >= requiredAmount,
    );

    if (directUsdcBalance) {
      const times: Record<SupportedChain, string> = {
        base: "~2 seconds",
        solana: "~0.4–2 seconds",
        near: "~1–2 seconds",
        bitcoin: "~20 seconds",
      };

      return {
        routeType: "DIRECT",
        originChain: merchantChain,
        originAsset: "USDC",
        destinationChain: merchantChain,
        destinationAsset: "USDC",
        allInPriceFormatted: `$${(Number(requiredAmount) / 1e6).toFixed(2)}`,
        estimatedTime: times[merchantChain] ?? "~2 seconds",
      };
    }

    // 3. Swap route selection
    // Find what asset the wallet actually holds to spend:
    // Check coverage: The chosen asset must have sufficient balance
    const alternateUsdc = wallet.balances.find(
      (b) => b.asset === "USDC" && b.amount >= requiredAmount,
    );
    const nativeSol = wallet.balances.find(
      (b) => b.asset === "SOL" && b.amount > 0n,
    );
    const nativeNear = wallet.balances.find(
      (b) => b.asset === "NEAR" && b.amount > 0n,
    );
    const nativeBtc = wallet.balances.find(
      (b) => b.asset === "BTC" && b.amount > 0n,
    );

    let spendAsset: WalletAssetBalance | undefined;
    if (alternateUsdc) {
      spendAsset = alternateUsdc;
    } else if (wallet.walletType === "phantom" && nativeSol) {
      spendAsset = nativeSol;
    } else if (wallet.walletType === "near-wallet" && nativeNear) {
      spendAsset = nativeNear;
    } else if (wallet.walletType === "btc-wallet" && nativeBtc) {
      spendAsset = nativeBtc;
    }

    // If no balance covers the amount, return no route plainly
    if (!spendAsset) {
      return {
        routeType: "NONE",
        allInPriceFormatted: "N/A",
        estimatedTime: "N/A",
        error:
          "No route for this payment (insufficient balance across all wallet assets)",
      };
    }

    const origin1ClickToken = this.resolveOrigin1ClickAsset(
      spendAsset.chain,
      spendAsset.asset,
    );
    const destination1ClickToken =
      this.resolveDestination1ClickAsset(merchantChain);

    // Quote the required amount, NOT the full balance
    const quoteReq = {
      dry: true,
      swapType: "EXACT_OUTPUT" as const,
      originAsset: origin1ClickToken,
      destinationAsset: destination1ClickToken,
      amount: requiredAmount.toString(), // Quotes the exact required payment amount
      recipient: targetAccept.payTo,
      refundTo: wallet.address,
      slippageTolerance: SLIPPAGE_TOLERANCE_DEFAULT_BPS,
    };

    let quote: OneClickQuoteResponse;
    try {
      quote = await this.oneClick.getQuote(quoteReq);
    } catch (err: any) {
      return {
        routeType: "NONE",
        allInPriceFormatted: "N/A",
        estimatedTime: "N/A",
        error: `1Click quote request failed: ${err.message}`,
      };
    }

    if (!quote.routeFound) {
      return {
        routeType: "NONE",
        allInPriceFormatted: "N/A",
        estimatedTime: "N/A",
        error: quote.error ?? "No route for this payment",
      };
    }

    const swapTimes: Record<string, string> = {
      SOL: "~1 minute",
      NEAR: "~1 minute",
      BTC: "~15–60 minutes",
      USDC: "~2–5 minutes",
    };

    return {
      routeType: "SWAP_1CLICK",
      originChain: spendAsset.chain,
      originAsset: spendAsset.asset,
      destinationChain: merchantChain,
      destinationAsset: "USDC",
      allInPriceFormatted: `$${(Number(requiredAmount) / 1e6).toFixed(2)} (via 1Click swap)`,
      estimatedTime: swapTimes[spendAsset.asset] ?? "~2 minutes",
      refundPolicy: `If the swap fails or expires, funds are automatically refunded to ${wallet.address} minus refund fee of ${quote.refundFee ?? "standard network fee"}.`,
      quote,
    };
  }
}

export { RainbowGateClient as OrangeGateClient };
