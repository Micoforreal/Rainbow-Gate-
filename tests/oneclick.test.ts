import { describe, it, expect } from 'vitest';
import { OneClickHandler } from '../src/handlers/oneclick';

describe('NEAR Intents 1Click Handler', () => {
  const handler = new OneClickHandler(undefined, undefined, true); // mockMode = true

  it('Dry quote previews price without generating deposit address', async () => {
    const quote = await handler.getQuote({
      dry: true,
      swapType: 'EXACT_INPUT',
      originAsset: 'sol:SOL',
      destinationAsset: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
      amount: '1000000000', // 1 SOL
      recipient: 'merchant.near',
      refundTo: 'user_sol_address',
    });

    expect(quote.routeFound).toBe(true);
    expect(quote.depositAddress).toBeUndefined(); // Dry quote must not generate deposit address
    expect(quote.amountOut).toBeDefined();
  });

  it('Dry quote returns no route for unsupported pair or zero amount', async () => {
    const quote = await handler.getQuote({
      dry: true,
      swapType: 'EXACT_INPUT',
      originAsset: 'unknown:TOKEN',
      destinationAsset: 'nep141:fake',
      amount: '0',
      recipient: 'merchant.near',
      refundTo: 'refund_addr',
    });

    expect(quote.routeFound).toBe(false);
    expect(quote.error).toContain('No route for this payment');
    expect(quote.depositAddress).toBeUndefined();
  });

  it('Committed quote (dry: false) generates unique single-use deposit address', async () => {
    const quote = await handler.getQuote({
      dry: false,
      swapType: 'EXACT_INPUT',
      originAsset: 'btc:BTC',
      destinationAsset: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
      amount: '100000', // 0.001 BTC
      recipient: 'merchant.near',
      refundTo: 'bc1p_refund_address',
    });

    expect(quote.routeFound).toBe(true);
    expect(quote.depositAddress).toBeDefined();
    expect(quote.depositAddress).toContain('1click_mock_deposit');
    expect(quote.deadline).toBeDefined();
  });

  it('Fails verify if quote has expired', async () => {
    const expiredQuote = {
      deadline: new Date(Date.now() - 5000).toISOString(), // 5s in past
      amountOut: '1000000',
      depositAddress: 'dep_123',
    };

    const result = await handler.verify(
      { quote: expiredQuote },
      { scheme: 'exact', network: 'intents:near', amount: '1000000', payTo: 'merchant.near' },
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain('quote has expired');
  });

  it('Settle polls status to SUCCESS and returns transaction confirmation', async () => {
    const liveQuote = {
      deadline: new Date(Date.now() + 60000).toISOString(),
      amountOut: '1000000',
      depositAddress: 'dep_123',
    };

    const settleResult = await handler.settle(
      { quote: liveQuote },
      { scheme: 'exact', network: 'intents:near', amount: '1000000', payTo: 'merchant.near' },
    );

    expect(settleResult.success).toBe(true);
    expect(settleResult.transaction).toBeDefined();
  });
});

