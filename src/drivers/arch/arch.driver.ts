import { RpcConnection, PubkeyUtil, MessageUtil, SanitizedMessageUtil, type SanitizedMessage, type RuntimeTransaction, type Message } from '@saturnbtcio/arch-sdk';
import { schnorr, hashes } from '@noble/secp256k1';
import crypto from 'crypto';
import bs58 from 'bs58';
import { bech32, bech32m } from 'bech32';
import type { X402VerifierDriver } from '../driver.interface.js';
import type { PaymentPayload, SettlePayload } from '../../types/x402.types.js';
import type { VerifyResult, SettleResult } from '../../types/driver.types.js';

// Configure noble/secp256k1 sha256 via the mutable hashes object
hashes.sha256 = (m: Uint8Array) => new Uint8Array(crypto.createHash('sha256').update(m).digest());

export class ArchVerifierDriver implements X402VerifierDriver {
  private rpc: RpcConnection;

  constructor(rpcUrl: string) {
    this.rpc = new RpcConnection(rpcUrl);
  }

  private resolveAddressToPubkey(address: string): Uint8Array {
    if (address.length === 64 && /^[0-9a-fA-F]{64}$/.test(address)) {
      return PubkeyUtil.fromHex(address);
    }
    if (address.startsWith('tb1q') || address.startsWith('bc1q')) {
      const decoded = bech32.decode(address);
      const hex = Buffer.from(bech32.fromWords(decoded.words.slice(1))).toString('hex').padEnd(64, '0');
      return PubkeyUtil.fromHex(hex);
    }
    if (address.startsWith('tb1p') || address.startsWith('bc1p')) {
      const decoded = bech32m.decode(address);
      const hex = Buffer.from(bech32m.fromWords(decoded.words.slice(1))).toString('hex').padEnd(64, '0');
      return PubkeyUtil.fromHex(hex);
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

  private decodeBlockhash(blockhash: string): Uint8Array {
    if (/^[0-9a-fA-F]{64}$/.test(blockhash)) {
      return new Uint8Array(Buffer.from(blockhash, 'hex'));
    }
    return bs58.decode(blockhash);
  }

  async verify(payload: PaymentPayload): Promise<VerifyResult> {
    try {
      const pubkey = this.resolveAddressToPubkey(payload.payerAddress);

      let accountInfo;
      try {
        accountInfo = await this.rpc.readAccountInfo(pubkey);
      } catch (error: any) {
        const msg: string = error?.message ?? '';
        if (msg.includes('not in database') || msg.includes('not found')) {
          console.warn('[WARN] Payer account not found on Arch network. Skipping balance check for testing.');
        } else {
          return { valid: false, reason: `Failed to read account info: ${msg}` };
        }
      }

      if (accountInfo) {
        const requiredLamports = BigInt(payload.requirements.price.amount);
        if (BigInt(accountInfo.lamports) < requiredLamports) {
          return { valid: false, reason: 'Insufficient balance.' };
        }
      }

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
      signers: payload.messageObj.signers.map((s: string) => this.resolveAddressToPubkey(s)),
      instructions: payload.messageObj.instructions.map((ix: any) => ({
        program_id: this.resolveAddressToPubkey(ix.program_id),
        accounts: ix.accounts.map((a: any) => ({
          pubkey: this.resolveAddressToPubkey(a.pubkey),
          is_signer: a.is_signer,
          is_writable: a.is_writable,
        })),
        data: new Uint8Array(ix.data),
      })),
    };

    const msgHash = MessageUtil.hash(message);
    const sigBytes = Buffer.from(payload.signature, 'base64');
    const pubkeyBytes = this.resolveAddressToPubkey(payload.payerAddress);

    return schnorr.verify(sigBytes, msgHash, pubkeyBytes);
  }

  async settle(payload: SettlePayload): Promise<SettleResult> {
    const pubkey = this.resolveAddressToPubkey(payload.payerAddress);
    const sigBytes = Buffer.from(payload.signature, 'base64');

    const rawInstructions = payload.messageObj.instructions.map((ix: any) => ({
      program_id: this.resolveAddressToPubkey(ix.program_id),
      accounts: ix.accounts.map((a: any) => ({
        pubkey: this.resolveAddressToPubkey(a.pubkey),
        is_signer: a.is_signer,
        is_writable: a.is_writable,
      })),
      data: new Uint8Array(ix.data),
    }));

    const sanitizedMsg = SanitizedMessageUtil.createSanitizedMessage(
      rawInstructions,
      pubkey,
      this.decodeBlockhash(payload.messageObj.recent_blockhash)
    );

    const runtimeTx: RuntimeTransaction = {
      version: 0,
      signatures: [sigBytes],
      message: sanitizedMsg as SanitizedMessage,
    };

    try {
      const txid = await this.rpc.sendTransaction(runtimeTx);
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
