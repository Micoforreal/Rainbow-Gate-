import dns from "dns";
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {}
import { z } from "zod";
import dotenv from "dotenv";
import path from "path";

// Anchor .env loading to repository root (prevents working-directory trap)
dotenv.config({ path: path.resolve(__dirname, "../.env") });

export const ConfigSchema = z.object({
  PORT: z.string().default("3000"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  NETWORK_ENVIRONMENT: z.enum(["testnet", "mainnet"]).default("testnet"),
  AUTH_DOMAIN: z.string().default("localhost"),
  API_KEY_ENCRYPTION_KEY: z.string().optional(),

  // EVM (Base)
  BASE_RPC_URL: z.string().url().optional(),
  EVM_SUBMITTER_PRIVATE_KEY: z.string().optional(),

  // SVM (Solana)
  SOLANA_RPC_URL: z.string().url().optional(),
  SOLANA_FEE_PAYER_PRIVATE_KEY: z.string().optional(),

  // NEAR
  NEAR_RPC_URL: z.string().url().optional(),
  NEAR_RELAYER_ACCOUNT_ID: z.string().optional(),
  NEAR_RELAYER_PRIVATE_KEY: z.string().optional(),

  // 1Click Intents (Swap layer)
  ONECLICK_API_URL: z.string().url().optional(),
  ONECLICK_PARTNER_JWT: z.string().optional(),

  // Database path anchored to repo root
  DATABASE_PATH: z.string().optional(),
});

const parsed = ConfigSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment configuration:", parsed.error.format());
  process.exit(1);
}

const selectedEnvironment = parsed.data.NETWORK_ENVIRONMENT;
const selectedIsTestnet = selectedEnvironment === "testnet";
const endpointDefaults = selectedIsTestnet
  ? {
      SOLANA_RPC_URL: "https://api.devnet.solana.com",
      BASE_RPC_URL: "https://sepolia.base.org",
      NEAR_RPC_URL: "https://rpc.testnet.near.org",
      ONECLICK_API_URL: "https://www.usetidepool.tech",
    }
  : {
      SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
      BASE_RPC_URL: "https://mainnet.base.org",
      NEAR_RPC_URL: "https://rpc.mainnet.near.org",
      ONECLICK_API_URL: "https://1click.chaindefuser.com",
    };

function validateEndpoint(
  name: string,
  value: string,
  expected: "testnet" | "mainnet",
): void {
  const host = new URL(value).hostname.toLowerCase();
  const testHost = /devnet|testnet|sepolia|usetidepool/.test(host);
  const mainHost = /mainnet|chaindefuser/.test(host);
  if (
    (expected === "testnet" && !testHost) ||
    (expected === "mainnet" && (!mainHost || testHost))
  ) {
    throw new Error(
      `[Boot Error] ${name}=${value} does not match NETWORK_ENVIRONMENT=${expected}`,
    );
  }
}

for (const name of [
  "SOLANA_RPC_URL",
  "BASE_RPC_URL",
  "NEAR_RPC_URL",
  "ONECLICK_API_URL",
] as const) {
  validateEndpoint(
    name,
    parsed.data[name] ?? endpointDefaults[name],
    selectedEnvironment,
  );
}

const nearRelayer = selectedIsTestnet
  ? "og-relayer-77133.testnet"
  : parsed.data.NEAR_RELAYER_ACCOUNT_ID;
if (!nearRelayer && !selectedIsTestnet) {
  throw new Error(
    "[Boot Error] NEAR_RELAYER_ACCOUNT_ID must be explicitly set for mainnet",
  );
}
if (
  !selectedIsTestnet &&
  (nearRelayer!.endsWith(".testnet") || nearRelayer === "og-relayer-77133.near")
) {
  throw new Error(
    "[Boot Error] NEAR_RELAYER_ACCOUNT_ID is not a valid configured mainnet relayer",
  );
}

export const config = {
  ...parsed.data,
  SOLANA_RPC_URL: parsed.data.SOLANA_RPC_URL ?? endpointDefaults.SOLANA_RPC_URL,
  BASE_RPC_URL: parsed.data.BASE_RPC_URL ?? endpointDefaults.BASE_RPC_URL,
  NEAR_RPC_URL: parsed.data.NEAR_RPC_URL ?? endpointDefaults.NEAR_RPC_URL,
  ONECLICK_API_URL:
    parsed.data.ONECLICK_API_URL ?? endpointDefaults.ONECLICK_API_URL,
  NEAR_RELAYER_ACCOUNT_ID: nearRelayer ?? "og-relayer-77133.testnet",
  get ONECLICK_PARTNER_JWT() {
    const jwt =
      process.env.ONECLICK_PARTNER_JWT ?? parsed.data.ONECLICK_PARTNER_JWT;
    return jwt?.trim() ? jwt.trim() : undefined;
  },
  get API_KEY_ENCRYPTION_KEY() {
    return (
      process.env.API_KEY_ENCRYPTION_KEY ?? parsed.data.API_KEY_ENCRYPTION_KEY
    );
  },
  get DATABASE_PATH() {
    return (
      process.env.DATABASE_PATH ??
      parsed.data.DATABASE_PATH ??
      path.resolve(__dirname, `../orangegate-${selectedEnvironment}.db`)
    );
  },
};

export const isTestnet = config.NETWORK_ENVIRONMENT === "testnet";

/**
 * Mainnet and Testnet Canonical Assets Configuration
 */
export const CANONICAL_ASSETS = {
  mainnet: {
    base: {
      network: "eip155:8453",
      usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      decimals: 6,
    },
    solana: {
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      decimals: 6,
    },
    near: {
      network: "near:mainnet",
      usdc: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      decimals: 6,
    },
  },
  testnet: {
    base: {
      network: "eip155:84532",
      usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      decimals: 6,
    },
    solana: {
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      usdc: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      decimals: 6,
    },
    near: {
      network: "near:testnet",
      usdc: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
      decimals: 6,
    },
  },
} as const;

export const ONECLICK_ASSETS = {
  testnet: {
    assets: {
      "nep141:usdc.tidepool-sandbox.testnet": { symbol: "USDC", decimals: 6 },
      "nep141:sol-d48c1adc423a64867ac91ed2e1c0df76da323235.tp-omft.testnet": {
        symbol: "USDC",
        decimals: 6,
      },
    },
    destinations: {
      "nep141:usdc.tidepool-sandbox.testnet":
        "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
      "nep141:sol-d48c1adc423a64867ac91ed2e1c0df76da323235.tp-omft.testnet":
        "7pafEGXSmR35rLKNaD6inpfLYuEnRX9DyBc1c7M8r4Xr",
    },
    tokens: {
      USDC_NEAR: "nep141:usdc.tidepool-sandbox.testnet",
      USDC_SOLANA:
        "nep141:sol-d48c1adc423a64867ac91ed2e1c0df76da323235.tp-omft.testnet",
    },
  },
  mainnet: {
    assets: {
      "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1":
        { symbol: "USDC", decimals: 6 },
      "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near": {
        symbol: "USDC",
        decimals: 6,
      },
      "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near": {
        symbol: "USDC",
        decimals: 6,
      },
      "nep141:sol.omft.near": { symbol: "SOL", decimals: 9 },
      "nep141:btc.omft.near": { symbol: "BTC", decimals: 8 },
      "nep141:wrap.near": { symbol: "NEAR", decimals: 24 },
    },
    destinations: {
      "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1":
        "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near":
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near":
        "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    },
    tokens: {
      BTC: "nep141:btc.omft.near",
      SOL: "nep141:sol.omft.near",
      NEAR: "nep141:wrap.near",
      USDC_BASE:
        "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      USDC_SOLANA:
        "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
      USDC_NEAR:
        "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    },
  },
} as const;

export const activeAssets = CANONICAL_ASSETS[config.NETWORK_ENVIRONMENT];
export const activeOneClickAssets = ONECLICK_ASSETS[config.NETWORK_ENVIRONMENT];

export const MAINNET_NETWORKS = [
  CANONICAL_ASSETS.mainnet.solana.network,
  CANONICAL_ASSETS.mainnet.base.network,
  CANONICAL_ASSETS.mainnet.near.network,
  "intents:near",
] as const;

export const EXPLORER_URLS = {
  base: {
    mainnet: "https://basescan.org/tx/",
    testnet: "https://sepolia.basescan.org/tx/",
  },
  solana: {
    mainnet: "https://solscan.io/tx/",
    testnet: "https://solscan.io/tx/",
    testnetQuery: "?cluster=devnet",
  },
  near: {
    mainnet: "https://nearblocks.io/txns/",
    testnet: "https://testnet.nearblocks.io/txns/",
  },
} as const;

export const ORACLE_API_URL = "https://api.coingecko.com/api/v3/simple/price";

export function isNetworkForActiveEnvironment(network: string): boolean {
  return (
    network === activeAssets.base.network ||
    network === activeAssets.solana.network ||
    network === activeAssets.near.network ||
    network === "intents:near"
  );
}

/**
 * Validates that all keys required by active registered handlers are present at startup.
 * Fail-closed: Throws an error and refuses to boot if any registered handler is missing its key.
 */
export function validateBootKeys(registeredHandlers: string[]): void {
  const missing: string[] = [];

  if (registeredHandlers.includes("evm") && !config.EVM_SUBMITTER_PRIVATE_KEY) {
    missing.push("EVM_SUBMITTER_PRIVATE_KEY");
  }
  if (
    registeredHandlers.includes("solana") &&
    !config.SOLANA_FEE_PAYER_PRIVATE_KEY
  ) {
    missing.push("SOLANA_FEE_PAYER_PRIVATE_KEY");
  }
  if (registeredHandlers.includes("near") && !config.NEAR_RELAYER_PRIVATE_KEY) {
    missing.push("NEAR_RELAYER_PRIVATE_KEY");
  }

  if (missing.length > 0) {
    throw new Error(
      `[Boot Error] Registered handlers missing mandatory private key(s): ${missing.join(", ")}`,
    );
  }
}
