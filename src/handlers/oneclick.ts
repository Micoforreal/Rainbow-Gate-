/**
 * oneclick.ts — NEAR Intents / 1Click API Integration
 *
 * Implements:
 * 1. POST /v0/quote with dry: true (preview) and dry: false (commit)
 * 2. GET /v0/status polling (every 5 seconds)
 * 3. GET /v0/tokens querying
 * 4. Verification and settlement tracking with real payout tx hash
 */

import type {
  NetworkHandler,
  VerifyResult,
  SettleResult,
  SupportedKind,
} from "../types/driver.types";
import {
  checkOracleSanityBand,
  computeQuotePriceUSD,
  fetchReferenceOraclePrice,
  SLIPPAGE_TOLERANCE_DEFAULT_BPS,
} from "../lib/pricing";
import { activeOneClickAssets, config, isTestnet } from "../config";

const ONECLICK_FETCH_TIMEOUT_MS = 15_000;

function getAssetMetadata(assetId: string | undefined) {
  if (!assetId) return undefined;
  const entry = Object.entries(activeOneClickAssets.assets).find(
    ([id]) => id.toLowerCase() === assetId.toLowerCase(),
  );
  return entry?.[1];
}

function assetsMatch(left: string, right: string): boolean {
  if (left.startsWith("0x") && right.startsWith("0x")) {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

export interface OneClickQuoteRequest {
  dry: boolean;
  swapType: "EXACT_INPUT" | "EXACT_OUTPUT";
  originAsset: string;
  destinationAsset: string;
  amount: string;
  slippageTolerance?: number; // basis points, e.g. 100 for 1%
  recipient: string;
  recipientType?: string;
  refundTo: string;
  refundType?: string;
  appFees?: number; // in bps
}

export interface OneClickQuoteResponse {
  quoteId?: string;
  depositAddress?: string;
  depositMemo?: string;
  deadline?: string;
  amountIn: string;
  amountOut: string;
  timeEstimateSeconds?: number;
  refundFee?: string;
  routeFound: boolean;
  error?: string;
  dry?: boolean;
  recipient?: string;
  destinationAsset?: string;
  originAsset?: string;
  computedPriceUSD?: number;
  refundTo?: string;
}

export type OneClickSwapStatus =
  | "PENDING_DEPOSIT"
  | "KNOWN_DEPOSIT_TX"
  | "PROCESSING"
  | "SUCCESS"
  | "REFUNDED"
  | "FAILED"
  | "INCOMPLETE_DEPOSIT";

export interface OneClickStatusResult {
  status: OneClickSwapStatus;
  payoutTxHash?: string;
  depositTxHash?: string;
  refundTxHash?: string;
  error?: string;
}

export class OneClickHandler implements NetworkHandler {
  readonly networkId = "intents:near";
  readonly scheme = "exact";

  private apiUrl: string;
  private partnerJwt?: string;
  private mockMode: boolean;

  constructor(apiUrl?: string, partnerJwt?: string | null, mockMode = false) {
    this.apiUrl = apiUrl ?? config.ONECLICK_API_URL;
    this.partnerJwt =
      partnerJwt === null
        ? undefined
        : (partnerJwt ?? config.ONECLICK_PARTNER_JWT);
    // CRITICAL: Mock mode must be explicitly enabled for tests/CI. Never default to mock silently.
    this.mockMode = mockMode;
  }

  public supportsNetwork(network: string): boolean {
    return (
      network.startsWith("intents:") ||
      network === "btc:BTC" ||
      network === "sol:SOL" ||
      network.includes("1click")
    );
  }

  public getSupportedKinds(_isTestnet: boolean): SupportedKind[] {
    // 1Click native Intents scheme is in review upstream; not advertised as direct exact rail
    return [];
  }

  public isMockMode(): boolean {
    return this.mockMode;
  }

  public setMockMode(mock: boolean): void {
    this.mockMode = mock;
  }

  public async getQuote(
    req: OneClickQuoteRequest,
  ): Promise<OneClickQuoteResponse> {
    // Apply default slippage tolerance of 100 bps (1%) if not provided
    const slippage = req.slippageTolerance ?? SLIPPAGE_TOLERANCE_DEFAULT_BPS;
    const deadline =
      (req as any).deadline ??
      new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const finalReq: any = {
      ...req,
      slippageTolerance: slippage,
      deadline,
      depositType: (req as any).depositType ?? "ORIGIN_CHAIN",
      refundType: (req as any).refundType ?? "ORIGIN_CHAIN",
      recipientType: (req as any).recipientType ?? "DESTINATION_CHAIN",
    };

    if (this.mockMode) {
      // Mock quote implementation for explicit CI/tests
      if (finalReq.amount === "0" || finalReq.originAsset === "unknown:TOKEN") {
        return {
          routeFound: false,
          amountIn: "0",
          amountOut: "0",
          error: "No route for this payment",
          dry: finalReq.dry,
        };
      }

      const depositAddress = finalReq.dry
        ? undefined
        : `1click_mock_deposit_${Date.now()}`;
      return {
        quoteId: `quote_${Date.now()}`,
        depositAddress,
        deadline: new Date(Date.now() + 1200 * 1000).toISOString(),
        amountIn: finalReq.amount,
        amountOut: finalReq.amount,
        timeEstimateSeconds: 60,
        refundFee: "1000",
        routeFound: true,
        dry: finalReq.dry,
        recipient: finalReq.recipient,
        destinationAsset: finalReq.destinationAsset,
        originAsset: finalReq.originAsset,
      };
    }

    if (!isTestnet && !this.partnerJwt) {
      throw new Error(
        "[OneClick Handler] ONECLICK_PARTNER_JWT is required for live 1Click quote execution",
      );
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.partnerJwt) {
      headers["X-API-Key"] = this.partnerJwt;
      headers.Authorization = `Bearer ${this.partnerJwt}`;
    }

    try {
      const res = await fetch(`${this.apiUrl}/v0/quote`, {
        method: "POST",
        headers,
        body: JSON.stringify(finalReq),
        signal: AbortSignal.timeout(ONECLICK_FETCH_TIMEOUT_MS),
      });

      if (!res.ok) {
        return {
          routeFound: false,
          amountIn: finalReq.amount,
          amountOut: "0",
          error: `1Click quote HTTP ${res.status}: ${res.statusText}`,
          dry: finalReq.dry,
        };
      }

      const data = (await res.json()) as any;
      const quoteData = data.quote ?? data;
      const routeFound = data.routeFound ?? quoteData.routeFound ?? true;
      return {
        quoteId: data.quoteId ?? data.id,
        depositAddress: quoteData.depositAddress,
        depositMemo: quoteData.depositMemo,
        deadline: quoteData.deadline ?? data.quoteRequest?.deadline,
        amountIn: quoteData.amountIn ?? finalReq.amount,
        amountOut: quoteData.amountOut ?? "0",
        timeEstimateSeconds:
          quoteData.timeEstimateSeconds ?? quoteData.timeEstimate ?? 60,
        refundFee: quoteData.refundFee ?? "0",
        routeFound,
        dry: finalReq.dry,
        recipient: finalReq.recipient,
        refundTo: finalReq.refundTo,
        destinationAsset: finalReq.destinationAsset,
        originAsset: finalReq.originAsset,
      };
    } catch (err: any) {
      return {
        routeFound: false,
        amountIn: finalReq.amount,
        amountOut: "0",
        error: `1Click API call failed: ${err.message}`,
        dry: finalReq.dry,
      };
    }
  }

  public async getStatus(
    depositAddress: string,
  ): Promise<OneClickStatusResult> {
    if (this.mockMode) {
      return {
        status: "SUCCESS",
        payoutTxHash: `mock_payout_tx_${Date.now()}`,
      };
    }

    if (!isTestnet && !this.partnerJwt) {
      throw new Error(
        "[OneClick Handler] ONECLICK_PARTNER_JWT is required for live 1Click status polling",
      );
    }

    const headers: Record<string, string> = {};
    if (this.partnerJwt) {
      headers["X-API-Key"] = this.partnerJwt;
      headers.Authorization = `Bearer ${this.partnerJwt}`;
    }

    const res = await fetch(
      `${this.apiUrl}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`,
      {
        headers,
        signal: AbortSignal.timeout(ONECLICK_FETCH_TIMEOUT_MS),
      },
    );

    if (!res.ok) {
      throw new Error(
        `Failed to query 1Click status: HTTP ${res.status} ${res.statusText}`,
      );
    }

    const data = (await res.json()) as any;
    return {
      status: data.status as OneClickSwapStatus,
      payoutTxHash:
        data.payoutTxHash ??
        data.swapTxHash ??
        data.txHash ??
        data.swapDetails?.destinationChainTxHashes?.[0]?.hash,
      depositTxHash: data.depositTxHash,
      refundTxHash: data.refundTxHash,
      error: data.error,
    };
  }

  public async verify(payload: any, requirements: any): Promise<VerifyResult> {
    try {
      const quote: OneClickQuoteResponse =
        payload.quote ?? payload.payload?.quote;
      if (!quote) {
        return {
          isValid: false,
          invalidReason: "Missing 1Click quote in payment payload",
        };
      }

      // 1. A dry quote must NOT pass verify for a settle
      if (quote.dry === true || !quote.depositAddress) {
        return {
          isValid: false,
          invalidReason:
            "Dry quote cannot be verified for settlement (missing committed depositAddress)",
        };
      }

      // 2. Recipient match: quote recipient must equal requirements.payTo exactly
      if (
        quote.recipient &&
        requirements.payTo &&
        quote.recipient !== requirements.payTo
      ) {
        return {
          isValid: false,
          invalidReason: `Quote recipient ${quote.recipient} does not match required payTo ${requirements.payTo}`,
        };
      }

      // 3. Convert the 1Click NEP-141 destination ID to its native chain asset.
      const destinationEntry = quote.destinationAsset
        ? Object.entries(activeOneClickAssets.destinations).find(
            ([assetId]) =>
              assetId.toLowerCase() === quote.destinationAsset!.toLowerCase(),
          )
        : undefined;
      const nativeDestinationAsset = destinationEntry?.[1];
      if (
        nativeDestinationAsset &&
        requirements.asset &&
        !assetsMatch(nativeDestinationAsset, requirements.asset)
      ) {
        return {
          isValid: false,
          invalidReason: `Quote destination asset ${nativeDestinationAsset} does not match required asset ${requirements.asset}`,
        };
      }

      // 4. Verify deadline
      if (quote.deadline) {
        const deadlineTime = new Date(quote.deadline).getTime();
        if (Date.now() > deadlineTime) {
          return { isValid: false, invalidReason: "1Click quote has expired" };
        }
      }

      // 5. Verify amounts match
      if (requirements.amount && quote.amountOut) {
        const expectedOut = BigInt(requirements.amount);
        const actualOut = BigInt(quote.amountOut);
        if (actualOut < expectedOut) {
          return {
            isValid: false,
            invalidReason: `Quote output ${actualOut} is less than required ${expectedOut}`,
          };
        }
      }

      // 6. Oracle sanity band check (±2%)
      const isMainnet = !isTestnet;
      let referencePrice = payload.oraclePriceUSD;
      const originAssetMetadata = getAssetMetadata(quote.originAsset);

      if (quote.originAsset && !originAssetMetadata) {
        return {
          isValid: false,
          invalidReason: `Unsupported 1Click origin asset ${quote.originAsset ?? "unknown"}`,
        };
      }

      if (!referencePrice && isMainnet && originAssetMetadata) {
        referencePrice = await fetchReferenceOraclePrice(
          originAssetMetadata.symbol,
        );
        if (!referencePrice) {
          // Fail-closed on mainnet when oracle is missing
          return {
            isValid: false,
            invalidReason: `Reference oracle price unavailable for asset ${originAssetMetadata.symbol} on mainnet (fail-closed)`,
          };
        }
      }

      if (referencePrice) {
        const originDecimals = originAssetMetadata?.decimals ?? 6;
        const destinationAssetMetadata = getAssetMetadata(
          quote.destinationAsset,
        );
        const computedPrice = computeQuotePriceUSD(
          quote.amountIn,
          quote.amountOut,
          originDecimals,
          destinationAssetMetadata?.decimals ?? 6,
        );
        const check = checkOracleSanityBand(computedPrice, referencePrice, 2.0);
        if (!check.valid) {
          return { isValid: false, invalidReason: check.reason };
        }
      }

      return { isValid: true, payer: payload.payerAddress ?? quote.refundTo };
    } catch (err: any) {
      return {
        isValid: false,
        invalidReason: `1Click verify failed: ${err.message}`,
      };
    }
  }

  public async settle(payload: any, requirements: any): Promise<SettleResult> {
    try {
      // 1. Re-verify at settle time
      const verifyRes = await this.verify(payload, requirements);
      if (!verifyRes.isValid) {
        return { success: false, errorReason: verifyRes.invalidReason };
      }

      const quote: OneClickQuoteResponse =
        payload.quote ?? payload.payload?.quote;
      const depositAddress = quote.depositAddress!;

      // 2. Compute realistic timeout based on origin asset
      // At least 70 minutes for BTC, at least 10 minutes for SOL/NEAR
      const isBtc = quote.originAsset?.toLowerCase().includes("btc");
      const assetTimeoutMs = this.mockMode
        ? 100
        : isBtc
          ? 70 * 60 * 1000
          : 10 * 60 * 1000;

      let maxWaitMs = assetTimeoutMs;
      if (quote.deadline) {
        const deadlineRemaining =
          new Date(quote.deadline).getTime() - Date.now();
        if (deadlineRemaining > 0 && deadlineRemaining < maxWaitMs) {
          maxWaitMs = deadlineRemaining;
        }
      }

      // Poll every 5 seconds (fast poll in mock mode)
      const pollIntervalMs = this.mockMode ? 10 : 5000;
      const startTime = Date.now();

      let statusResult = await this.getStatus(depositAddress);

      while (
        statusResult.status !== "SUCCESS" &&
        statusResult.status !== "REFUNDED" &&
        statusResult.status !== "FAILED"
      ) {
        const elapsed = Date.now() - startTime;
        if (elapsed > maxWaitMs) {
          // Crucial: Report PROCESSING as still processing, not as failed
          return {
            success: false,
            errorReason: `1Click swap still ${statusResult.status} after ${(elapsed / 1000).toFixed(0)}s (deadline: ${quote.deadline}). Swap is processing on-chain.`,
          };
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        statusResult = await this.getStatus(depositAddress);
      }

      if (statusResult.status === "SUCCESS") {
        // Return REAL payout transaction hash from 1Click status response
        const payoutHash = statusResult.payoutTxHash;
        if (!payoutHash) {
          return {
            success: false,
            errorReason:
              "1Click reported SUCCESS without a payout transaction hash",
          };
        }

        return {
          success: true,
          transaction: payoutHash,
          network: requirements.network,
          payer: verifyRes.payer,
        };
      }

      return {
        success: false,
        errorReason: `1Click swap ended in terminal state: ${statusResult.status}${statusResult.error ? ` (${statusResult.error})` : ""}`,
      };
    } catch (err: any) {
      return {
        success: false,
        errorReason: `1Click settle error: ${err.message}`,
      };
    }
  }
}
