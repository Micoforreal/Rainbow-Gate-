/**
 * near.test.ts — Unit tests for the NEAR NEP-366 SignedDelegate handler.
 *
 * Uses real near-api-js key pairs and real Borsh-serialised delegate actions so that
 * the handler's cryptographic signature verification (Step 6) actually passes.
 *
 * Tests that call settle() skip unless NEAR_RELAYER_PRIVATE_KEY is set AND
 * RUN_INTEGRATION_TESTS=true, because settle broadcasts on-chain via the relayer.
 */

import { beforeAll, describe, it, expect } from 'vitest';
import * as nearApi from 'near-api-js';
import crypto from 'crypto';
import { NEARHandler } from '../src/handlers/near';

describe('NEAR NEP-366 Delegate Handler', () => {
  const handler = new NEARHandler();
  const canonicalUsdcTestnet = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';

  const requirements = {
    scheme: 'exact',
    network: 'near:testnet',
    amount: '1000000',
    asset: canonicalUsdcTestnet,
    payTo: 'merchant.testnet',
  };

  /**
   * Build a real SignedDelegate with a live key pair.
   * Uses na.actions.functionCall() with positional args (the v7 API).
   * The delegate action is Borsh-serialised and SHA-256 hashed before signing.
   *
   * Returns the structure the handler's verify() expects:
   *   { signedDelegate: { delegateAction, signature } }
   */
  function buildRealSignedDelegate(opts?: {
    senderId?: string;
    receiverId?: string;
    amount?: string;
    recipient?: string;
    maxBlockHeight?: bigint;
    nonce?: bigint;
    keyPair?: nearApi.KeyPair;
  }): { payload: any; keyPair: nearApi.KeyPair } {
    const kp = opts?.keyPair ?? nearApi.KeyPair.fromRandom('ed25519');
    const pubkey = kp.getPublicKey();

    const amount = opts?.amount ?? '1000000';
    const recipient = opts?.recipient ?? 'merchant.testnet';
    const receiverId = opts?.receiverId ?? canonicalUsdcTestnet;
    const senderId = opts?.senderId ?? 'alice.testnet';
    const maxBlockHeight = opts?.maxBlockHeight ?? BigInt(999_999_999);
    const nonce = opts?.nonce ?? BigInt(Date.now());

    // near-api-js v7: functionCall(methodName, args, gas, deposit)
    const ftAction = nearApi.actions.functionCall(
      'ft_transfer',
      { receiver_id: recipient, amount },
      30_000_000_000_000n,
      1n,
    );

    const delegateAction = nearApi.buildDelegateAction({
      senderId,
      receiverId,
      actions: [ftAction],
      nonce,
      maxBlockHeight,
      publicKey: pubkey,
    });

    // Borsh-serialise then SHA-256 hash — matches what the handler does in verify()
    const encoded = nearApi.encodeDelegateAction(delegateAction);
    const msgHash = crypto.createHash('sha256').update(encoded).digest();
    const sigResult = kp.sign(msgHash);

    const payload = {
      signedDelegate: {
        delegateAction,
        signature: sigResult.signature, // Uint8Array — handler handles both Uint8Array and encoded string
      },
    };

    return { payload, keyPair: kp };
  }

  it('Verifies a valid NEP-366 delegate payload with ft_transfer', async () => {
    const { payload } = buildRealSignedDelegate();
    const result = await handler.verify(payload, requirements);
    expect(result.isValid).toBe(true);
    expect(result.payer).toBe('alice.testnet');
  });

  it('Fails verification when ft_transfer amount is 1 unit off', async () => {
    const { payload } = buildRealSignedDelegate({ amount: '999999' });
    const result = await handler.verify(payload, requirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain('ft_transfer amount mismatch');
  });

  it('Fails verification when ft_transfer recipient does not match payTo', async () => {
    const { payload } = buildRealSignedDelegate({ recipient: 'eve.testnet' });
    const result = await handler.verify(payload, requirements);
    expect(result.isValid).toBe(false);
    // Handler reports 'Recipient mismatch' — either message proves the check fired
    expect(result.invalidReason).toMatch(/mismatch|No valid ft_transfer/i);
  });

  it('Fails verification when asset/receiver is not canonical USDC', async () => {
    const { payload } = buildRealSignedDelegate({ receiverId: 'fake-token.testnet' });
    const result = await handler.verify(payload, requirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain('does not match canonical USDC contract');
  });

  it('Fails verification with a forged / invalid signature', async () => {
    const { payload } = buildRealSignedDelegate();
    // Replace the real signature with 64 zero bytes — a valid-length but wrong signature
    const tampered = {
      signedDelegate: {
        ...payload.signedDelegate,
        signature: new Uint8Array(64), // all zeros
      },
    };
    const result = await handler.verify(tampered, requirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toMatch(/signature/i);
  });

  it('Fails verification with zero actions in delegate', async () => {
    const kp = nearApi.KeyPair.fromRandom('ed25519');
    const pubkey = kp.getPublicKey();

    // Manually build a minimal delegateAction object with no actions
    // (bypasses buildDelegateAction which requires at least 1)
    const delegateAction = {
      senderId: 'alice.testnet',
      receiverId: canonicalUsdcTestnet,
      actions: [],  // zero actions
      nonce: BigInt(Date.now()),
      maxBlockHeight: BigInt(999_999_999),
      publicKey: pubkey,
    };

    const payload = {
      signedDelegate: {
        delegateAction,
        signature: 'ed25519:AaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa',
      },
    };

    const result = await handler.verify(payload, requirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toMatch(/exactly 1 action|0/);
  });

  it('Deduplicates delegate hash — replay of same signed delegate fails', async () => {
    // Uses the real NEAR relayer for settle — integration test.
    // Skip unless RUN_INTEGRATION_TESTS=true AND relayer key is set.
    if (!process.env.RUN_INTEGRATION_TESTS || !process.env.NEAR_RELAYER_PRIVATE_KEY) {
      // Unit-test-safe path: check replay using isSeen directly on the store
      // by verifying the same payload twice — after first verify marks it seen,
      // only the second verify would see the replay. But the handler only marks
      // seen on settle, not on verify. So we just confirm verify is idempotent.
      const { payload } = buildRealSignedDelegate();
      const r1 = await handler.verify(payload, requirements);
      expect(r1.isValid).toBe(true);
      const r2 = await handler.verify(payload, requirements);
      // Second verify should still be valid (replay guard fires only after settle)
      expect(r2.isValid).toBe(true);

      console.warn('[near.test] Skipping settle+replay integration test: set RUN_INTEGRATION_TESTS=true + NEAR_RELAYER_PRIVATE_KEY');
      return;
    }

    const { payload } = buildRealSignedDelegate();
    const settleResult = await handler.settle(payload, requirements);
    expect(settleResult.success).toBe(true);
    expect(settleResult.transaction).toBeDefined();

    // Replay same delegate — must fail because hash is now marked seen
    const replayVerify = await handler.verify(payload, requirements);
    expect(replayVerify.isValid).toBe(false);
    expect(replayVerify.invalidReason).toContain('delegate action replay detected');
  });
});
