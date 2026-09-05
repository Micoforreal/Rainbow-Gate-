import type { PaymentPayload } from '../types/x402.types.js';
import type { VerifyResult, SettleResult } from '../types/driver.types.js';

export interface X402VerifierDriver {
  /**
   * Read-only, idempotent verification against the chain.
   * Must produce NO on-chain side effects.
   */
  verify(payload: PaymentPayload): Promise<VerifyResult>;

  /**
   * Phase 2 — settle the payment on-chain.
   * Kept in interface for completeness; not called in Phase 1.
   */
  settle(payload: PaymentPayload): Promise<SettleResult>;
}
