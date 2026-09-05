import { RpcConnection } from '@saturnbtcio/arch-sdk';
import type { X402VerifierDriver } from '../driver.interface.js';
import type { PaymentPayload } from '../../types/x402.types.js';
import type { VerifyResult, SettleResult } from '../../types/driver.types.js';

export class ArchVerifierDriver implements X402VerifierDriver {
  private rpc: RpcConnection;

  constructor(rpcUrl: string) {
    this.rpc = new RpcConnection(rpcUrl);
  }

  /**
   * Helper to convert a Bitcoin taproot address (bc1p...) to an Arch Pubkey (32 bytes).
   * TODO: Implement proper bech32m decoding here or rely on the client to send the hex pubkey.
   * For now, this is a placeholder that returns a dummy 32-byte array to satisfy the type system.
   */
  private resolveAddressToPubkey(address: string): Uint8Array {
    // In a real implementation, you would decode the taproot address (bech32m) to extract the 32-byte x-only pubkey.
    // Or if the client provides the base58/hex pubkey directly in the payload, you would parse it here.
    return new Uint8Array(32); 
  }

  async verify(payload: PaymentPayload): Promise<VerifyResult> {
    try {
      // 1. Resolve payer pubkey
      const pubkey = this.resolveAddressToPubkey(payload.payerAddress);

      // 2. Balance check via Arch RPC
      let accountInfo;
      try {
        accountInfo = await this.rpc.readAccountInfo(pubkey);
      } catch (error) {
        return { valid: false, reason: 'Failed to read account info from Arch network.' };
      }

      if (!accountInfo) {
        return { valid: false, reason: 'Payer account not found on Arch network.' };
      }

      const requiredLamports = BigInt(payload.requirements.price.amount);
      if (BigInt(accountInfo.lamports) < requiredLamports) {
        return { valid: false, reason: 'Insufficient balance.' };
      }

      // 3. Signature validation (off-chain)
      // Verify payload.signature against payload.messageObj using the payer's pubkey.
      // TODO: Implement secp256k1/schnorr signature verification here.
      // This is pure cryptography and does not require an RPC call.
      const isSignatureValid = true; // Placeholder for actual verification logic
      
      if (!isSignatureValid) {
        return { valid: false, reason: 'Invalid signature.' };
      }

      return { valid: true };
    } catch (error: any) {
      return { valid: false, reason: `Verification failed: ${error.message}` };
    }
  }

  async settle(payload: PaymentPayload): Promise<SettleResult> {
    throw new Error('Settle is not implemented in Phase 1.');
  }
}
