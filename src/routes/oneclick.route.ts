import { Router, type Request, type Response } from "express";
import { activeOneClickAssets, config } from "../config";
import { OneClickHandler, type OneClickQuoteRequest } from "../handlers/oneclick";
import type { FacilitatorRouter } from "../router";

const INTENTS_NETWORK = "intents:near";

function sendBadRequest(res: Response, message: string): void {
  res.status(400).json({ error: message });
}

export function createOneClickRouter(
  facilitatorRouter: FacilitatorRouter,
  handler: OneClickHandler,
): Router {
  const router = Router();
  const committedQuotes = new Map<string, Record<string, unknown>>();

  router.get("/assets", (_req: Request, res: Response) => {
    const assets = Object.entries(activeOneClickAssets.assets).map(
      ([id, metadata]) => ({ id, ...metadata }),
    );
    const destinations = Object.entries(activeOneClickAssets.destinations).map(
      ([id, nativeAsset]) => ({
        id,
        nativeAsset,
        ...(activeOneClickAssets.assets as Record<string, { symbol: string; decimals: number }>)[id],
      }),
    );

    res.status(200).json({ environment: config.NETWORK_ENVIRONMENT, assets, destinations });
  });

  router.post("/quote", async (req: Request, res: Response) => {
    const body = req.body as Partial<OneClickQuoteRequest>;
    const assetIds = new Set(Object.keys(activeOneClickAssets.assets));

    if (
      typeof body.originAsset !== "string" ||
      !assetIds.has(body.originAsset) ||
      typeof body.destinationAsset !== "string" ||
      !Object.hasOwn(activeOneClickAssets.destinations, body.destinationAsset)
    ) {
      sendBadRequest(res, "originAsset and destinationAsset must be in the active 1Click asset catalog");
      return;
    }
    if (
      typeof body.amount !== "string" ||
      !/^\d+$/.test(body.amount) ||
      BigInt(body.amount) <= 0n
    ) {
      sendBadRequest(res, "amount must be a positive integer in the origin asset's smallest unit");
      return;
    }
    if (
      typeof body.recipient !== "string" ||
      !body.recipient.trim() ||
      typeof body.refundTo !== "string" ||
      !body.refundTo.trim()
    ) {
      sendBadRequest(res, "recipient and refundTo are required");
      return;
    }
    if (body.dry !== true && body.dry !== false) {
      sendBadRequest(res, "dry must be a boolean; use true for a preview and false to commit a quote");
      return;
    }

    try {
      const quote = await handler.getQuote({
        dry: body.dry,
        swapType: "EXACT_INPUT",
        originAsset: body.originAsset,
        destinationAsset: body.destinationAsset,
        amount: body.amount,
        recipient: body.recipient.trim(),
        refundTo: body.refundTo.trim(),
        slippageTolerance: body.slippageTolerance,
      });
      if (quote.routeFound && body.dry === false && quote.depositAddress) {
        committedQuotes.set(quote.depositAddress, quote as unknown as Record<string, unknown>);
        if (committedQuotes.size > 500) {
          const oldestDepositAddress = committedQuotes.keys().next().value;
          if (oldestDepositAddress) committedQuotes.delete(oldestDepositAddress);
        }
      }
      res.status(quote.routeFound ? 200 : 422).json(quote);
    } catch (error: unknown) {
      res.status(502).json({
        error: error instanceof Error ? error.message : "1Click quote request failed",
      });
    }
  });

  router.get("/status", async (req: Request, res: Response) => {
    const depositAddress = req.query.depositAddress;
    if (typeof depositAddress !== "string" || !depositAddress.trim()) {
      sendBadRequest(res, "depositAddress is required");
      return;
    }
    if (!committedQuotes.has(depositAddress)) {
      res.status(404).json({ error: "Unknown or expired tester quote deposit address" });
      return;
    }
    try {
      res.status(200).json(await handler.getStatus(depositAddress));
    } catch (error: unknown) {
      res.status(502).json({
        error: error instanceof Error ? error.message : "1Click status request failed",
      });
    }
  });

  router.post("/settle", async (req: Request, res: Response) => {
    const quote = req.body?.quote;
    const requiredAmount = req.body?.requiredAmount ?? quote?.amountOut;
    if (!quote || typeof quote !== "object" || quote.dry === true || !quote.depositAddress) {
      sendBadRequest(res, "A committed quote with a depositAddress is required");
      return;
    }
    if (
      typeof quote.originAsset !== "string" ||
      !Object.hasOwn(activeOneClickAssets.assets, quote.originAsset) ||
      typeof quote.destinationAsset !== "string" ||
      !Object.hasOwn(activeOneClickAssets.destinations, quote.destinationAsset) ||
      typeof quote.recipient !== "string" ||
      typeof quote.amountOut !== "string" ||
      !/^\d+$/.test(quote.amountOut) ||
      typeof requiredAmount !== "string" ||
      !/^\d+$/.test(requiredAmount) ||
      BigInt(requiredAmount) <= 0n
    ) {
      sendBadRequest(res, "Committed quote is missing supported assets, recipient, or output amount");
      return;
    }
    const issuedQuote = committedQuotes.get(quote.depositAddress);
    if (
      !issuedQuote ||
      issuedQuote.quoteId !== quote.quoteId ||
      issuedQuote.originAsset !== quote.originAsset ||
      issuedQuote.destinationAsset !== quote.destinationAsset ||
      issuedQuote.recipient !== quote.recipient ||
      issuedQuote.amountIn !== quote.amountIn ||
      issuedQuote.amountOut !== quote.amountOut
    ) {
      sendBadRequest(res, "Quote was not issued by this facilitator or its details were changed");
      return;
    }

    const nativeAsset = activeOneClickAssets.destinations[
      quote.destinationAsset as keyof typeof activeOneClickAssets.destinations
    ];
    const paymentRequirements = {
      scheme: "exact",
      network: INTENTS_NETWORK,
      amount: requiredAmount,
      asset: nativeAsset,
      payTo: quote.recipient,
      maxTimeoutSeconds: 4200,
      extra: {},
    };

    try {
      const result = await facilitatorRouter.settle(
        { quote, payerAddress: quote.refundTo },
        paymentRequirements,
      );
      res.status(200).json({
        transaction: result.transaction ?? "",
        network: result.network ?? INTENTS_NETWORK,
        destinationAsset: quote.destinationAsset,
        recipient: quote.recipient,
        ...result,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        errorReason: error instanceof Error ? error.message : "1Click settlement failed",
      });
    }
  });

  return router;
}