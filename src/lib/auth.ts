import type { Request, Response, NextFunction } from "express";
import { getPaymentStore } from "./payments";
import type { MerchantConfig } from "../types/driver.types";

export interface AuthenticatedRequest extends Request {
  merchant?: MerchantConfig;
}

/**
 * Middleware requiring a valid X-API-Key header.
 * Missing key -> 401 UNAUTHORIZED
 * Invalid or revoked key -> 401 UNAUTHORIZED
 * A valid key scoped to another merchant -> 403 FORBIDDEN at the route
 * Never logs keys.
 */
export function requireMerchantKey(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const rawKey = req.headers["x-api-key"] ?? req.header("x-api-key");
  const apiKey =
    typeof rawKey === "string"
      ? rawKey.trim()
      : Array.isArray(rawKey)
        ? rawKey[0].trim()
        : undefined;

  if (!apiKey) {
    res.status(401).json({
      error: "Missing API key",
      code: "UNAUTHORIZED",
      message: "X-API-Key header is required",
    });
    return;
  }

  const store = getPaymentStore();
  if (store.getApiKeyStatus(apiKey) === "revoked") {
    res.status(401).json({
      error: "Expired API key",
      code: "UNAUTHORIZED",
      message: "This API key has been revoked",
    });
    return;
  }
  const merchant = store.getMerchantByApiKey(apiKey);

  if (!merchant) {
    res.status(401).json({
      error: "Invalid API key",
      code: "UNAUTHORIZED",
      message: "Provided API key is not valid or not recognized",
    });
    return;
  }

  req.merchant = merchant;
  next();
}

/**
 * Checks that the authenticated merchant owns or has authority over the requested resource.
 * If target matches merchantId or any configured payTo address for the merchant, returns true.
 * Otherwise returns false.
 */
export function hasMerchantAccess(
  merchant: MerchantConfig,
  targetMerchantId?: string,
  targetPayTo?: string,
): boolean {
  if (targetMerchantId && targetMerchantId !== merchant.merchantId) {
    return false;
  }

  if (targetPayTo) {
    if (targetPayTo === merchant.merchantId) return true;
    const payToAddresses = Object.values(merchant.payTo || {});
    if (payToAddresses.length > 0 && !payToAddresses.includes(targetPayTo)) {
      return false;
    }
  }

  return true;
}
