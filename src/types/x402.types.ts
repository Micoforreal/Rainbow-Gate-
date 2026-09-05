import { z } from 'zod';

// --- Sub-schemas ---

const PriceSchema = z.object({
  amount: z.string().min(1),          // e.g. "10000" — kept as string per spec
  asset: z.literal('BTC'),
});

const RequirementsSchema = z.object({
  scheme:   z.literal('exact'),
  network:  z.string().min(1),        // e.g. "arch:testnet"
  payTo:    z.string().min(1),        // merchant Bitcoin taproot address (bc1p...)
  price:    PriceSchema,
  resource: z.string().url(),         // the protected resource URL
});

const AccountMetaSchema = z.object({
  pubkey:      z.string().min(1),     // Bitcoin taproot address or base58 pubkey
  is_signer:   z.boolean(),
  is_writable: z.boolean(),
});

const InstructionSchema = z.object({
  program_id: z.string().min(1),      // system program or APL token program id
  accounts:   z.array(AccountMetaSchema),
  data:       z.array(z.number()),    // byte array, e.g. [15, 16, 17, 18]
});

const MessageObjSchema = z.object({
  signers:           z.array(z.string().min(1)), // array of payer taproot addresses
  instructions:      z.array(InstructionSchema),
  recent_blockhash:  z.string().min(1),          // base58-encoded recent blockhash
});

// --- Root payload schema (base64 decoded → JSON parsed → validated) ---

export const PaymentPayloadSchema = z.object({
  requirements:  RequirementsSchema,
  payerAddress:  z.string().min(1),   // payer Bitcoin taproot address (bc1p...)
  signature:     z.string().min(1),   // base64-encoded client wallet signature
  messageObj:    MessageObjSchema,
});

export type PaymentPayload = z.infer<typeof PaymentPayloadSchema>;
