# orangeGate — Multi-Rail x402 v2 Facilitator Specification

> **Status:** Phase 1 live-proven for Solana Devnet and NEAR Testnet direct settlements.  
> **Date pinned:** 2026-11-10  
> **Protocol:** x402 v2, standard `exact` scheme  
> **Test Command:** `npm test` (or `npx vitest run`)

---

## 1. What orangeGate does in one sentence

A merchant publishes `accepts[]` entries for USDC on Base, Solana, or NEAR; orangeGate's
SDK detects the connected wallet, picks the optimal route silently, and the user only sees
"Pay \$X" in their wallet — no chain dropdown, no manual bridging, and no network confusion.

---

## 2. x402 v2 Protocol Headers & Flow

### 2.1 PaymentRequired challenge (402)

The server returns HTTP 402 with a `PAYMENT-REQUIRED` header containing a base64-encoded
JSON `PaymentRequired` object:

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "https://api.merchant.com/resource",
    "description": "API call billing",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "amount": "1000000",
      "payTo": "0xMERCHANT_BASE_ADDRESS",
      "maxTimeoutSeconds": 60,
      "extra": {
        "name": "USD Coin",
        "version": "2",
        "assetTransferMethod": "eip3009"
      }
    },
    {
      "scheme": "exact",
      "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "amount": "1000000",
      "payTo": "6TXZqPXwsi3ijBZvf8Ncx75CnZebYyX7xrRPm73z7iSr",
      "maxTimeoutSeconds": 90,
      "extra": { "feePayer": "BhnVfNGV6iYURyHYUvYGoJAURCxhsJJXDirumrkWKzKW" }
    },
    {
      "scheme": "exact",
      "network": "near:mainnet",
      "asset": "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      "amount": "1000000",
      "payTo": "merchant.near",
      "maxTimeoutSeconds": 120
    }
  ]
}
```

The client signs for its selected rail and sends a `PAYMENT-SIGNATURE` header.
Upon settlement confirmation, the server answers HTTP 200 with `PAYMENT-RESPONSE`:

```json
{
  "success": true,
  "transaction": "<ON_CHAIN_TX_HASH>",
  "network": "<CAIP2_NETWORK>",
  "payer": "<PAYER_ADDRESS>"
}
```

### 2.2 Facilitator Endpoints

| Endpoint         | Method | Response Shape                                                                                       | Behavior                                                                                                                                      |
| ---------------- | ------ | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /supported` | GET    | `SupportedResponse`                                                                                  | Exact union of kinds from deployed handlers. Never mixes mainnet and testnet.                                                                 |
| `POST /verify`   | POST   | `{ isValid: boolean, invalidReason?: string, payer?: string }`                                       | Validates signatures, amounts, nonces, and liveness without moving funds. Returns HTTP 200 (spec compliant).                                  |
| `POST /settle`   | POST   | `{ success: boolean, transaction?: string, network?: string, payer?: string, errorReason?: string }` | Re-verifies at settle time, enforces gas budgets, co-signs/submits on-chain, waits for receipt. Returns HTTP 200. Idempotent per `paymentId`. |
| `POST /refund`   | POST   | `{ success: boolean, refundTxHash?: string, message: string }`                                       | Manual operations endpoint to reconcile and reverse erroneous payments.                                                                       |

---

## 3. Testnet Deployment Matrix (Phase 1 Live-Proven)

| Rail          | CAIP-2 Network                            | Settlement Asset                                                                  | Merchant Destination                                                                                   | Fee Payer / Relayer                            | Status                                                   |
| ------------- | ----------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------- |
| Solana Devnet | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (Devnet USDC)                      | `6TXZqPXwsi3ijBZvf8Ncx75CnZebYyX7xrRPm73z7iSr` (Owner: `3k6kdXFr3uNtEtGt55PceHGuyTaeq7KamTFhW4Eido1n`) | `BhnVfNGV6iYURyHYUvYGoJAURCxhsJJXDirumrkWKzKW` | **LIVE-PROVEN**                                          |
| NEAR Testnet  | `near:testnet`                            | `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af` (Testnet USDC) | `merchant.testnet`                                                                                     | `og-relayer-77133.testnet`                     | **LIVE-PROVEN** (Active payer: `og-payer-95916.testnet`) |
| Base Sepolia  | `eip155:84532`                            | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (Sepolia USDC)                       | Merchant Base Address                                                                                  | `EVM_SUBMITTER_PRIVATE_KEY`                    | Handler Tested (Unit)                                    |

---

## 4. Canonical Asset Addresses (Mainnet vs Testnet)

### 4.1 Mainnet Config (Configured & Gated Off)

- **Base Mainnet (`eip155:8453`)**: USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals)
- **Solana Mainnet (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`)**: USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (6 decimals)
- **NEAR Mainnet (`near:mainnet`)**: USDC `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (6 decimals)

### 4.2 1Click Dynamic Asset IDs (Live GET /v0/tokens)

- **BTC (Payer Asset)**: `nep141:btc.omft.near`
- **SOL (Payer Asset)**: `nep141:sol.omft.near`
- **NEAR (Payer Asset)**: `nep141:wrap.near`
- **USDC on Base (Destination)**: `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near`
- **USDC on Solana (Destination)**: `nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near`
- **USDC on NEAR (Destination)**: `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`

> _Note:_ 1Click is mainnet-only. Live 1Click swaps are **NOT PROVEN ON TESTNET**. All testnet runs use mock mode explicitly.

---

## 5. Architectural Implementation Rules

### 5.1 EVM (Base / Base Sepolia)

- Implements EIP-3009 `transferWithAuthorization` exclusively (Permit2 removed).
- Strict receipt checking: verifies `receipt.status === 'success'` (status 1) before declaring settlement.
- Fails closed if token asset does not match canonical Base USDC.
- Replay protection: Nonce marked in durable store with TTL = `max(validBefore - now, 86400)`.

### 5.2 Solana SVM

- Decodes TransferChecked instruction (discriminator 12).
- Verifies exact amount as BigInt, recipient ATA, canonical USDC mint, and authority signature.
- Replay protection: Keyed on payer payment signature (`solana:sig:<sig>`), NOT blockhash.
- Fails closed on blockhash check timeout/error.
- Fee payer is co-signer only; payer holds 0 SOL.

### 5.3 NEAR Protocol

- Fresh TypeScript implementation (not a Rust fork).
- Cryptographic verification of NEP-366 `SignedDelegate` using `nearApi.PublicKey.verify()`.
- Enforces single-action constraint: exactly 1 `ft_transfer` with attached deposit of exactly 1 yoctoNEAR.
- Canonical JSON key ordering for deterministic delegate hashing.
- Deduplication: delegate hash marked seen only after successful on-chain broadcast.

---

## 6. Known Pre-Mainnet Gaps & Hardening

1. **NEAR Reboot-Recovery Poller (Pre-Mainnet Gap)**:
   The TypeScript NEAR handler incorporates SQLite WAL durable logging and delegate-hash deduplication, but currently lacks an asynchronous background reconciliation worker to poll unconfirmed `submitted` transactions across facilitator restarts. This is documented as a pre-mainnet requirement before high production volume.
2. **Database Scaling Trigger**:
   SQLite is durable, atomic, and hardened with WAL mode and 5000ms busy timeout for initial mainnet operation. Cutover to PostgreSQL is triggered when payment volume exceeds 10 transactions/second or when running multi-instance active-active facilitators behind a load balancer.
3. **Compliance & OFAC Decision**:
   KYT and OFAC sanctions screening is disabled on testnet. Prior to mainnet onboarding, an automated screening check (e.g. TRM Labs or Chainalysis oracle) will be connected to `verify()` for deposits and merchant payouts.

---

## 7. Mainnet Key Management & Probe Plan (Plan Only)

### 7.1 Required Production Keys (.env)

- `EVM_SUBMITTER_PRIVATE_KEY`: Hot wallet for submitting EIP-3009 authorizations on Base.
- `SOLANA_FEE_PAYER_PRIVATE_KEY`: Hot wallet for co-signing Solana transactions and sponsoring gas.
- `NEAR_RELAYER_PRIVATE_KEY`: Relayer account private key for broadcasting NEP-366 delegate actions.
- `ONECLICK_PARTNER_JWT`: Partner authentication token for NEAR Intents / 1Click API.

_No mainnet keys were generated, set, or funded in this job._

### 7.2 Mainnet Probe Plan (Sequential Execution Order)

1. **Probe 1**: SOL Payer → USDC Merchant on Solana ($1.00 direct settle test)
2. **Probe 2**: SOL Payer → USDC Merchant on NEAR ($1.00 1Click swap probe)
3. **Probe 3**: NEAR Payer → USDC Merchant on Solana ($1.00 1Click swap probe)
4. **Probe 4**: BTC Payer → USDC Merchant on Solana ($5.00 1Click swap probe via single-use address)
5. **Probe 5**: BTC Payer → USDC Merchant on NEAR ($5.00 1Click swap probe via single-use address)

Each probe must follow: `POST /v0/quote` (dry: true) → commit quote (dry: false) → fund deposit → poll `GET /v0/status` every 5s until `SUCCESS` → verify on-chain payout transaction hash.

---

## 8. Payment Lookup & Receipts API (Phase 2)

### 8.1 Authorization Architecture (Two Tiers)

- **Public Tier (No key)**:
  - `GET /payments/:id`: Single-payment lookup is public because transaction records are already public on chain. Returns public fields only: `id`, `status`, `amount`, `asset`, `network`, `payer`, `payTo`, `txHash`, `explorerUrl`, `feeBreakdown`, quote/deposit info for 1Click legs, and event timeline `events`. Internal/secret fields are omitted.
  - `GET /payments/:paymentId/receipt`: Public JSON receipt containing merchant, payer, amount, asset, chain, txHash, explorerUrl, date, fee lines, status. Designed for frontend rendering (no HTML generated by server).
- **Merchant Authenticated Tier (`X-API-Key`)**:
  - `GET /payments?payer=&merchant=&status=&from=&to=&limit=&offset=`: Paginated listing returning only the authenticated merchant's payments. Missing key returns HTTP 401 (`UNAUTHORIZED`). Key belonging to another merchant returns HTTP 403 (`FORBIDDEN`).
  - Request loggers strictly sanitize and never log API keys.

### 8.2 Explorer URLs

All payment responses return `txHash` and `explorerUrl`:

- **Solana Devnet**: `https://solscan.io/tx/<txHash>?cluster=devnet`
- **Solana Mainnet**: `https://solscan.io/tx/<txHash>`
- **NEAR Testnet**: `https://testnet.nearblocks.io/txns/<txHash>`
- **NEAR Mainnet**: `https://nearblocks.io/txns/<txHash>`
- **Base Sepolia**: `https://sepolia.basescan.org/tx/<txHash>`
- **Base Mainnet**: `https://basescan.org/tx/<txHash>`

---

## 9. Failed Payment Rescue, Retry & Refund

### 9.1 Unified Status Machine

Payment statuses are exactly `PENDING_DEPOSIT`, `PROCESSING`, `SUCCESS`, `FAILED`, and `REFUNDED`.

- `PENDING_DEPOSIT`: Waiting for payer deposit (1Click swaps).
- `PROCESSING`: Validated payment currently in flight or broadcasting.
- `SUCCESS`: Confirmed on-chain transaction hash recorded.
- `FAILED`: Terminal settlement failure with explicit machine-readable `failureReason` code.
- `REFUNDED`: Funds returned to payer on chain. Terminal state; a refunded payment can never be settled again.

Every state transition writes an immutable audit record to `payment_events(paymentId, oldStatus, newStatus, reason, createdAt)`.

### 9.2 Failure Classification

All failures are classified into three explicit categories:

1. **`BEFORE_MONEY_MOVED`**:
   - Reasons: `WRONG_AMOUNT`, `EXPIRED_BLOCKHASH`, `EXPIRED_DELEGATE`, `NO_ROUTE`, `INSUFFICIENT_BALANCE`, `INVALID_NONCE`, `INVALID_SIGNATURE`.
   - Resolution: Fresh retry. Nothing to refund.
2. **`AFTER_1CLICK_DEPOSIT`**:
   - Reasons: `UNDERPAID_DEPOSIT`, `INCOMPLETE_DEPOSIT`, `QUOTE_EXPIRED_AFTER_DEPOSIT`, `SOLVER_FAILED`.

- Resolution: The 1Click solver automatically refunds the payer. The facilitator records the solver refund and never credits the merchant.

3. **`SETTLED_RESOURCE_NOT_DELIVERED`**:
   - Reasons: Facilitator settled transaction on-chain, but merchant resource delivery failed.

- Resolution: Merchant-only refund via `POST /rescue` with `action: "refund"`.

### 9.3 Rescue Endpoints

`POST /rescue` is the retry and refund endpoint. It requires the owning merchant's `X-API-Key` and accepts:

```json
{ "paymentId": "pay_failed_parent", "action": "retry" }
```

For `action: "retry"`, only a `FAILED` payment with `failureKind: "BEFORE_MONEY_MOVED"` is accepted. Retry does not reset or modify the failed payment. It creates a new payment with a fresh quote, blockhash, nonce, and delegate as applicable, linked by `parentPaymentId` with an incremented `attemptNumber`; the payer must rebuild and sign. An `AFTER_1CLICK_DEPOSIT` failure is refunded automatically by the 1Click solver.

```json
{
  "payment": {
    "paymentId": "pay_new_attempt",
    "status": "PROCESSING",
    "parentPaymentId": "pay_failed_parent",
    "attemptNumber": 2
  },
  "parentPaymentId": "pay_failed_parent",
  "attemptNumber": 2,
  "freshRequirements": {
    "paymentId": "pay_new_attempt",
    "parentPaymentId": "pay_failed_parent",
    "attemptNumber": 2
  },
  "message": "A new payment was created. Rebuild and re-sign with a fresh quote, blockhash, nonce, or delegate; do not reuse the failed payload."
}
```

For `action: "refund"`, the owning merchant may refund only a settled payment with `failureKind: "SETTLED_RESOURCE_NOT_DELIVERED"`. Refunds are idempotent and return the stored receipt if already refunded. A successful response includes `success`, `paymentId`, `status: "REFUNDED"`, `refundTxHash`, `refundAmount`, and `refundedAt`.

Responses: 401 for a missing, invalid, or revoked API key; 403 when the key belongs to a different merchant; 404 when `paymentId` is unknown; 409 when the payment status or `failureKind` does not permit the action. An invalid request body returns 400. A refunded payment cannot be settled again.

### 9.4 Webhook Subsystem (`src/lib/webhooks.ts`)

Dispatches HMAC-SHA256 signed JSON notifications to the merchant's configured `webhookUrl`. The `X-RainbowGate-Signature` header is `t=<unix-seconds>,v1=<hex-digest>`; for example, `t=1731334482`. The HMAC signing key is the merchant API key itself, used directly, and the signed message is `${timestamp}.${rawBodyJson}`. The API key's SHA-256 authentication hash is not the signing key.

- Events: `payment.failed`, `payment.refunded`, `payment.succeeded`, `subscription.past_due`, `subscription.cancelled`.
- Retries: Up to 3 attempts with exponential backoff.

---

## 10. Subscriptions (Prepaid + Assisted Renewal Only)

### 10.1 Plain Model Statement

**NO AUTO-RENEWAL IN THIS SYSTEM.**
There are no Base Spend Permissions, no Solana Subscriptions programs, no NEAR escrow contracts, and no pre-signed EIP-3009 authorizations for future periods. A user pays once, receives access for a period (`weekly` or `monthly`), and manually approves the next period with a fresh signed transaction. Every API response explicitly returns:
`"model": "prepaid_assisted_renewal"`
`"renewalNotice": "No auto-renew. Payer pays once per period and approves renewals with a fresh signed transaction. No spend permissions or escrows."`

### 10.2 Rules & Wallet Identity

- The `payer` is strictly the connected wallet address (never an email address).
- The initial payment must be signed by that wallet, and its recovered signer must match `payer`.
- All renewal payments must be signed by the exact same wallet address.
- **Early Renewal**: Stacks time onto the remaining period rather than resetting it (`expiresAt = currentExpiry + interval`).

### 10.3 Subscription Endpoints (`src/routes/subscriptions.route.ts`)

- `POST /subscriptions`: Creates subscription and settles first period via normal x402 payment.
- `GET /subscriptions/:id`: Retrieves subscription state.
- `GET /subscriptions?merchantId=&payer=`: Lists subscriptions for merchant.
- `POST /subscriptions/:id/cancel`: Instant cancellation, takes effect immediately, no further charges.
- `POST /subscriptions/:id/pause`: Pauses subscription.
- `POST /subscriptions/:id/charge-now`: Initiates manual charge or renewal for one period.

### 10.4 Background Scheduler Worker (`runSubscriptionScheduler`)

- Standing background job running once per hour (not a route).
- Finds subscriptions where `nextChargeAt <= now`.
- Generates a fresh 402 challenge for that period awaiting one-tap payer approval.
- **Idempotency Guarantee**: A due subscription charges once, never twice, even if the worker runs multiple times in succession.
- A charge prompt unsettled for 24 hours marks the subscription `PAST_DUE`. The scheduler retries once per day for 3 days, then cancels the subscription and dispatches the `subscription.cancelled` webhook.
