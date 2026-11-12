export interface VerifyResult {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface SettleResult {
  success: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  errorReason?: string;
}

export interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
  asset?: string;
  methods?: string[];
}

export interface SupportedResponse {
  x402Version: number;
  kinds: SupportedKind[];
  extensions?: string[];
  signers?: Record<string, string[]>;
}

export type PaymentStatus =
  | "PENDING_DEPOSIT"
  | "PROCESSING"
  | "SUCCESS"
  | "FAILED"
  | "REFUNDED"
  | "pending"
  | "verified"
  | "settled"
  | "failed"
  | "refunded";

export interface FeeBreakdown {
  gas: string;
  gasMargin30Pct: string;
  oneClickFee: string;
  totalFee: string;
}

export type FailureKind =
  | "BEFORE_MONEY_MOVED"
  | "AFTER_1CLICK_DEPOSIT"
  | "SETTLED_RESOURCE_NOT_DELIVERED";

export interface PaymentEvent {
  id?: number;
  paymentId: string;
  oldStatus: string | null;
  newStatus: string;
  reason?: string | null;
  createdAt: string;
}

export interface PaymentRecord {
  paymentId: string;
  network: string;
  scheme: string;
  payer: string;
  payTo: string;
  asset: string;
  amount: string; // BigInt as string — never float
  status: PaymentStatus;
  txHash?: string;
  quoteId?: string;
  depositAddress?: string;
  refundTo?: string;
  createdAt: string;
  verifiedAt?: string;
  settledAt?: string;
  invalidReason?: string;
  // Enriched fields:
  merchantId?: string;
  feeBreakdown?: FeeBreakdown;
  explorerUrl?: string;
  failureReason?: string;
  failureKind?: FailureKind;
  parentPaymentId?: string;
  attemptNumber?: number;
  refundTxHash?: string;
  refundAmount?: string;
  refundAt?: string;
  userId?: string | null;
  subscriptionId?: string | null;
  updatedAt?: string;
}

export interface UserRecord {
  id: string;
  primaryWalletAddress: string;
  primaryChain: string;
  email: string | null;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserWalletRecord {
  id: string;
  userId: string;
  chain: string;
  walletAddress: string;
  verifiedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface MerchantAccept {
  chain: string;
  asset: string;
  payTo: string;
}

export interface MerchantAccountRecord {
  id: string;
  userId: string | null;
  name: string;
  email: string | null;
  webhookUrl: string | null;
  accepts: MerchantAccept[];
  creditBalanceUsdc: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKeyRecord {
  id: string;
  merchantId: string;
  keyPrefix: string;
  name: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface MerchantConfig {
  merchantId: string;
  settlementChain: "base" | "solana" | "near";
  settlementAsset: "USDC";
  payTo: Record<string, string>; // network -> address
  creditBalance: string; // lamports or wei or micro-USD as bigint string
  dailyGasBudget: string;
  apiKey?: string;
  webhookUrl?: string;
}

export type SubscriptionInterval = "weekly" | "monthly";
export type SubscriptionStatus =
  | "active"
  | "past_due"
  | "cancelled"
  | "ended"
  | "paused";

export interface SubscriptionRecord {
  id: string;
  userId?: string | null;
  merchantId: string;
  payer: string; // wallet address
  chain: string;
  asset: string;
  amount: string;
  interval: SubscriptionInterval;
  nextChargeAt: string;
  expiresAt: string | null;
  maxCharges?: number | null;
  chargesUsed: number;
  status: SubscriptionStatus;
  createdAt: string;
  updatedAt: string;
  firstPaymentId?: string;
  lastPaymentId?: string;
  latestPaymentId?: string;
  pausedAt?: string;
  cancelledAt?: string;
  failureCount: number;
  lastAttemptAt?: string;
  pendingPaymentPayload?: string;
}

export interface NetworkHandler {
  readonly networkId: string | RegExp;
  readonly scheme: string;
  verify(payload: any, requirements: any): Promise<VerifyResult>;
  settle(payload: any, requirements: any): Promise<SettleResult>;
  supportsNetwork(network: string): boolean;
  getSupportedKinds?: (isTestnet: boolean) => SupportedKind[];
}
