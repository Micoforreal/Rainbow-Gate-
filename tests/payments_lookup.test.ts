import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import type { Server } from 'http';
import { createServer } from '../src/server';
import { FacilitatorRouter } from '../src/router';
import { getPaymentStore, PaymentStore } from '../src/lib/payments';
import type { NetworkHandler } from '../src/types/driver.types';

describe('Payment Lookup and Receipts', () => {
  let server: Server;
  let baseUrl: string;
  let store: PaymentStore;
  let tempDbPath: string;
  const merchantId = 'merchant_lookup_test';
  const apiKey = 'test_api_key_lookup_123';
  const otherMerchantKey = 'other_merchant_key_999';

  beforeAll(async () => {
    tempDbPath = path.join(os.tmpdir(), `orangegate-lookup-test-${process.pid}-${Date.now()}.db`);
    process.env.DATABASE_PATH = tempDbPath;
    store = getPaymentStore(tempDbPath);

    // Setup test merchant with API key
    store.setMerchant({
      merchantId,
      settlementChain: 'solana',
      settlementAsset: 'USDC',
      payTo: {
        'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': 'merchant_sol_ata_123',
        'near:testnet': 'merchant.testnet',
      },
      creditBalance: '10000000',
      dailyGasBudget: '100000000',
      apiKey,
      webhookUrl: 'https://webhook.site/test',
    });

    store.setMerchant({
      merchantId: 'other_merchant',
      settlementChain: 'solana',
      settlementAsset: 'USDC',
      payTo: { 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': 'other_merchant_ata' },
      creditBalance: '1000',
      dailyGasBudget: '1000',
      apiKey: otherMerchantKey,
    });

    const router = new FacilitatorRouter({ isTestnet: true });

    // Mock handler for testing settle
    const mockHandler: NetworkHandler = {
      networkId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      scheme: 'exact',
      supportsNetwork: (n) => n.startsWith('solana:'),
      verify: async () => ({ isValid: true, payer: 'payer_wallet_abc' }),
      settle: async () => ({
        success: true,
        transaction: '5J7XtxHashRealConfirmedOnChain1234567890',
        network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
        payer: 'payer_wallet_abc',
      }),
    };
    router.registerHandler('solana', mockHandler);

    const app = createServer(router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    try {
      if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
      const wal = tempDbPath + '-wal';
      if (fs.existsSync(wal)) fs.unlinkSync(wal);
      const shm = tempDbPath + '-shm';
      if (fs.existsSync(shm)) fs.unlinkSync(shm);
    } catch {}
  });

  it('lookup after a real settle returns the real tx hash and explorerUrl', async () => {
    const paymentId = 'pay_real_settle_test_001';
    const requirements = {
      scheme: 'exact',
      network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      amount: '1000000',
      asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      payTo: 'merchant_sol_ata_123',
      paymentId,
      merchantId,
    };

    // Execute settle
    const settleRes = await fetch(`${baseUrl}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: { transaction: 'mock_tx' }, requirements }),
    });
    const settleBody = await settleRes.json();

    expect(settleRes.status).toBe(200);
    expect(settleBody.success).toBe(true);
    expect(settleBody.transaction).toBe('5J7XtxHashRealConfirmedOnChain1234567890');

    // Public lookup: GET /payments/:paymentId (No key required)
    const lookupRes = await fetch(`${baseUrl}/payments/${paymentId}`);
    const lookupBody = await lookupRes.json();

    expect(lookupRes.status).toBe(200);
    expect(lookupBody.id).toBe(paymentId);
    expect(lookupBody.status).toBe('SUCCESS');
    expect(lookupBody.txHash).toBe('5J7XtxHashRealConfirmedOnChain1234567890');
    expect(lookupBody.explorerUrl).toContain('https://solscan.io/tx/5J7XtxHashRealConfirmedOnChain1234567890?cluster=devnet');
    expect(lookupBody.amount).toBe('1000000');
    expect(lookupBody.payer).toBe('payer_wallet_abc');
    expect(lookupBody.payTo).toBe('merchant_sol_ata_123');
    expect(lookupBody.events).toBeDefined();
    expect(lookupBody.events.length).toBeGreaterThan(0);
    expect(lookupBody.feeBreakdown).toBeDefined();
  });

  it('lookup without a key on the list endpoint is rejected with 401', async () => {
    const res = await fetch(`${baseUrl}/payments`);
    const body = await res.json();
    expect(res.status).toBe(401);
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('lookup with invalid key on list endpoint is rejected with 401', async () => {
    const res = await fetch(`${baseUrl}/payments`, {
      headers: { 'X-API-Key': 'non_existent_key_xyz' },
    });
    const body = await res.json();
    expect(res.status).toBe(401);
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('merchant querying another merchant payments gets 403', async () => {
    const res = await fetch(`${baseUrl}/payments?merchant=${merchantId}`, {
      headers: { 'X-API-Key': otherMerchantKey },
    });
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.code).toBe('FORBIDDEN');
  });

  it('authenticated merchant gets only their own paginated payments', async () => {
    const res = await fetch(`${baseUrl}/payments?limit=10`, {
      headers: { 'X-API-Key': apiKey },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.payments).toBeDefined();
    expect(Array.isArray(body.payments)).toBe(true);
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.limit).toBe(10);
    expect(body.offset).toBe(0);

    for (const p of body.payments) {
      expect(p.txHash).toBeDefined();
      expect(p.explorerUrl).toBeDefined();
    }
  });

  it('GET /payments/:paymentId/receipt returns JSON receipt with explorerUrl and fee lines', async () => {
    const paymentId = 'pay_real_settle_test_001';
    const res = await fetch(`${baseUrl}/payments/${paymentId}/receipt`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.paymentId).toBe(paymentId);
    expect(body.merchant).toBe('merchant_sol_ata_123');
    expect(body.payer).toBe('payer_wallet_abc');
    expect(body.amount).toBe('1000000');
    expect(body.chain).toBe('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1');
    expect(body.txHash).toBe('5J7XtxHashRealConfirmedOnChain1234567890');
    expect(body.explorerUrl).toBeDefined();
    expect(body.feeLines).toBeDefined();
    expect(body.status).toBe('SUCCESS');
    expect(body.date).toBeDefined();
  });

  it('returns 404 for non-existent payment lookup and receipt', async () => {
    const lookupRes = await fetch(`${baseUrl}/payments/non_existent_pay_123`);
    const lookupBody = await lookupRes.json();
    expect(lookupRes.status).toBe(404);
    expect(lookupBody.code).toBe('NOT_FOUND');

    const receiptRes = await fetch(`${baseUrl}/payments/non_existent_pay_123/receipt`);
    const receiptBody = await receiptRes.json();
    expect(receiptRes.status).toBe(404);
    expect(receiptBody.code).toBe('NOT_FOUND');
  });
});
