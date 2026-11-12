import { z } from 'zod';

export const PriceSchema = z.object({
  amount: z.string().min(1), // atomic units as string (e.g. "1000000" for 1 USDC)
  asset: z.string().min(1),
});

export const PaymentRequirementsSchema = z.object({
  scheme: z.string().min(1),
  network: z.string().min(1),
  amount: z.string().optional(),
  asset: z.string().optional(),
  payTo: z.string().min(1),
  price: PriceSchema.optional(),
  resource: z.string().optional(),
  maxTimeoutSeconds: z.number().optional(),
  paymentId: z.string().optional(),
  merchantId: z.string().optional(),
  extra: z.record(z.string(), z.any()).optional(),
}).passthrough().transform((data) => {
  // Normalize price and amount/asset so both formats are accessible
  const amount = data.amount ?? data.price?.amount ?? '';
  const asset = data.asset ?? data.price?.asset ?? '';
  return {
    ...data,
    amount,
    asset,
    price: { amount, asset },
  };
});

export type PaymentRequirements = z.infer<typeof PaymentRequirementsSchema>;

// EVM Payload
export const EVMAuthorizationSchema = z.object({
  from: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  value: z.string().min(1),
  validAfter: z.union([z.string(), z.number()]).transform((v) => BigInt(v)),
  validBefore: z.union([z.string(), z.number()]).transform((v) => BigInt(v)),
  nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

export const EVMPayloadSchema = z.object({
  signature: z.string().min(1),
  authorization: EVMAuthorizationSchema,
});

// SVM (Solana) Payload
export const SVMPayloadSchema = z.object({
  transaction: z.string().min(1), // Base64 encoded versioned transaction
});

// NEAR NEP-366 Delegate Payload
export const NEARDelegateActionSchema = z.object({
  senderId: z.string().min(1),
  receiverId: z.string().min(1),
  actions: z.array(z.any()),
  nonce: z.union([z.string(), z.number(), z.bigint()]),
  maxBlockHeight: z.union([z.string(), z.number(), z.bigint()]),
  publicKey: z.string().min(1),
});

export const NEARPayloadSchema = z.object({
  signedDelegate: z.object({
    delegateAction: NEARDelegateActionSchema,
    signature: z.string().min(1),
  }).optional(),
  // or flat fields
  delegate: z.any().optional(),
  signature: z.string().optional(),
});

// Unified standard x402 payment payload schema
export const StandardPaymentPayloadSchema = z.object({
  x402Version: z.number().default(2),
  scheme: z.string().default('exact'),
  network: z.string().min(1),
  resource: z.any().optional(),
  accepted: PaymentRequirementsSchema.optional(),
  payload: z.any(),
});

// Facilitator Request Bodies for /verify and /settle
export const VerifyRequestBodySchema = z.object({
  x402Version: z.number().optional().default(2),
  paymentPayload: z.any(),
  paymentRequirements: z.any().optional(),
  paymentId: z.string().optional(),
});

export const SettleRequestBodySchema = VerifyRequestBodySchema;
