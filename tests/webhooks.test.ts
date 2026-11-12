import crypto from "crypto";
import { createServer, type Server } from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPaymentStore } from "../src/lib/payments";
import { sendMerchantWebhook } from "../src/lib/webhooks";

describe("webhook API-key signature", () => {
  let server: Server;
  let dbPath: string;
  let received: { headers: Record<string, string | string[] | undefined>; body: string } | null = null;
  const previousDbPath = process.env.DATABASE_PATH;
  const previousEncryptionKey = process.env.API_KEY_ENCRYPTION_KEY;
  const apiKey = "rg_test_webhook_direct_signing_key";

  beforeAll(async () => {
    process.env.API_KEY_ENCRYPTION_KEY = "webhook-test-encryption-secret";
    dbPath = path.resolve(os.tmpdir(), `rainbowgate-webhooks-${process.pid}-${Date.now()}.db`);
    process.env.DATABASE_PATH = dbPath;
    const store = getPaymentStore(dbPath);

    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received = { headers: request.headers, body: Buffer.concat(chunks).toString("utf8") };
        response.writeHead(204);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as any;

    store.setMerchant({
      merchantId: "webhook-merchant",
      settlementChain: "solana",
      settlementAsset: "USDC",
      payTo: { "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "merchant-wallet" },
      creditBalance: "0",
      dailyGasBudget: "0",
      apiKey,
      webhookUrl: `http://127.0.0.1:${address.port}/hooks`,
    });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousDbPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDbPath;
    if (previousEncryptionKey === undefined) delete process.env.API_KEY_ENCRYPTION_KEY;
    else process.env.API_KEY_ENCRYPTION_KEY = previousEncryptionKey;
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.rmSync(dbPath + suffix, { force: true }); } catch {}
    }
  });

  it("signs the exact payload using the direct API key and a Unix-seconds timestamp", async () => {
    const store = getPaymentStore();
    const keyRow = (store as any).db.prepare(
      "SELECT keyHash, keyCiphertext FROM api_keys WHERE merchantId = ?",
    ).get("webhook-merchant");
    expect(keyRow.keyHash).toBe(crypto.createHash("sha256").update(apiKey).digest("hex"));
    expect(keyRow.keyCiphertext).not.toContain(apiKey);
    expect(keyRow.keyCiphertext).not.toBeNull();

    const result = await sendMerchantWebhook("webhook-merchant", "subscription.created", {
      subscriptionId: "sub_webhook_test",
    });
    expect(result.delivered).toBe(true);
    expect(received).not.toBeNull();

    const signatureHeader = String(received!.headers["x-rainbowgate-signature"]);
    const match = signatureHeader.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    expect(match).not.toBeNull();
    const expected = crypto.createHmac("sha256", apiKey)
      .update(`${match![1]}.${received!.body}`)
      .digest("hex");
    expect(match![2]).toBe(expected);
  });
});
