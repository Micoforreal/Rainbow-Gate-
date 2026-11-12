import { describe, it, expect } from 'vitest';
import { OrangeGateClient, type WalletContext, type PaymentRequiredHeader } from '../src/sdk/fetchWithOrangeGate';
import { OneClickHandler } from '../src/handlers/oneclick';

describe('orangeGate Cross-Rail Route Selection Engine', () => {
  // Use explicit mock mode so this test never calls the live 1Click API.
  // Production code uses mockMode: false by default; this is an override for unit tests only.
  const mockOneClick = new OneClickHandler(undefined, undefined, true);
  const client = new OrangeGateClient(mockOneClick);

  // Standard multi-accept 402 challenge from merchant
  const paymentRequired: PaymentRequiredHeader = {
    x402Version: 2,
    accepts: [
      {
        scheme: 'exact',
        network: 'near:testnet',
        asset: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af',
        amount: '1000000', // $1 USDC
        payTo: 'merchant.testnet',
      },
      {
        scheme: 'exact',
        network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
        asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        amount: '1000000', // $1 USDC
        payTo: 'merchant_solana_ata',
      },
    ],
  };

  it('Solana to NEAR: Payer has USDC on Solana, Merchant wants NEAR -> Picks 1Click SWAP leg', async () => {
    const solanaWallet: WalletContext = {
      walletType: 'phantom',
      address: 'phantom_user_address',
      balances: [
        {
          chain: 'solana',
          asset: 'USDC',
          amount: 5_000_000n, // $5 USDC on Solana
          decimals: 6,
        },
      ],
    };

    // Merchant strictly requested NEAR
    const decision = await client.selectRoute(solanaWallet, paymentRequired, 'near');

    expect(decision.routeType).toBe('SWAP_1CLICK');
    expect(decision.originChain).toBe('solana');
    expect(decision.destinationChain).toBe('near');
    expect(decision.destinationAsset).toBe('USDC');
    expect(decision.refundPolicy).toContain('funds are automatically refunded');
  });

  it('NEAR to Solana: Payer has USDC on NEAR, Merchant wants Solana -> Picks 1Click SWAP leg', async () => {
    const nearWallet: WalletContext = {
      walletType: 'near-wallet',
      address: 'alice.testnet',
      balances: [
        {
          chain: 'near',
          asset: 'USDC',
          amount: 5_000_000n, // $5 USDC on NEAR
          decimals: 6,
        },
      ],
    };

    // Merchant requested Solana
    const decision = await client.selectRoute(nearWallet, paymentRequired, 'solana');

    expect(decision.routeType).toBe('SWAP_1CLICK');
    expect(decision.originChain).toBe('near');
    expect(decision.destinationChain).toBe('solana');
    expect(decision.destinationAsset).toBe('USDC');
    expect(decision.refundPolicy).toContain('funds are automatically refunded');
  });

  it('Native SOL to NEAR: Payer holds native SOL, Merchant wants NEAR -> Picks 1Click SWAP leg', async () => {
    const solWallet: WalletContext = {
      walletType: 'phantom',
      address: 'phantom_user_address',
      balances: [
        {
          chain: 'solana',
          asset: 'SOL',
          amount: 1_000_000_000n, // 1 SOL
          decimals: 9,
        },
      ],
    };

    const decision = await client.selectRoute(solWallet, paymentRequired, 'near');

    expect(decision.routeType).toBe('SWAP_1CLICK');
    expect(decision.originAsset).toBe('SOL');
    expect(decision.destinationChain).toBe('near');
    expect(decision.destinationAsset).toBe('USDC');
    expect(decision.estimatedTime).toBe('~1 minute');
  });

  it('Solana Direct: Payer has USDC on Solana, Merchant wants Solana -> Picks DIRECT settlement (no swap)', async () => {
    const solanaWallet: WalletContext = {
      walletType: 'phantom',
      address: 'phantom_user_address',
      balances: [
        {
          chain: 'solana',
          asset: 'USDC',
          amount: 5_000_000n, // $5 USDC on Solana
          decimals: 6,
        },
      ],
    };

    const decision = await client.selectRoute(solanaWallet, paymentRequired, 'solana');

    expect(decision.routeType).toBe('DIRECT');
    expect(decision.originChain).toBe('solana');
    expect(decision.destinationChain).toBe('solana');
    expect(decision.estimatedTime).toContain('0.4–2 seconds');
    expect(decision.quote).toBeUndefined(); // No 1Click swap needed
  });

  it('NEAR Direct: Payer has USDC on NEAR, Merchant wants NEAR -> Picks DIRECT settlement (no swap)', async () => {
    const nearWallet: WalletContext = {
      walletType: 'near-wallet',
      address: 'alice.testnet',
      balances: [
        {
          chain: 'near',
          asset: 'USDC',
          amount: 5_000_000n, // $5 USDC on NEAR
          decimals: 6,
        },
      ],
    };

    const decision = await client.selectRoute(nearWallet, paymentRequired, 'near');

    expect(decision.routeType).toBe('DIRECT');
    expect(decision.originChain).toBe('near');
    expect(decision.destinationChain).toBe('near');
    expect(decision.estimatedTime).toContain('1–2 seconds');
    expect(decision.quote).toBeUndefined();
  });
});

