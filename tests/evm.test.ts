import { describe, it, expect, beforeEach } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex, Address } from 'viem';
import { EVMHandler } from '../src/handlers/evm';
import { getPaymentStore } from '../src/lib/payments';

describe('EVM EIP-3009 Handler', () => {
  const store = getPaymentStore();
  const payerPrivateKey = generatePrivateKey();
  const payerAccount = privateKeyToAccount(payerPrivateKey);

  const merchantAddress: Address = '0x1111111111111111111111111111111111111111';
  const usdcAddress: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // Base Sepolia USDC

  const handler = new EVMHandler({
    rpcUrl: 'https://sepolia.base.org',
  });

  const domain = {
    name: 'USD Coin',
    version: '2',
    chainId: 84532,
    verifyingContract: usdcAddress,
  };

  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  } as const;

  async function createSignedAuthorization(opts?: {
    validBefore?: bigint;
    amount?: bigint;
    to?: Address;
    nonce?: Hex;
  }) {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const nonce = opts?.nonce ?? (`0x${Date.now().toString(16).padStart(64, '0')}` as Hex);
    const value = opts?.amount ?? 1000000n; // 1 USDC
    const to = opts?.to ?? merchantAddress;
    const validAfter = 0n;
    const validBefore = opts?.validBefore ?? now + 300n;

    const message = {
      from: payerAccount.address,
      to,
      value,
      validAfter,
      validBefore,
      nonce,
    };

    const signature = await payerAccount.signTypedData({
      domain,
      types,
      primaryType: 'TransferWithAuthorization',
      message,
    });

    return {
      signature,
      authorization: {
        from: payerAccount.address,
        to,
        value: value.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    };
  }

  const requirements = {
    scheme: 'exact',
    network: 'eip155:84532',
    amount: '1000000',
    asset: usdcAddress,
    payTo: merchantAddress,
  };

  it('Verifies a valid EIP-3009 payload', async () => {
    const payload = await createSignedAuthorization();
    const result = await handler.verify(payload, requirements);
    expect(result.isValid).toBe(true);
    expect(result.payer?.toLowerCase()).toBe(payerAccount.address.toLowerCase());
  });

  it('Fails verification when validBefore has expired', async () => {
    const expiredTime = BigInt(Math.floor(Date.now() / 1000)) - 10n; // 10s in the past
    const payload = await createSignedAuthorization({ validBefore: expiredTime });
    const result = await handler.verify(payload, requirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain('expired');
  });

  it('Fails verification when amount does not match requirements', async () => {
    const payload = await createSignedAuthorization({ amount: 999999n }); // 1 unit off
    const result = await handler.verify(payload, requirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain('Amount mismatch');
  });

  it('Fails verification when recipient does not match requirements', async () => {
    const wrongRecipient = '0x9999999999999999999999999999999999999999' as Address;
    const payload = await createSignedAuthorization({ to: wrongRecipient });
    const result = await handler.verify(payload, requirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain('Recipient mismatch');
  });

  it('Settles valid payment and prevents nonce replay', async () => {
    // This test requires a funded EVM submitter on Base Sepolia (gas + USDC).
    // It is an integration test: set RUN_INTEGRATION_TESTS=true to run it.
    // Unit tests run without a funded account to avoid on-chain dependencies.
    if (!process.env.RUN_INTEGRATION_TESTS) {
      console.warn('[evm.test] Skipping settle integration test: set RUN_INTEGRATION_TESTS=true to run');
      return;
    }

    const payload = await createSignedAuthorization();
    const settleResult = await handler.settle(payload, requirements);
    expect(settleResult.success).toBe(true);
    expect(settleResult.transaction).toBeDefined();

    // Replay same nonce
    const replayVerify = await handler.verify(payload, requirements);
    expect(replayVerify.isValid).toBe(false);
    expect(replayVerify.invalidReason).toContain('nonce has already been used');
  });
});

