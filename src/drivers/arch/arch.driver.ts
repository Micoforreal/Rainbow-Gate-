import { RpcConnection, PubkeyUtil, MessageUtil, type SanitizedMessage, type RuntimeTransaction, type Message } from '@saturnbtcio/arch-sdk';
import { schnorr } from '@noble/secp256k1';
import bs58 from 'bs58';
import type { X402VerifierDriver } from '../driver.interface.js';
import type { PaymentPayload, SettlePayload } from '../../types/x402.types.js';
import type { VerifyResult, SettleResult } from '../../types/driver.types.js';

export class ArchVerifierDriver implements X402VerifierDriver {
  private rpc: RpcConnection;

  constructor(rpcUrl: string) {
    this.rpc = new RpcConnection(rpcUrl);
  }

  /**
   * Helper to convert a Base58 or Hex string to an Arch Pubkey (32 bytes).
   */
  private resolveAddressToPubkey(address: string): Uint8Array {
    if (address.length === 64 && /^[0-9a-fA-F]{64}$/.test(address)) {
      return PubkeyUtil.fromHex(address);
    }
    try {
      const decoded = bs58.decode(address);
      if (decoded.length !== 32) {
        throw new Error(`Invalid Base58 pubkey length: ${decoded.length}`);
      }
      return decoded;
    } catch (error) {
      throw new Error(`Invalid pubkey format for address: ${address}`);
    }
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
      const isSignatureValid = await this.verifySignature(payload);
      
      if (!isSignatureValid) {
        return { valid: false, reason: 'Invalid signature.' };
      }

      return { valid: true };
    } catch (error: any) {
      return { valid: false, reason: `Verification failed: ${error.message}` };
    }
  }

  private async verifySignature(payload: PaymentPayload): Promise<boolean> {
    const message: Message = {
      signers: payload.messageObj.signers.map(s => this.resolveAddressToPubkey(s)),
      instructions: payload.messageObj.instructions.map(ix => ({
        program_id: PubkeyUtil.fromHex(ix.program_id),
        accounts: ix.accounts.map(a => ({
          pubkey: this.resolveAddressToPubkey(a.pubkey),
          is_signer: a.is_signer,
          is_writable: a.is_writable,
        })),
        data: new Uint8Array(ix.data),
      })),
    };
    
    const msgBytes = MessageUtil.serialize(message);
    const sigBytes = Buffer.from(payload.signature, 'base64');
    const pubkeyBytes = this.resolveAddressToPubkey(payload.payerAddress);

    return schnorr.verify(sigBytes, msgBytes, pubkeyBytes);
  }

  async settle(payload: SettlePayload): Promise<SettleResult> {
    // 1. Reconstruct RuntimeTransaction
    const pubkey = this.resolveAddressToPubkey(payload.payerAddress);
    const sigBytes = Buffer.from(payload.signature, 'base64');

    const sanitizedMsg: SanitizedMessage = {
      header: {
        num_required_signatures: 1,
        num_readonly_signed_accounts: 0,
        num_readonly_unsigned_accounts: 0,
      },
      account_keys: [pubkey, this.resolveAddressToPubkey(payload.requirements.payTo)],
      recent_blockhash: bs58.decode(payload.messageObj.recent_blockhash),
      instructions: payload.messageObj.instructions.map((ix) => ({
        program_id_index: 0, // Assumption based on standard structure
        accounts: ix.accounts.map((_, i) => i), 
        data: new Uint8Array(ix.data),
      })),
    };

    const runtimeTx: RuntimeTransaction = {
      version: 0,
      signatures: [sigBytes],
      message: sanitizedMsg,
    };

    try {
      // 2. Broadcast
      const txid = await this.rpc.sendTransaction(runtimeTx);

      // 3. Poll for confirmation (up to 10 attempts x 2s)
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const processed = await this.rpc.getProcessedTransaction(txid);
        if ((processed as any)?.status?.Processed || (processed as any)?.status === 'Processed') {
          return { txid, status: 'confirmed' };
        }
      }

      return { txid, status: 'submitted' };
    } catch (error: any) {
      console.error('Settle error:', error);
      return { txid: '', status: 'failed' };
    }
  }
}
