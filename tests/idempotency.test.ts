import { describe, it, expect } from 'vitest';
import { FacilitatorRouter } from '../src/router';
import { EVMHandler } from '../src/handlers/evm';
import { getPaymentStore } from '../src/lib/payments';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex, Address } from 'viem';

describe('Router Settle Idempotency & Durable Store', () => {
  const router = new FacilitatorRouter();
  router.registerHandler('evm', new EVMHandler({ rpcUrl: 'https://sepolia.base.org' }));
  const store = getPaymentStore();

  const payerAccount = privateKeyToAccount(generatePrivateKey());
  const merchantAddress: Address = '0x2222222222222222222222222222222222222222';
  const usdcAddress: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

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

  it('Calling settle twice with same paymentId returns stored result without paying twice', async () => {
    // This test exercises the router idempotency guard + EVM settle.
    // EVM settle requires a funded submitter on Base Sepolia (gas + USDC).
    // Integration test: set RUN_INTEGRATION_TESTS=true to run.
    if (!process.env.RUN_INTEGRATION_TESTS) {
      console.warn('[idempotency.test] Skipping settle integration test: set RUN_INTEGRATION_TESTS=true to run');
      return;
    }
    const now = BigInt(Math.floor(Date.now() / 1000));
    const nonce = `0x${Date.now().toString(16).padStart(64, '0')}` as Hex;
    const value = 1000000n;

    const message = {
      from: payerAccount.address,
      to: merchantAddress,
      value,
      validAfter: 0n,
      validBefore: now + 300n,
      nonce,
    };

    const signature = await payerAccount.signTypedData({
      domain,
      types,
      primaryType: 'TransferWithAuthorization',
      message,
    });

    const payload = {
      paymentId: `pid_${nonce}`,
      signature,
      authorization: {
        from: payerAccount.address,
        to: merchantAddress,
        value: value.toString(),
        validAfter: '0',
        validBefore: (now + 300n).toString(),
        nonce,
      },
    };

    const requirements = {
      scheme: 'exact',
      network: 'eip155:84532',
      amount: '1000000',
      asset: usdcAddress,
      payTo: merchantAddress,
    };

    // First settle call
    const firstResult = await router.settle(payload, requirements);
    expect(firstResult.success).toBe(true);
    expect(firstResult.transaction).toBeDefined();

    // Verify stored in DB
    const saved = store.getPayment(payload.paymentId);
    expect(saved).not.toBeNull();
    expect(saved?.status).toBe('settled');
    expect(saved?.txHash).toBe(firstResult.transaction);

    // Second settle call with identical paymentId
    const secondResult = await router.settle(payload, requirements);
    expect(secondResult.success).toBe(true);
    expect(secondResult.transaction).toBe(firstResult.transaction); // Exact same tx returned
  });
});

