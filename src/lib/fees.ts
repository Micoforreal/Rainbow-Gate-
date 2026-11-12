/**
 * fees.ts — rainbowGate fee calculation and merchant credit balance management
 *
 * Rule: Each settlement costs the network's on-chain gas plus a 30% margin on that gas ONLY.
 * Never 30% of transaction value.
 * Fee comes out of the merchant's prepaid credit balance.
 * Testnet settlements are free.
 */

import { getPaymentStore } from "./payments";
import { isTestnet } from "../config";

export interface FeeCalculation {
  isTestnet: boolean;
  estimatedGasCost: bigint; // in native base units
  gasMargin30Pct: bigint;
  totalFeeToMerchant: bigint; // 0 on testnet
}

export function calculateGasFee(
  network: string,
  actualGasUsedOrLimit: bigint,
  gasPriceOrPriorityFee: bigint,
): FeeCalculation {
  if (isTestnet) {
    return {
      isTestnet: true,
      estimatedGasCost: 0n,
      gasMargin30Pct: 0n,
      totalFeeToMerchant: 0n,
    };
  }

  const estimatedGasCost = actualGasUsedOrLimit * gasPriceOrPriorityFee;
  // 30% margin on gas only
  const gasMargin30Pct = (estimatedGasCost * 30n) / 100n;
  const totalFeeToMerchant = estimatedGasCost + gasMargin30Pct;

  return {
    isTestnet: false,
    estimatedGasCost,
    gasMargin30Pct,
    totalFeeToMerchant,
  };
}

// Solana specific caps
export const SOLANA_DEFAULTS = {
  COMPUTE_UNITS_LIMIT: 400_000,
  MIN_MICROLAMPORTS: 50_000,
  MAX_MICROLAMPORTS: 5_000_000,
};

/**
 * Validates merchant credit and daily gas spend before broadcasting transaction.
 * Fails closed on mainnet if merchant credit is insufficient or gas budget is exceeded.
 */
export function checkMerchantCreditAndGasBudget(
  network: string,
  merchantId: string,
  keyId: string,
  estimatedGasUnits: bigint,
  gasPrice: bigint,
): { allowed: boolean; reason?: string; fee: FeeCalculation } {
  const fee = calculateGasFee(network, estimatedGasUnits, gasPrice);

  if (fee.isTestnet) {
    return { allowed: true, fee };
  }

  const store = getPaymentStore();
  const merchant = store.getMerchant(merchantId);

  // If on mainnet and merchant has no prepaid credit record or insufficient balance:
  if (!merchant) {
    return {
      allowed: false,
      reason: `Merchant ${merchantId} has no registered credit balance on mainnet`,
      fee,
    };
  }

  const creditBalance = BigInt(merchant.creditBalance);
  if (creditBalance < fee.totalFeeToMerchant) {
    return {
      allowed: false,
      reason: `Insufficient merchant credit on mainnet: required ${fee.totalFeeToMerchant}, balance ${creditBalance}`,
      fee,
    };
  }

  // Enforce daily gas budget
  const maxBudget = BigInt(merchant.dailyGasBudget || "1000000000000000000"); // default budget
  const spendAllowed = store.recordGasSpend(
    keyId,
    fee.estimatedGasCost,
    maxBudget,
  );
  if (!spendAllowed) {
    return {
      allowed: false,
      reason: `Daily gas spend budget exceeded for relayer/fee-payer ${keyId}`,
      fee,
    };
  }

  return { allowed: true, fee };
}
