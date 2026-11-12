import express from "express";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activeOneClickAssets, config } from "../src/config";
import { OneClickHandler } from "../src/handlers/oneclick";
import { createOneClickRouter } from "../src/routes/oneclick.route";
import type { FacilitatorRouter } from "../src/router";

describe("1Click HTTP flow", () => {
  const handler = new OneClickHandler(undefined, undefined, true);
  const facilitatorRouter = {
    settle: (payload: unknown, requirements: unknown) => handler.settle(payload, requirements),
  } as unknown as FacilitatorRouter;
  const app = express();
  app.use(express.json());
  app.use("/1click", createOneClickRouter(facilitatorRouter, handler));

  let server: ReturnType<typeof app.listen>;
  let baseUrl: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("returns only the configured environment's assets and destinations", async () => {
    const response = await fetch(`${baseUrl}/1click/assets`);
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.environment).toBe(config.NETWORK_ENVIRONMENT);
    expect(data.assets.map((asset: { id: string }) => asset.id)).toEqual(Object.keys(activeOneClickAssets.assets));
    expect(data.destinations.map((asset: { id: string }) => asset.id)).toEqual(Object.keys(activeOneClickAssets.destinations));
  });

  it("rejects assets outside the active catalog", async () => {
    const response = await fetch(`${baseUrl}/1click/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dry: true,
        originAsset: "nep141:unsupported",
        destinationAsset: Object.keys(activeOneClickAssets.destinations)[0],
        amount: "1000",
        recipient: "merchant.near",
        refundTo: "payer.near",
      }),
    });
    expect(response.status).toBe(400);
  });

  it("requires a committed quote issued by this API before status or settle", async () => {
    const unknownQuote = {
      quoteId: "unissued",
      depositAddress: "unissued-deposit",
      originAsset: Object.keys(activeOneClickAssets.assets)[0],
      destinationAsset: Object.keys(activeOneClickAssets.destinations)[0],
      amountIn: "1000",
      amountOut: "1000",
      recipient: "merchant.near",
      refundTo: "payer.near",
      dry: false,
    };
    const status = await fetch(`${baseUrl}/1click/status?depositAddress=unissued-deposit`);
    const settlement = await fetch(`${baseUrl}/1click/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quote: unknownQuote, requiredAmount: "1000" }),
    });
    expect(status.status).toBe(404);
    expect(settlement.status).toBe(400);
  });

  it("settles a committed quote and rejects modified quote details", async () => {
    const originAsset = Object.keys(activeOneClickAssets.assets)[0];
    const destinationAsset = Object.keys(activeOneClickAssets.destinations)[0];
    const committedResponse = await fetch(`${baseUrl}/1click/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dry: false,
        swapType: "EXACT_INPUT",
        originAsset,
        destinationAsset,
        amount: "1000",
        recipient: "merchant.near",
        refundTo: "payer.near",
      }),
    });
    const quote = await committedResponse.json();
    expect(committedResponse.status).toBe(200);
    expect(quote.depositAddress).toBeTruthy();

    const tamperedResponse = await fetch(`${baseUrl}/1click/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quote: { ...quote, recipient: "attacker.near" }, requiredAmount: "1000" }),
    });
    expect(tamperedResponse.status).toBe(400);

    const underpaidResponse = await fetch(`${baseUrl}/1click/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quote, requiredAmount: "1001" }),
    });
    const underpaid = await underpaidResponse.json();
    expect(underpaid.success).toBe(false);
    expect(underpaid.errorReason).toContain("less than required");

    const settlementResponse = await fetch(`${baseUrl}/1click/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quote, requiredAmount: "1000" }),
    });
    const settlement = await settlementResponse.json();
    expect(settlementResponse.status).toBe(200);
    expect(settlement.success).toBe(true);
    expect(settlement.network).toBe("intents:near");
    expect(settlement.transaction).toContain("mock_payout_tx_");
  });
});
