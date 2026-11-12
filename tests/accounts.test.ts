import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "crypto";
import bs58 from "bs58";
import fs from "fs";
import os from "os";
import path from "path";
import type { Server } from "http";
import { createServer } from "../src/server";
import { FacilitatorRouter } from "../src/router";
import { getPaymentStore, PaymentStore } from "../src/lib/payments";
import type { NetworkHandler } from "../src/types/driver.types";
import { verifyWalletSignature } from "../src/lib/wallet-auth";

const chain = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const asset = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

describe("wallet accounts and ownership", () => {
  let server: Server;
  let baseUrl: string;
  let store: PaymentStore;
  let dbPath: string;
  const previousDbPath = process.env.DATABASE_PATH;
  const previousEncryptionKey = process.env.API_KEY_ENCRYPTION_KEY;

  beforeAll(async () => {
    dbPath = path.resolve(
      os.tmpdir(),
      `rainbowgate-accounts-${process.pid}-${Date.now()}.db`,
    );
    process.env.API_KEY_ENCRYPTION_KEY = "accounts-test-encryption-secret";
    process.env.DATABASE_PATH = dbPath;
    store = getPaymentStore(dbPath);
    const router = new FacilitatorRouter({ isTestnet: true });
    const handler: NetworkHandler = {
      networkId: chain,
      scheme: "exact",
      supportsNetwork: (network) => network.startsWith("solana:"),
      verify: async (payload) => ({ isValid: true, payer: payload.signer }),
      settle: async (payload) => ({
        success: true,
        transaction: `mock_${payload.transaction}`,
        network: chain,
        payer: payload.signer,
      }),
    };
    router.registerHandler("solana", handler);
    const app = createServer(router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const address = server.address() as any;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    (store as any).db.close();
    if (previousDbPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDbPath;
    if (previousEncryptionKey === undefined)
      delete process.env.API_KEY_ENCRYPTION_KEY;
    else process.env.API_KEY_ENCRYPTION_KEY = previousEncryptionKey;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.rmSync(dbPath + suffix, { force: true });
      } catch {}
    }
  });

  async function post(
    url: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(`${baseUrl}${url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as any };
  }

  async function get(
    url: string,
    token?: string,
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(`${baseUrl}${url}`, {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    });
    return { status: response.status, body: (await response.json()) as any };
  }

  function makeWallet() {
    const pair = crypto.generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32);
    return { pair, walletAddress: bs58.encode(publicKey) };
  }

  function createUser(walletAddress: string) {
    const user = store.createUserForWallet(chain, walletAddress);
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    store.createSession(user.id, chain, walletAddress, token, expiresAt);
    return { user, token };
  }

  function createOwnedMerchant(userId: string, name: string) {
    return store.createMerchantAccount(userId, {
      name,
      accepts: [{ chain, asset, payTo: `${name}-payto` }],
    });
  }

  function saveSubscription(
    id: string,
    userId: string,
    merchantId: string,
    payer: string,
    status = "active",
  ) {
    const now = new Date().toISOString();
    store.saveSubscription({
      id,
      userId,
      merchantId,
      payer,
      chain,
      asset,
      amount: "1000000",
      interval: "weekly",
      nextChargeAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      expiresAt: null,
      maxCharges: null,
      chargesUsed: 1,
      status: status as any,
      createdAt: now,
      updatedAt: now,
      failureCount: 0,
    });
  }

  it("rejects a bad wallet signature and accepts a valid one-time nonce", async () => {
    const { pair, walletAddress } = makeWallet();
    const nonceResponse = await post("/auth/nonce", { chain, walletAddress });
    expect(nonceResponse.status).toBe(200);
    expect(nonceResponse.body.message).toContain("Domain:");
    expect(nonceResponse.body.message).toContain(`Wallet: ${walletAddress}`);
    expect(nonceResponse.body.message).toContain(`Chain: ${chain}`);

    const bad = await post("/auth/verify", {
      chain,
      walletAddress,
      nonce: nonceResponse.body.nonce,
      signature: Buffer.alloc(64).toString("base64"),
    });
    expect(bad.status).toBe(401);

    const signature = bs58.encode(
      crypto.sign(
        null,
        Buffer.from(nonceResponse.body.message),
        pair.privateKey,
      ),
    );
    const verified = await post("/auth/verify", {
      chain,
      walletAddress,
      nonce: nonceResponse.body.nonce,
      signature,
    });
    expect(verified.status).toBe(200);
    expect(verified.body.user.primaryWalletAddress).toBe(walletAddress);
    expect(verified.body.expiresAt).toBeTruthy();
    expect(store.getSessionUser(verified.body.token)?.id).toBe(
      verified.body.user.id,
    );
    const sessionRow = (store as any).db
      .prepare("SELECT tokenHash FROM sessions")
      .get();
    expect(sessionRow.tokenHash).not.toBe(verified.body.token);

    const nearWallet = makeWallet();
    const nearAddress = nearWallet.pair.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("hex");
    const nearMessage = "rainbowGate NEAR login test";
    const nearSignature = `ed25519:${bs58.encode(crypto.sign(null, Buffer.from(nearMessage), nearWallet.pair.privateKey))}`;
    expect(
      await verifyWalletSignature(
        "near:mainnet",
        nearAddress,
        nearMessage,
        nearSignature,
      ),
    ).toBe(true);

    const me = await get("/me", verified.body.token);
    expect(me.status).toBe(200);
    expect(me.body.wallets).toHaveLength(1);

    const linkedWallet = makeWallet();
    const linkNonce = await post("/auth/nonce", {
      chain,
      walletAddress: linkedWallet.walletAddress,
    });
    const linkSignature = crypto
      .sign(
        null,
        Buffer.from(linkNonce.body.message),
        linkedWallet.pair.privateKey,
      )
      .toString("base64");
    const link = await post(
      "/auth/link-wallet",
      {
        chain,
        walletAddress: linkedWallet.walletAddress,
        nonce: linkNonce.body.nonce,
        signature: linkSignature,
      },
      { Authorization: `Bearer ${verified.body.token}` },
    );
    expect(link.status).toBe(201);
    expect((await get("/me", verified.body.token)).body.wallets).toHaveLength(
      2,
    );

    const merchant = await post(
      "/merchants",
      {
        name: "Wallet-owned business",
        accepts: [{ chain, asset, payTo: "wallet-owned-payto" }],
      },
      { Authorization: `Bearer ${verified.body.token}` },
    );
    expect(merchant.status).toBe(201);
    expect(merchant.body.apiKey).toMatch(/^rg_/);
    expect(merchant.body.merchant.userId).toBe(verified.body.user.id);
    expect((await get("/subscriptions")).status).toBe(401);
    expect(
      (
        await get("/subscriptions", undefined, {
          "X-API-Key": "not-a-real-api-key",
        })
      ).status,
    ).toBe(401);

    const expiredUser = store.createUserForWallet(
      chain,
      "expired-session-wallet",
    );
    const expiredToken = crypto.randomBytes(32).toString("base64url");
    store.createSession(
      expiredUser.id,
      chain,
      "expired-session-wallet",
      expiredToken,
      new Date(Date.now() - 1000).toISOString(),
    );
    expect((await get("/me", expiredToken)).status).toBe(401);

    const logout = await post(
      "/auth/logout",
      {},
      { Authorization: `Bearer ${verified.body.token}` },
    );
    expect(logout.status).toBe(200);
    expect((await get("/me", verified.body.token)).status).toBe(401);
  });

  it("scopes user and merchant subscription access to their own records", async () => {
    const first = createUser("payer-wallet-first");
    const second = createUser("payer-wallet-second");
    const firstMerchant = createOwnedMerchant(first.user.id, "first-business");
    const secondMerchant = createOwnedMerchant(
      second.user.id,
      "second-business",
    );
    saveSubscription(
      "sub-first-owner",
      first.user.id,
      firstMerchant.merchant.id,
      "payer-wallet-first",
    );
    saveSubscription(
      "sub-second-owner",
      second.user.id,
      secondMerchant.merchant.id,
      "payer-wallet-second",
    );

    const firstList = await get("/me/subscriptions", first.token);
    expect(firstList.status).toBe(200);
    expect(firstList.body.subscriptions.map((sub: any) => sub.id)).toEqual([
      "sub-first-owner",
    ]);
    expect(
      (await get("/me/subscriptions/sub-second-owner", first.token)).status,
    ).toBe(403);
    expect(
      (
        await post(
          "/me/subscriptions/sub-second-owner/cancel",
          {},
          { Authorization: `Bearer ${first.token}` },
        )
      ).status,
    ).toBe(403);
    expect((await get("/me/subscriptions")).status).toBe(401);

    const merchantList = await get(
      `/subscriptions?merchantId=${encodeURIComponent(secondMerchant.merchant.id)}`,
      undefined,
      {
        "X-API-Key": firstMerchant.apiKey,
      },
    );
    expect(merchantList.status).toBe(403);

    const keys = await get(
      `/merchants/${firstMerchant.merchant.id}/api-keys`,
      first.token,
    );
    expect(keys.status).toBe(200);
    expect(keys.body.apiKeys[0].keyPrefix).toBeTruthy();
    expect(keys.body.apiKeys[0].keyHash).toBeUndefined();
    expect(
      (
        await get(
          `/merchants/${secondMerchant.merchant.id}/api-keys`,
          first.token,
        )
      ).status,
    ).toBe(403);

    const revoked = await post(
      `/merchants/${firstMerchant.merchant.id}/api-keys/${firstMerchant.key.id}/revoke`,
      {},
      { Authorization: `Bearer ${first.token}` },
    );
    expect(revoked.status).toBe(200);
    expect(
      (
        await get("/subscriptions", undefined, {
          "X-API-Key": firstMerchant.apiKey,
        })
      ).status,
    ).toBe(401);
  });
});
