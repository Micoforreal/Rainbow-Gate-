import { Router, type Request, type Response } from "express";
import { getPaymentStore, getExplorerUrl } from "../lib/payments";
import {
  requireMerchantKey,
  hasMerchantAccess,
  type AuthenticatedRequest,
} from "../lib/auth";
import {
  createRetryPayment,
  executeMerchantRefund,
  RescueTransitionError,
} from "../lib/rescue";
import { OneClickHandler } from "../handlers/oneclick";
import type { FacilitatorRouter } from "../router";

export function createPaymentsRouter(
  facilitatorRouter?: FacilitatorRouter,
  oneClickHandler?: OneClickHandler,
): Router {
  const router = Router();
  const store = getPaymentStore();

  router.post(
    "/rescue",
    requireMerchantKey,
    async (req: AuthenticatedRequest, res: Response) => {
      const merchant = req.merchant!;
      const paymentId = req.body?.paymentId;
      const action = req.body?.action;
      if (
        typeof paymentId !== "string" ||
        (action !== "retry" && action !== "refund")
      ) {
        res
          .status(400)
          .json({
            error: "paymentId and action (retry or refund) are required",
            code: "INVALID_RESCUE_REQUEST",
          });
        return;
      }

      const payment = store.getPayment(paymentId);
      if (!payment) {
        res.status(404).json({ error: "Payment not found", code: "NOT_FOUND" });
        return;
      }
      if (!hasMerchantAccess(merchant, payment.merchantId, payment.payTo)) {
        res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });
        return;
      }

      try {
        if (action === "retry") {
          res
            .status(200)
            .json(
              await createRetryPayment(
                paymentId,
                merchant.merchantId,
                oneClickHandler,
              ),
            );
          return;
        }
        res
          .status(200)
          .json(
            await executeMerchantRefund(
              paymentId,
              merchant.merchantId,
              req.body?.reason,
            ),
          );
      } catch (error: any) {
        if (error instanceof RescueTransitionError) {
          res
            .status(409)
            .json({ error: error.message, code: "INVALID_TRANSITION" });
          return;
        }
        res.status(400).json({ error: error.message, code: "RESCUE_FAILED" });
      }
    },
  );

  // Helper to normalize status for client display
  function formatPublicStatus(status: string): string {
    if (status === "settled") return "SUCCESS";
    if (status === "verified") return "PROCESSING";
    if (status === "pending") return "PENDING_DEPOSIT";
    if (status === "failed") return "FAILED";
    if (status === "refunded") return "REFUNDED";
    return status;
  }

  // 1. GET /payments/:paymentId — Public, no key.
  // Returns public fields only: status, amount, asset, network, payer, payTo, txHash, explorerUrl, feeBreakdown, quote/deposit, events
  router.get("/payments/:paymentId", (req: Request, res: Response) => {
    try {
      const paymentId = String(req.params.paymentId);
      const payment = store.getPayment(paymentId);

      if (!payment) {
        res.status(404).json({
          error: "Payment not found",
          code: "NOT_FOUND",
          message: `No payment found with ID: ${paymentId}`,
        });
        return;
      }

      const events = store.getPaymentEvents(paymentId);
      const is1Click = Boolean(
        payment.quoteId ||
        payment.depositAddress ||
        payment.network.startsWith("intents:"),
      );

      const quoteInfo = is1Click
        ? {
            quoteId: payment.quoteId ?? null,
            depositAddress: payment.depositAddress ?? null,
            refundTo: payment.refundTo ?? null,
          }
        : null;

      const depositInfo = is1Click
        ? {
            depositAddress: payment.depositAddress ?? null,
            depositTxHash: null,
          }
        : null;

      const publicResponse = {
        id: payment.paymentId,
        status: formatPublicStatus(payment.status),
        amount: payment.amount,
        asset: payment.asset,
        network: payment.network,
        payer: payment.payer,
        payTo: payment.payTo,
        txHash: payment.txHash ?? null,
        explorerUrl:
          payment.explorerUrl ??
          getExplorerUrl(payment.network, payment.txHash) ??
          null,
        feeBreakdown: payment.feeBreakdown ?? {
          gas: "0",
          gasMargin30Pct: "0",
          oneClickFee: "0",
          totalFee: "0",
        },
        quote: quoteInfo,
        deposit: depositInfo,
        events: events.map((e) => ({
          oldStatus: e.oldStatus ? formatPublicStatus(e.oldStatus) : null,
          newStatus: formatPublicStatus(e.newStatus),
          reason: e.reason ?? null,
          createdAt: e.createdAt,
        })),
        failureReason: payment.failureReason ?? payment.invalidReason ?? null,
        parentPaymentId: payment.parentPaymentId ?? null,
        attemptNumber: payment.attemptNumber ?? 1,
        createdAt: payment.createdAt,
        settledAt: payment.settledAt ?? null,
      };

      res.status(200).json(publicResponse);
    } catch (err: any) {
      res.status(500).json({
        error: "Internal server error",
        code: "INTERNAL_ERROR",
        message: err.message,
      });
    }
  });

  // 2. GET /payments/:paymentId/receipt — Public receipt (JSON only, no HTML page)
  router.get("/payments/:paymentId/receipt", (req: Request, res: Response) => {
    try {
      const paymentId = String(req.params.paymentId);
      const payment = store.getPayment(paymentId);

      if (!payment) {
        res.status(404).json({
          error: "Payment not found",
          code: "NOT_FOUND",
          message: `No payment found with ID: ${paymentId}`,
        });
        return;
      }

      const receipt = {
        paymentId: payment.paymentId,
        merchant: payment.payTo,
        payer: payment.payer,
        amount: payment.amount,
        asset: payment.asset,
        chain: payment.network,
        txHash: payment.txHash ?? null,
        explorerUrl:
          payment.explorerUrl ??
          getExplorerUrl(payment.network, payment.txHash) ??
          null,
        date: payment.settledAt ?? payment.createdAt,
        feeLines: payment.feeBreakdown ?? {
          gas: "0",
          gasMargin30Pct: "0",
          oneClickFee: "0",
          totalFee: "0",
        },
        status: formatPublicStatus(payment.status),
      };

      res.status(200).json(receipt);
    } catch (err: any) {
      res.status(500).json({
        error: "Internal server error",
        code: "INTERNAL_ERROR",
        message: err.message,
      });
    }
  });

  // 3. GET /payments?payer=&merchant=&status=&from=&to=&limit=&offset= — Requires merchant API key.
  router.get(
    "/payments",
    requireMerchantKey,
    (req: AuthenticatedRequest, res: Response) => {
      try {
        const merchant = req.merchant!;
        const queryMerchant = req.query.merchant as string | undefined;

        // If merchant param is passed, ensure it matches authenticated merchant
        if (queryMerchant && queryMerchant !== merchant.merchantId) {
          res.status(403).json({
            error: "Forbidden",
            code: "FORBIDDEN",
            message: `API key does not belong to merchant: ${queryMerchant}`,
          });
          return;
        }

        const payer = req.query.payer as string | undefined;
        const status = req.query.status as string | undefined;
        const from = req.query.from as string | undefined;
        const to = req.query.to as string | undefined;
        const limit = req.query.limit
          ? parseInt(req.query.limit as string, 10)
          : 50;
        const offset = req.query.offset
          ? parseInt(req.query.offset as string, 10)
          : 0;

        const result = store.listPayments({
          merchantId: merchant.merchantId,
          payer,
          status,
          from,
          to,
          limit,
          offset,
        });

        const enrichedPayments = result.payments.map((p) => ({
          ...p,
          status: formatPublicStatus(p.status),
          explorerUrl:
            p.explorerUrl ?? getExplorerUrl(p.network, p.txHash) ?? null,
          feeBreakdown: p.feeBreakdown ?? {
            gas: "0",
            gasMargin30Pct: "0",
            oneClickFee: "0",
            totalFee: "0",
          },
        }));

        res.status(200).json({
          payments: enrichedPayments,
          total: result.total,
          limit,
          offset,
        });
      } catch (err: any) {
        res.status(500).json({
          error: "Internal server error",
          code: "INTERNAL_ERROR",
          message: err.message,
        });
      }
    },
  );

  // 4. POST /payments/:paymentId/retry — Requires API key.
  router.post(
    "/payments/:paymentId/retry",
    requireMerchantKey,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const paymentId = String(req.params.paymentId);
        const merchant = req.merchant!;

        const existing = store.getPayment(paymentId);
        if (!existing) {
          res.status(404).json({
            error: "Payment not found",
            code: "NOT_FOUND",
            message: `Payment ${paymentId} not found for retry`,
          });
          return;
        }

        if (!hasMerchantAccess(merchant, existing.merchantId, existing.payTo)) {
          res.status(403).json({
            error: "Forbidden",
            code: "FORBIDDEN",
            message: "Merchant does not have permission to retry this payment",
          });
          return;
        }

        const retryResult = await createRetryPayment(
          paymentId,
          merchant.merchantId,
          oneClickHandler,
        );
        res.status(200).json(retryResult);
      } catch (err: any) {
        res.status(400).json({
          error: err.message,
          code: "RETRY_ERROR",
          message: err.message,
        });
      }
    },
  );

  // 5. POST /payments/:paymentId/refund — Requires API key, merchant only, idempotent.
  router.post(
    "/payments/:paymentId/refund",
    requireMerchantKey,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const paymentId = String(req.params.paymentId);
        const merchant = req.merchant!;
        const reason = req.body?.reason as string | undefined;

        const existing = store.getPayment(paymentId);
        if (!existing) {
          res.status(404).json({
            error: "Payment not found",
            code: "NOT_FOUND",
            message: `Payment ${paymentId} not found for refund`,
          });
          return;
        }

        if (!hasMerchantAccess(merchant, existing.merchantId, existing.payTo)) {
          res.status(403).json({
            error: "Forbidden",
            code: "FORBIDDEN",
            message: "Merchant does not have permission to refund this payment",
          });
          return;
        }

        const refundResult = await executeMerchantRefund(
          paymentId,
          merchant.merchantId,
          reason,
        );
        res.status(200).json(refundResult);
      } catch (err: any) {
        res.status(400).json({
          error: err.message,
          code: "REFUND_ERROR",
          message: err.message,
        });
      }
    },
  );

  return router;
}
