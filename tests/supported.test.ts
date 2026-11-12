import { describe, it, expect } from 'vitest';
import { buildConfiguredRouter } from '../src/server';

describe('Facilitator /supported Endpoint and Handler Alignment', () => {
  const router = buildConfiguredRouter();

  it('GET /supported returns valid x402 v2 kinds for deployed handlers', () => {
    const supported = router.getSupported();
    expect(supported.x402Version).toBe(2);
    expect(supported.kinds).toBeInstanceOf(Array);
    expect(supported.kinds.length).toBeGreaterThanOrEqual(3); // EVM (Base Sepolia) + Solana Devnet + NEAR Testnet

    const networks = supported.kinds.map((k) => k.network);
    expect(networks).toContain('eip155:84532'); // Base Sepolia
    expect(networks).toContain('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'); // Solana Devnet
    expect(networks).toContain('near:testnet'); // NEAR Testnet
    // Must NOT advertise mainnet on test deployment
    expect(networks).not.toContain('eip155:8453');
    expect(networks).not.toContain('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
    expect(networks).not.toContain('near:mainnet');

    // Must NOT advertise permit2 if not implemented
    const evmKind = supported.kinds.find((k) => k.network === 'eip155:84532');
    expect(evmKind?.methods).toEqual(['eip3009']);
  });

  it('Every network listed in /supported MUST have an active deployed handler (fail if missing)', () => {
    const supported = router.getSupported();
    for (const kind of supported.kinds) {
      const handler = router.getHandlerForNetwork(kind.network);
      expect(handler, `Missing handler for network listed in /supported: ${kind.network}`).not.toBeNull();
      expect(handler?.supportsNetwork(kind.network)).toBe(true);
    }
  });

  it('Supported signers includes NEAR testnet relayer', () => {
    const supported = router.getSupported();
    expect(supported.signers).toBeDefined();
    const expectedRelayer = process.env.NEAR_RELAYER_ACCOUNT_ID ?? 'og-relayer-77133.testnet';
    expect(supported.signers?.['near:testnet']).toContain(expectedRelayer);
  });
});

