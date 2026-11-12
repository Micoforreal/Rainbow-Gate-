/**
 * server.ts — rainbowGate HTTP Server
 *
 * Implements:
 * GET  /supported
 * POST /verify
 * POST /settle
 * POST /refund
 * GET  /health
 */

import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { config, validateBootKeys } from "./config";
import { FacilitatorRouter } from "./router";
import { EVMHandler } from "./handlers/evm";
import { SolanaHandler } from "./handlers/solana";
import { NEARHandler } from "./handlers/near";
import { OneClickHandler } from "./handlers/oneclick";
import { PaymentRequirementsSchema } from "./types/x402.types";
import { getPaymentStore } from "./lib/payments";
import { createPaymentsRouter } from "./routes/payments.route";
import { createSubscriptionsRouter } from "./routes/subscriptions.route";
import { createStatsRouter } from "./routes/stats.route";
import { createAccountsRouter } from "./routes/accounts.route";
import { createOneClickRouter } from "./routes/oneclick.route";
import { startSubscriptionSchedulerWorker } from "./lib/subscriptions";

// Capture the exact moment this module was first loaded (= server process start time)
const SERVER_STARTED_AT = new Date();

// Simple in-memory sliding-window rate limiter per key
class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  private maxRequests: number;
  private windowMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  public check(key: string): boolean {
    const now = Date.now();
    const timestamps = this.requests.get(key) || [];
    const valid = timestamps.filter((t) => now - t < this.windowMs);
    if (valid.length >= this.maxRequests) {
      return false;
    }
    valid.push(now);
    this.requests.set(key, valid);
    return true;
  }
}

const payerLimiter = new RateLimiter(60, 60_000); // 60 req/min per payer
const merchantLimiter = new RateLimiter(300, 60_000); // 300 req/min per merchant

export function createServer(router: FacilitatorRouter) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  // CORS Middleware for demo and SDK callers
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Payment-Signature, Payment-Required, X-Payment, X-API-Key, x-api-key",
    );
    if (_req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Request & Response Logger Middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();
    const method = req.method;
    const url = req.originalUrl || req.url;

    // Log incoming request
    const reqBodyFormatted =
      req.body && Object.keys(req.body).length > 0
        ? JSON.stringify(req.body, null, 2)
        : "(empty)";
    console.log(`\n======================================================`);
    console.log(`[REQ] ${timestamp} | ${method} ${url}`);
    if (req.headers["payment-signature"] || req.headers["x-payment"]) {
      console.log(
        `[REQ HEADERS] payment-signature: ${req.headers["payment-signature"] || req.headers["x-payment"]}`,
      );
    }
    console.log(`[REQ BODY]:\n${reqBodyFormatted}`);

    // Intercept response methods to capture and log outgoing response
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);

    res.json = (body: any): Response => {
      const durationMs = Date.now() - startTime;
      console.log(
        `[RES] ${new Date().toISOString()} | ${method} ${url} | Status: ${res.statusCode} | Duration: ${durationMs}ms`,
      );
      try {
        console.log(`[RES BODY]:\n${JSON.stringify(body, null, 2)}`);
      } catch {
        console.log(`[RES BODY]:\n${body}`);
      }
      console.log(`======================================================\n`);
      return originalJson(body);
    };

    res.send = (body: any): Response => {
      // Only log if res.json wasn't already used
      if (!res.headersSent) {
        const durationMs = Date.now() - startTime;
        console.log(
          `[RES] ${new Date().toISOString()} | ${method} ${url} | Status: ${res.statusCode} | Duration: ${durationMs}ms`,
        );
        console.log(
          `[RES BODY]:\n${typeof body === "string" ? body : JSON.stringify(body, null, 2)}`,
        );
        console.log(`======================================================\n`);
      }
      return originalSend(body);
    };

    next();
  });

  // Health check
  app.get(["/health", "/healthz"], (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok", time: new Date().toISOString() });
  });

  // GET /supported
  app.get("/supported", (_req: Request, res: Response) => {
    const supported = router.getSupported();
    res.status(200).json(supported);
  });

  // Helper to extract paymentPayload & paymentRequirements from body or header
  function extractPayloadAndRequirements(req: Request): {
    paymentPayload?: any;
    paymentRequirements?: any;
    parseError?: string;
  } {
    let paymentPayload = req.body.paymentPayload ?? req.body.payload;
    let paymentRequirements =
      req.body.paymentRequirements ?? req.body.requirements;

    // Check headers if not in JSON body
    const headerVal =
      req.headers["payment-signature"] || req.headers["x-payment"];
    if (headerVal && typeof headerVal === "string") {
      try {
        const decoded = JSON.parse(
          Buffer.from(headerVal, "base64").toString("utf8"),
        );
        if (!paymentPayload) {
          paymentPayload = decoded.payload ?? decoded;
        }
        if (!paymentRequirements && decoded.accepted) {
          paymentRequirements = decoded.accepted;
        }
        if (!paymentRequirements && decoded.requirements) {
          paymentRequirements = decoded.requirements;
        }
      } catch {
        // Fall back to direct body
      }
    }

    // Direct body fallback
    if (
      !paymentPayload &&
      (req.body.authorization ||
        req.body.transaction ||
        req.body.signedDelegate ||
        req.body.quote)
    ) {
      paymentPayload = req.body;
    }
    if (!paymentRequirements && req.body.requirements) {
      paymentRequirements = req.body.requirements;
    }

    if (paymentRequirements) {
      const parsedReq =
        PaymentRequirementsSchema.safeParse(paymentRequirements);
      if (!parsedReq.success) {
        return {
          paymentPayload,
          parseError: `Invalid paymentRequirements schema: ${parsedReq.error.issues.map((i) => i.message).join(", ")}`,
        };
      }
      paymentRequirements = parsedReq.data;
    }

    return { paymentPayload, paymentRequirements };
  }

  // POST /verify
  app.post(
    ["/verify", "/v1/verify", "/v2/x402/verify"],
    async (req: Request, res: Response) => {
      try {
        const { paymentPayload, paymentRequirements, parseError } =
          extractPayloadAndRequirements(req);

        if (parseError) {
          res.status(400).json({ isValid: false, invalidReason: parseError });
          return;
        }

        if (!paymentPayload || !paymentRequirements) {
          res.status(400).json({
            isValid: false,
            invalidReason:
              "Missing paymentPayload or paymentRequirements in request",
          });
          return;
        }

        // Rate limiting per payer and per merchant
        const payerKey =
          paymentPayload.from ??
          paymentPayload.payerAddress ??
          req.ip ??
          "unknown";
        const merchantKey = paymentRequirements.payTo ?? "unknown";

        if (!payerLimiter.check(payerKey)) {
          res.status(429).json({
            isValid: false,
            invalidReason: "Rate limit exceeded for payer",
          });
          return;
        }
        if (!merchantLimiter.check(merchantKey)) {
          res.status(429).json({
            isValid: false,
            invalidReason: "Rate limit exceeded for merchant",
          });
          return;
        }

        const result = await router.verify(paymentPayload, paymentRequirements);
        // Facilitator spec: always return HTTP 200 with result payload ({ isValid, invalidReason, payer })
        res.status(200).json(result);
      } catch (err: any) {
        console.error("[Server] /verify internal error:", err);
        res
          .status(500)
          .json({ isValid: false, invalidReason: "Internal server error" });
      }
    },
  );

  // POST /settle
  app.post(
    ["/settle", "/v1/settle", "/v2/x402/settle"],
    async (req: Request, res: Response) => {
      try {
        const { paymentPayload, paymentRequirements, parseError } =
          extractPayloadAndRequirements(req);

        if (parseError) {
          res.status(400).json({
            success: false,
            errorReason: parseError,
            transaction: "",
            network: "",
          });
          return;
        }

        if (!paymentPayload || !paymentRequirements) {
          res.status(400).json({
            success: false,
            errorReason:
              "Missing paymentPayload or paymentRequirements in request",
            transaction: "",
            network: "",
          });
          return;
        }

        // Rate limiting per payer and per merchant
        const payerKey =
          paymentPayload.from ??
          paymentPayload.payerAddress ??
          req.ip ??
          "unknown";
        const merchantKey = paymentRequirements.payTo ?? "unknown";

        if (!payerLimiter.check(payerKey)) {
          res.status(429).json({
            success: false,
            errorReason: "Rate limit exceeded for payer",
            transaction: "",
            network: paymentRequirements?.network ?? "",
          });
          return;
        }
        if (!merchantLimiter.check(merchantKey)) {
          res.status(429).json({
            success: false,
            errorReason: "Rate limit exceeded for merchant",
            transaction: "",
            network: paymentRequirements?.network ?? "",
          });
          return;
        }

        const result = await router.settle(paymentPayload, paymentRequirements);
        // Facilitator spec: always return HTTP 200 with result payload ({ success, transaction, network, payer, errorReason })
        // IMPORTANT: @x402/core SDK validates that `transaction` and `network` are always present in settle responses,
        // even on failure. We normalise here so SDK consumers never get a schema rejection.
        res.status(200).json({
          transaction: result.transaction ?? "",
          network: result.network ?? paymentRequirements?.network ?? "",
          payer: result.payer,
          ...result,
        });
      } catch (err: any) {
        console.error("[Server] /settle internal error:", err);
        res
          .status(500)
          .json({ success: false, errorReason: "Internal server error" });
      }
    },
  );

  // POST /refund — Manual refund reconciliation endpoint
  app.post(["/refund", "/v1/refund"], async (req: Request, res: Response) => {
    try {
      const { paymentId, reason } = req.body;
      if (!paymentId) {
        res.status(400).json({ error: "Missing paymentId for refund" });
        return;
      }

      const store = getPaymentStore();
      const payment = store.getPayment(paymentId);

      if (!payment) {
        res.status(404).json({ error: `Payment not found: ${paymentId}` });
        return;
      }

      if (payment.status !== "settled") {
        res.status(400).json({
          error: `Cannot refund payment with status "${payment.status}". Only settled payments can be refunded.`,
        });
        return;
      }

      // Log detailed reconciliation record for operator
      console.log(`[Refund] Manual refund initiated for payment ${paymentId}:`);
      console.log(`  Payer: ${payment.payer}`);
      console.log(
        `  Amount: ${payment.amount} (Asset: ${payment.asset}, Network: ${payment.network})`,
      );
      console.log(`  Original Settlement Tx: ${payment.txHash ?? "none"}`);
      console.log(`  1Click Quote ID: ${payment.quoteId ?? "none"}`);
      console.log(
        `  1Click Deposit Address: ${payment.depositAddress ?? "none"}`,
      );
      console.log(`  Refund Reason: ${reason ?? "Merchant refund requested"}`);

      // Mark payment as refunded in database
      store.savePayment({
        ...payment,
        status: "refunded",
        invalidReason: `Refunded: ${reason ?? "Operator refund"}`,
      });

      res.status(200).json({
        success: true,
        paymentId,
        status: "refunded",
        originalTxHash: payment.txHash,
        quoteId: payment.quoteId,
        depositAddress: payment.depositAddress,
        refundTo: payment.refundTo ?? payment.payer,
        message:
          "Payment logged and marked as refunded for operator reconciliation",
      });
    } catch (err: any) {
      console.error("[Server] /refund internal error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Mount payment lookup, receipts, retry & refund routes
  const oneClickHandler = router.getHandlerForNetwork("intents:near") as
    | OneClickHandler
    | undefined;
  if (oneClickHandler) {
    app.use("/1click", createOneClickRouter(router, oneClickHandler));
  }
  app.use(createAccountsRouter());
  app.use(createPaymentsRouter(router, oneClickHandler));

  // Mount subscriptions routes
  app.use(createSubscriptionsRouter(router));

  // Mount stats route — public aggregate + authenticated per-merchant view
  app.use(createStatsRouter(SERVER_STARTED_AT));

  return app;
}

export function buildConfiguredRouter(): FacilitatorRouter {
  const router = new FacilitatorRouter();

  // 1. EVM Handler
  router.registerHandler("evm", new EVMHandler());

  // 2. Solana Handler
  router.registerHandler("solana", new SolanaHandler());

  // 3. NEAR Handler
  router.registerHandler("near", new NEARHandler());

  // 4. 1Click uses the configured endpoint; testnet targets Tidepool, not mock mode.
  router.registerHandler("oneclick", new OneClickHandler());

  return router;
}

export async function bootstrap() {
  const router = buildConfiguredRouter();

  // Validate that all required private keys for registered handlers are present
  // Refuses to boot if a registered handler is missing its key
  validateBootKeys(router.getDeployedHandlers());

  const app = createServer(router);

  // Start background subscription renewal scheduler worker (runs once an hour)
  startSubscriptionSchedulerWorker();

  const server = app.listen(config.PORT, () => {
    console.log(`🚀 rainbowGate Facilitator active on port ${config.PORT}`);
    console.log(
      `Environment: ${config.NETWORK_ENVIRONMENT} (isTestnet: ${config.NETWORK_ENVIRONMENT === "testnet"})`,
    );
    console.log(
      `Handlers deployed: ${router.getDeployedHandlers().join(", ")}`,
    );
  });

  return { server, app, router };
}

// Auto-bootstrap when executed directly
if (require.main === module) {
  bootstrap().catch((err) => {
    console.error("Fatal bootstrap error:", err);
    process.exit(1);
  });
}
