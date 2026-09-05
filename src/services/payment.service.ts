import type { X402VerifierDriver } from '../drivers/driver.interface.js';
import type { PaymentPayload } from '../types/x402.types.js';
import type { VerifyResult } from '../types/driver.types.js';

export async function verifyPayment(
  driver: X402VerifierDriver,
  payload: PaymentPayload,
): Promise<VerifyResult> {
  return driver.verify(payload);
}
