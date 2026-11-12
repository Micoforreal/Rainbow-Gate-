import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { verifyMessage, type Hex } from "viem";
import { activeAssets, config } from "../config";

function decodeEd25519Signatures(signature: string): Uint8Array[] {
  const candidates: Uint8Array[] = [];
  const normalized = signature.startsWith("ed25519:")
    ? signature.slice("ed25519:".length)
    : signature;
  try {
    const raw = normalized.startsWith("0x")
      ? Buffer.from(normalized.slice(2), "hex")
      : Buffer.from(normalized, "base64");
    if (raw.length === 64) candidates.push(new Uint8Array(raw));
  } catch {}
  try {
    const raw = bs58.decode(normalized);
    if (
      raw.length === 64 &&
      !candidates.some((candidate) =>
        Buffer.from(candidate).equals(Buffer.from(raw)),
      )
    ) {
      candidates.push(raw);
    }
  } catch {}
  return candidates;
}

function verifyEd25519Signature(
  signature: string,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  return decodeEd25519Signatures(signature).some((candidate) => {
    try {
      return ed25519.verify(candidate, message, publicKey);
    } catch {
      return false;
    }
  });
}

function ed25519PublicKeyBytes(publicKey: string): Uint8Array | null {
  try {
    if (/^[0-9a-f]{64}$/i.test(publicKey))
      return new Uint8Array(Buffer.from(publicKey, "hex"));
    const encoded = publicKey.startsWith("ed25519:")
      ? publicKey.slice("ed25519:".length)
      : publicKey;
    const decoded = bs58.decode(encoded);
    return decoded.length === 32 ? decoded : null;
  } catch {
    return null;
  }
}

async function nearPublicKeys(
  chain: string,
  accountId: string,
): Promise<string[]> {
  if (chain !== activeAssets.near.network) return [];
  const rpcUrl = config.NEAR_RPC_URL;
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "rainbowgate-auth",
        method: "query",
        params: {
          request_type: "view_access_key_list",
          finality: "final",
          account_id: accountId,
        },
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as {
      result?: { keys?: { public_key: string }[] };
    };
    return (body.result?.keys ?? []).map((key) => key.public_key);
  } catch {
    return [];
  }
}

export async function verifyWalletSignature(
  chain: string,
  walletAddress: string,
  message: string,
  signature: string,
): Promise<boolean> {
  if (chain.startsWith("eip155:")) {
    if (
      !/^0x[0-9a-f]{40}$/i.test(walletAddress) ||
      !/^0x[0-9a-f]+$/i.test(signature)
    )
      return false;
    try {
      return await verifyMessage({
        address: walletAddress as `0x${string}`,
        message,
        signature: signature as Hex,
      });
    } catch {
      return false;
    }
  }

  const messageBytes = new TextEncoder().encode(message);

  if (chain.startsWith("solana:")) {
    const publicKey = ed25519PublicKeyBytes(walletAddress);
    return Boolean(
      publicKey && verifyEd25519Signature(signature, messageBytes, publicKey),
    );
  }

  if (chain.startsWith("near:") || chain === "intents:near") {
    const publicKeys = /^[0-9a-f]{64}$/i.test(walletAddress)
      ? [walletAddress]
      : await nearPublicKeys(chain, walletAddress);
    return publicKeys.some((key) => {
      const publicKey = ed25519PublicKeyBytes(key);
      return Boolean(
        publicKey && verifyEd25519Signature(signature, messageBytes, publicKey),
      );
    });
  }
  return false;
}

export function normalizeWalletAddress(
  chain: string,
  walletAddress: string,
): string {
  return chain.startsWith("eip155:")
    ? walletAddress.toLowerCase()
    : walletAddress;
}

export function makeWalletAuthMessage(
  chain: string,
  walletAddress: string,
  nonce: string,
  expiresAt: string,
): string {
  return [
    "rainbowGate wallet authentication",
    `Domain: ${config.AUTH_DOMAIN}`,
    `Wallet: ${walletAddress}`,
    `Chain: ${chain}`,
    `Nonce: ${nonce}`,
    `Expires At: ${expiresAt}`,
  ].join("\n");
}
