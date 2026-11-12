# rainbowGate Facilitator — Integration Walkthrough

> **Version:** x402 v2 · **Network environment:** mainnet  
> **Base URL:** `http://localhost:3002` (configure via `PORT` in `.env`)  
> **Last verified:** 2026-11-11 against real mainnet transactions

---

## Table of Contents

1. [System Routes](#1-system-routes)
2. [Supported Networks & Assets](#2-supported-networks--assets)
3. [Payment Lifecycle Overview](#3-payment-lifecycle-overview)
4. [Payment Status Machine](#4-payment-status-machine)
5. [Failure Classification](#5-failure-classification)
6. [Direct Payment Flow (Solana)](#6-direct-payment-flow-solana)
7. [Direct Payment Flow (Base / EVM)](#7-direct-payment-flow-base--evm)
8. [Direct Payment Flow (NEAR Native)](#8-direct-payment-flow-near-native)
9. [1Click Cross-Chain Flow](#9-1click-cross-chain-flow)
10. [Payment Lookup & Receipts](#10-payment-lookup--receipts)
11. [Subscription Endpoints](#11-subscription-endpoints)
12. [Subscription Scheduler Worker](#12-subscription-scheduler-worker)
13. [Webhooks](#13-webhooks)
14. [Fee Breakdown](#14-fee-breakdown)
15. [Rescue & Failure Recovery](#15-rescue--failure-recovery)
16. [Frontend Integration Cheatsheet](#16-frontend-integration-cheatsheet)
17. [User Accounts & Auth](#17-user-accounts--auth)

---

## 1. System Routes

### `GET /health`

Returns 200 when the server is running. No auth required.

**Response:**

```json
{ "status": "ok", "environment": "mainnet" }
```

---

### `GET /stats`

Returns aggregate payment statistics from the SQLite `payments` table. No authentication is required, and the response contains no payer or merchant lists. Results are cached for 30 seconds.

Add `?merchantId=<id>` to return only that merchant's statistics. This scoped request requires `X-API-Key`: a missing key returns 401, and a key that does not belong to the requested merchant returns 403.

Amounts are USDC decimal strings with exactly six fractional digits. Volume includes settled payments only; success rates count successful payments against all recorded payments. Today's counters use the server's UTC day through the current time. Chains with no payments have a `null` success rate.

**Response shape:**

```json
{
  "totalVolumeUsdc": "0.001000",
  "totalPayments": 1,
  "successfulPayments": 1,
  "successRate": 100,
  "paymentsToday": 1,
  "volumeTodayUsdc": "0.001000",
  "successRateByChain": {
    "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": 100,
    "eip155:8453": null,
    "near:mainnet": null,
    "intents:near": null
  },
  "volumeByChainUsdc": {
    "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "0.001000"
  },
  "lastSettleAt": "2026-11-11T16:05:06.000Z",
  "serverStartedAt": "<ISO server process start time>",
  "uptimeSeconds": 3600,
  "environment": "mainnet"
}
```

Only mainnet payments are included: Solana mainnet (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`), Base (`eip155:8453`), NEAR mainnet (`near:mainnet`), and `intents:near`. Testnet networks `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`, `eip155:84532`, and `near:testnet` are excluded from both the public and merchant-scoped query. `uptimeSeconds` is `now - serverStartedAt` in whole seconds; it is not an uptime percentage.

**Live example (2026-11-12, mainnet-only):** Payment `52034a30afb95e1d0e7ec4484a5a4c55` is a real settled Solana payment for `1000` base units (`0.001000` USDC). The sample excludes Base Sepolia, Solana devnet, and NEAR testnet records:

```json
{
  "totalVolumeUsdc": "0.002000",
  "totalPayments": 13,
  "successfulPayments": 2,
  "successRate": 15.38,
  "paymentsToday": 0,
  "volumeTodayUsdc": "0.000000",
  "successRateByChain": {
    "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": 15.38,
    "eip155:8453": null,
    "near:mainnet": null,
    "intents:near": null
  },
  "volumeByChainUsdc": {
    "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "0.002000"
  },
  "lastSettleAt": "2026-11-11T16:05:06.000Z",
  "serverStartedAt": "2026-11-12T15:15:07.690Z",
  "uptimeSeconds": 3194,
  "environment": "mainnet"
}
```

This live mainnet-only response was fetched from a server that had been running for 3194 seconds; `uptimeSeconds` is the current time minus `serverStartedAt`.

---

### `GET /supported`

Returns every payment rail the facilitator accepts on the current network. The frontend **must** call this first so it only presents payment methods the facilitator actually handles.

**Response (mainnet — verified live 2026-11-11):**

```json
{
  "x402Version": 2,
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "eip155:8453",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "methods": ["eip3009"]
    },
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "extra": {
        "feePayer": "6cNGSrsCjbuMfHgryZPGQn8UwApsikYgqwV98F8jCvpr"
      }
    },
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "near:mainnet",
      "asset": "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
    }
  ],
  "extensions": ["payment-identifier"]
}
```

> **Note on NEAR signers:** The `signers` block is intentionally absent on mainnet. The account `og-relayer-77133.near` does **not** exist on NEAR mainnet (confirmed: `UNKNOWN_ACCOUNT` from mainnet RPC). The `signers` block will appear again once you create a funded `.near` account and set `NEAR_RELAYER_ACCOUNT_ID` in `.env`.

---

## 2. Supported Networks & Assets

| Network ID                                | Chain              | USDC Asset                                                         | Method                               | Notes                                                     |
| ----------------------------------------- | ------------------ | ------------------------------------------------------------------ | ------------------------------------ | --------------------------------------------------------- |
| `eip155:8453`                             | Base (mainnet)     | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`                       | EIP-3009 `transferWithAuthorization` | No on-chain fee payer needed                              |
| `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | Solana mainnet     | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`                     | Partial-tx co-signed by fee payer    | Fee payer: `6cNGSrsCjbuMfHgryZPGQn8UwApsikYgqwV98F8jCvpr` |
| `near:mainnet`                            | NEAR mainnet       | `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` | NEP-366 SignedDelegate               | Relayer submits signed delegate on-chain                  |
| `intents:near`                            | 1Click cross-chain | Any → Solana/Base/NEAR USDC                                        | 1Click Intents swap                  | Payer sends any asset on any supported chain              |

---

## 3. Payment Lifecycle Overview

```
Client                        rainbowGate Facilitator
  │                                  │
  ├── GET /supported ───────────────►│ → returns accepted networks/assets
  │                                  │
  ├── builds tx (chain-specific) ────► (off-chain)
  │   user signs it in wallet        │
  │                                  │
  ├── POST /verify ─────────────────►│ → validates tx before money moves
  │◄── { isValid: true } ────────────┤
  │                                  │
  ├── POST /settle ─────────────────►│ → broadcasts tx, deducts merchant credit
  │◄── { success: true, txHash } ────┤
  │                                  │
  ├── GET /payments/:id ────────────►│ → fetch result
  ├── GET /payments/:id/receipt ────►│ → receipt for user display
```

> **Critical order:** Always call `POST /verify` **before** `POST /settle`. Settle without verify will still work (the facilitator internally verifies before submitting), but calling verify explicitly lets you catch invalid transactions before consuming merchant credit.

---

## 4. Payment Status Machine

| Status            | Meaning                                              | Next States            |
| ----------------- | ---------------------------------------------------- | ---------------------- |
| `PENDING_DEPOSIT` | 1Click: waiting for payer to deposit to swap address | `PROCESSING`, `FAILED` |
| `PROCESSING`      | tx submitted to chain, awaiting confirmation         | `SUCCESS`, `FAILED`    |
| `SUCCESS`         | on-chain confirmed, merchant received funds          | `REFUNDED`             |
| `FAILED`          | see `failureKind` and `failureReason`                | — (terminal)           |
| `REFUNDED`        | merchant issued a refund                             | — (terminal)           |

Every transition is written to `payment_events` with `oldStatus`, `newStatus`, `reason`, and `createdAt`.

`PAST_DUE` is not a payment status. Subscription statuses are `ACTIVE`, `PAUSED`, `PAST_DUE`, `CANCELLED`, and `ENDED`.

---

## 5. Failure Classification

Every `FAILED` payment carries a `failureKind`:

| `failureKind`                    | When                                                                     | Money moved?               | Recovery                                         |
| -------------------------------- | ------------------------------------------------------------------------ | -------------------------- | ------------------------------------------------ |
| `BEFORE_MONEY_MOVED`             | Verification rejected, tx malformed, blockhash expired                   | ❌ No                      | Retry; user pays again safely                    |
| `AFTER_1CLICK_DEPOSIT`           | User deposited to swap address but solver failed                         | ✅ Yes (on origin chain)   | 1Click solver auto-refunds user minus refund fee |
| `SETTLED_RESOURCE_NOT_DELIVERED` | On-chain tx confirmed but merchant's server did not deliver the resource | ✅ Yes (merchant received) | Merchant issues manual refund                    |

`failureReason` is a human-readable string. Webhook `payment.failed` delivers the full payload.

---

## 6. Direct Payment Flow (Solana)

### Step 1 — Discover fee payer

```
GET /supported
```

Extract `extra.feePayer` from the Solana kind: `6cNGSrsCjbuMfHgryZPGQn8UwApsikYgqwV98F8jCvpr`

### Step 2 — Build a partial transaction

Build a standard SPL token transfer (`spl-token` / `@solana/spl-token`):

- **From ATA:** payer's USDC ATA
- **To ATA:** merchant's USDC ATA
- **Fee payer:** `6cNGSrsCjbuMfHgryZPGQn8UwApsikYgqwV98F8jCvpr` (signs fee lanes, NOT the transfer)
- Get a **fresh blockhash** immediately before building — it must still be live when `/verify` is called

### Step 3 — Verify (pre-flight)

```http
POST /verify
Content-Type: application/json

{
  "x402Version": 2,
  "payload": {
    "transaction": "<base64-encoded-partial-tx>"
  },
  "paymentRequirements": {
    "scheme": "exact",
    "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "amount": "1000",
    "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "payTo": "<merchant-solana-ata>",
    "maxTimeoutSeconds": 300,
    "extra": {
      "feePayer": "6cNGSrsCjbuMfHgryZPGQn8UwApsikYgqwV98F8jCvpr"
    }
  }
}
```

**Success response:**

```json
{ "isValid": true }
```

**Failure response:**

```json
{ "isValid": false, "invalidReason": "blockhash expired" }
```

> Blockhash liveness check uses a 5 second RPC timeout against mainnet. If the public RPC is slow, increase `SOLANA_RPC_TIMEOUT_MS` in `.env`.

### Step 4 — Settle

```http
POST /settle
Content-Type: application/json

{
  "x402Version": 2,
  "payload": {
    "transaction": "<same-base64-partial-tx>"
  },
  "paymentRequirements": {
    "scheme": "exact",
    "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "amount": "1000",
    "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "payTo": "<merchant-solana-ata>",
    "maxTimeoutSeconds": 300,
    "extra": {
      "feePayer": "6cNGSrsCjbuMfHgryZPGQn8UwApsikYgqwV98F8jCvpr"
    }
  }
}
```

**Success response:**

```json
{
  "success": true,
  "transaction": "32xk6MZ8rDp5YHixfYBELH1Mp5H8ogeSbbmoAEw6AEVaq3ywmr3cWqHxnSExYdguJ7d8jVTcuWfm7Q4TkXsx2LeX",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
}
```

**Real mainnet example (verified 2026-11-11):**

- Payment ID: `52034a30afb95e1d0e7ec4484a5a4c55`
- Amount: `1000` base USDC units = **$0.001 USDC**
- Payer: `DfCusfsmcVhExsjp6dmsyxJdkUtM9pm55UZHRPFbGvd5`
- Merchant: `BhnVfNGV6iYURyHYUvYGoJAURCxhsJJXDirumrkWKzKW`
- txHash: `32xk6MZ8rDp5YHixfYBELH1Mp5H8ogeSbbmoAEw6AEVaq3ywmr3cWqHxnSExYdguJ7d8jVTcuWfm7Q4TkXsx2LeX`
- Explorer: https://solscan.io/tx/32xk6MZ8rDp5YHixfYBELH1Mp5H8ogeSbbmoAEw6AEVaq3ywmr3cWqHxnSExYdguJ7d8jVTcuWfm7Q4TkXsx2LeX

---

## 7. Direct Payment Flow (Base / EVM)

### Step 1 — Build an EIP-3009 authorization

Use `transferWithAuthorization` on the Base USDC contract `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`:

```ts
const authorization = {
  from: payerAddress,
  to: merchantAddress,
  value: amountInBaseUnits, // 6 decimals
  validAfter: 0,
  validBefore: Math.floor(Date.now() / 1000) + 300,
  nonce: crypto.randomBytes(32),
};
// Sign with EIP-712 typed data
```

### Step 2 — Verify

```http
POST /verify
Content-Type: application/json

{
  "x402Version": 2,
  "payload": {
    "signature": "<hex-sig>",
    "authorization": { ...authorization }
  },
  "paymentRequirements": {
    "scheme": "exact",
    "network": "eip155:8453",
    "amount": "1000000",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "payTo": "<merchant-evm-address>",
    "maxTimeoutSeconds": 300
  }
}
```

### Step 3 — Settle

Same body as verify. The facilitator submits `transferWithAuthorization` on-chain.

---

## 8. Direct Payment Flow (NEAR Native)

### Step 1 — Build a NEP-366 SignedDelegate

```ts
import { createTransaction, signTransaction } from 'near-api-js';

// Build a ft_transfer delegate action targeting USDC contract:
// "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
const delegateAction = {
  senderId: payerNearAccountId,
  receiverId: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  actions: [
    {
      type: "FunctionCall",
      params: {
        methodName: "ft_transfer",
        args: { receiver_id: merchantNearAccountId, amount: "1000000" },
        gas: "30000000000000",
        deposit: "1",
      }
    }
  ],
  nonce: ...,
  maxBlockHeight: ...,
};
```

### Step 2 — Verify

```http
POST /verify
Content-Type: application/json

{
  "x402Version": 2,
  "payload": {
    "signedDelegate": "<base64-borsh-encoded-signed-delegate>"
  },
  "paymentRequirements": {
    "scheme": "exact",
    "network": "near:mainnet",
    "amount": "1000000",
    "asset": "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    "payTo": "<merchant-near-account-id>",
    "maxTimeoutSeconds": 300
  }
}
```

### Step 3 — Settle

The facilitator's relayer submits the signed delegate via `near_send_meta_transaction`. Requires `NEAR_RELAYER_ACCOUNT_ID` and `NEAR_RELAYER_PRIVATE_KEY` to be set in `.env`.

> **Important:** The NEAR relayer account must exist on mainnet and have a small NEAR balance for gas. `og-relayer-77133.near` does NOT exist on mainnet — create a `.near` mainnet account and set it in `.env`.

---

## 9. 1Click Cross-Chain Flow

Allows a payer to send **any supported asset on any chain** (SOL, BTC, NEAR, USDC on a foreign chain) and have USDC arrive on the merchant's target chain via NEAR Intents.

**Environment note:** Live 1Click swaps are mainnet-only and are **NOT PROVEN in this job**. Do not call the live 1Click API on testnet; mock 1Click in testnet tests. No mainnet 1Click probe was run. Direct-chain subscription/auth tests do not require 1Click.

### Step 1 — Get a dry quote (preview, no commitment)

```http
POST /oneclick/quote
Content-Type: application/json

{
  "dry": true,
  "swapType": "EXACT_OUTPUT",
  "originAsset": "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "destinationAsset": "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
  "amount": "1000",
  "recipient": "BhnVfNGV6iYURyHYUvYGoJAURCxhsJJXDirumrkWKzKW",
  "refundTo": "payer.near"
}
```

> **Critical:** `destinationAsset` for Solana USDC in the 1Click system is  
> `nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near`  
> **NOT** `solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.  
> The 1Click API uses NEAR-side `nep141:` IDs for all destination assets.

**Previously captured mainnet response (2026-11-11, `dry: true`; not re-probed or proven in this job):**

```json
{
  "routeFound": true,
  "amountIn": "11018",
  "amountOut": "1000",
  "timeEstimate": 17,
  "depositAddress": null,
  "refundFee": "5",
  "slippageTolerance": 100
}
```

Meaning: to receive exactly 1000 USDC base units ($0.001) on Solana, the payer must send 11018 NEAR USDC base units (~$0.011) to cover swap fees and slippage.

The 11018-in for 1000-out ratio is a tiny-amount artifact at the $0.001 scale; real swaps at $1 or more will have a very different ratio.

#### 1Click Token ID Reference

| Asset                     | 1Click `nep141:` ID                                                       |
| ------------------------- | ------------------------------------------------------------------------- |
| NEAR USDC (origin)        | `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` |
| Solana USDC (destination) | `nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near`           |
| Base USDC (destination)   | `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near`        |
| SOL (origin)              | `nep141:sol.omft.near`                                                    |
| BTC (origin)              | `nep141:btc.omft.near`                                                    |
| wNEAR (origin)            | `nep141:wrap.near`                                                        |

### Step 2 — Get a committed quote (with deposit address)

Same body but `"dry": false`. The response now includes a real `depositAddress`.

```json
{
  "routeFound": true,
  "amountIn": "11018",
  "amountOut": "1000",
  "depositAddress": "intents.near",
  "depositMemo": "...",
  "timeEstimate": 17,
  "expiresAt": "2026-11-11T15:45:00Z"
}
```

### Step 3 — Payer sends funds

The payer sends `amountIn` of the origin asset to `depositAddress` on NEAR (with the memo if provided). This is a standard `ft_transfer` on NEAR — no special SDK needed.

### Step 4 — Settle via 1Click network

```http
POST /settle
Content-Type: application/json

{
  "x402Version": 2,
  "payload": {
    "network": "intents:near",
    "paymentPayload": {
      "quote": <committed_quote_object>,
      "payerAddress": "payer.near"
    }
  },
  "paymentRequirements": {
    "scheme": "exact",
    "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "amount": "1000",
    "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "payTo": "BhnVfNGV6iYURyHYUvYGoJAURCxhsJJXDirumrkWKzKW",
    "maxTimeoutSeconds": 300,
    "extra": {
      "feePayer": "6cNGSrsCjbuMfHgryZPGQn8UwApsikYgqwV98F8jCvpr"
    }
  }
}
```

The facilitator polls the 1Click solver, then returns a `payoutTxHash` on the destination chain once confirmed (usually 15–90 seconds).

### Step 5 — Poll status

```http
GET /oneclick/status/<depositTxHash>
```

```json
{
  "status": "COMPLETED",
  "payoutTxHash": "...",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
}
```

---

## 10. Payment Lookup & Receipts

### `GET /payments/:id`

Returns the full payment record.

**Example — real mainnet payment (verified 2026-11-11):**

```
GET /payments/52034a30afb95e1d0e7ec4484a5a4c55
```

```json
{
  "id": "52034a30afb95e1d0e7ec4484a5a4c55",
  "status": "SUCCESS",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "amount": "1000",
  "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "payer": "DfCusfsmcVhExsjp6dmsyxJdkUtM9pm55UZHRPFbGvd5",
  "payTo": "BhnVfNGV6iYURyHYUvYGoJAURCxhsJJXDirumrkWKzKW",
  "txHash": "32xk6MZ8rDp5YHixfYBELH1Mp5H8ogeSbbmoAEw6AEVaq3ywmr3cWqHxnSExYdguJ7d8jVTcuWfm7Q4TkXsx2LeX",
  "explorerUrl": "https://solscan.io/tx/32xk6MZ8rDp5YHixfYBELH1Mp5H8ogeSbbmoAEw6AEVaq3ywmr3cWqHxnSExYdguJ7d8jVTcuWfm7Q4TkXsx2LeX",
  "feeBreakdown": {
    "gas": "10001",
    "gasMargin30Pct": "3000",
    "oneClickFee": "0",
    "totalFee": "13001"
  },
  "createdAt": "2026-11-11T15:34:41.000Z"
}
```

#### Fee breakdown units

| Field            | Unit                             | Description                                                                                               |
| ---------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `gas`            | **lamports** (Solana)            | Actual on-chain network fee paid by the fee payer (10001 lamports for the real tx)                        |
| `gasMargin30Pct` | **lamports**                     | 30% of `gas` only — the facilitator's cost margin. This is charged on gas cost, NOT on the payment amount |
| `oneClickFee`    | **USDC base units** (6 decimals) | 1Click solver fee if the payment used cross-chain swap; `"0"` for direct payments                         |
| `totalFee`       | **lamports**                     | `gas + gasMargin30Pct` (for Solana direct)                                                                |

> **Important:** The 30% margin applies **only to gas cost**, not to the payment amount. For the real tx: gas = 10001 lamports, margin = 3000 lamports, total = 13001 lamports. The $0.001 USDC amount paid to the merchant is untouched.

---

### `GET /payments/:id/receipt`

Returns a user-facing receipt. Same field structure as `/payments/:id` with added `receiptId` and formatted amount labels.

---

### `GET /payments`

```
GET /payments?merchantId=<id>&payer=<address>&status=SUCCESS&limit=20&offset=0
```

All query params are optional.

---

## 11. Subscription Endpoints

Subscriptions use a **prepaid assisted-renewal** model: the facilitator **never auto-debits** without payer approval. Each renewal creates a fresh 402 payment requirement and waits for the payer to sign and submit.

Every merchant subscription endpoint requires `X-API-Key`. Missing, revoked, or unrecognized keys return 401. A valid key scoped to a different merchant or a subscription belonging to another merchant returns 403. Unknown subscription IDs return 404. Invalid transitions return 409.

### `POST /subscriptions`

The merchant is selected from `X-API-Key`; `merchantId` is not required in the body. If the optional body field `merchantId` is supplied, it must match the API key's merchant or the request returns 403. Create a subscription from a real, settled `firstPaymentId`. The request `userId` must own the payer wallet for the specified chain. The first payment must match the payer, this merchant's `payTo`, chain, asset, and amount exactly. The amount must be a positive integer string, the interval must be `weekly` or `monthly`, and the exact chain/asset pair must appear in this merchant's `accepts` list. Validation failures return 400; a payer wallet that does not belong to `userId` returns 403.

**Request:**

```json
{
  "userId": "<user-id-returned-by-auth>",
  "payer": "DfCusfsmcVhExsjp6dmsyxJdkUtM9pm55UZHRPFbGvd5",
  "chain": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "amount": "1000",
  "interval": "monthly",
  "firstPaymentId": "52034a30afb95e1d0e7ec4484a5a4c55"
}
```

For this real-payment example, the merchant must accept the Solana USDC asset and have `payTo` set to `BhnVfNGV6iYURyHYUvYGoJAURCxhsJJXDirumrkWKzKW`, matching payment `52034a30afb95e1d0e7ec4484a5a4c55`. Its amount is `1000` base units (`0.001000` USDC), so the subscription amount is `1000`, not `5000000` (`5.00` USDC).

**Response:**

```json
{
  "subscription": {
    "id": "sub_abc123",
    "userId": "user_abc123",
    "merchantId": "mer_abc123",
    "payer": "DfCusfsmcVhExsjp6dmsyxJdkUtM9pm55UZHRPFbGvd5",
    "chain": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "amount": "1000",
    "interval": "monthly",
    "status": "ACTIVE",
    "nextChargeAt": "2026-12-12T12:00:00.000Z",
    "expiresAt": null,
    "maxCharges": null,
    "chargesUsed": 1,
    "firstPaymentId": "52034a30afb95e1d0e7ec4484a5a4c55",
    "lastPaymentId": "52034a30afb95e1d0e7ec4484a5a4c55",
    "createdAt": "2026-11-12T12:00:00.000Z",
    "updatedAt": "2026-11-12T12:00:00.000Z",
    "pausedAt": null,
    "cancelledAt": null
  },
  "model": "prepaid_assisted_renewal",
  "renewalNotice": "No auto-renew. Payer pays once per period and approves renewals with a fresh signed transaction. No spend permissions or escrows."
}
```

This full subscription record is returned by create, get-one, list, pause, cancel, resume, and charge-now responses. Status values are `ACTIVE`, `PAUSED`, `PAST_DUE`, `CANCELLED`, or `ENDED`. `expiresAt` is an optional hard stop; `nextChargeAt` tracks the next payer-approved renewal.

---

### `GET /subscriptions/:id`

Returns `{ "subscription": <full subscription record>, "model": "prepaid_assisted_renewal", "renewalNotice": "..." }`.

---

### `GET /subscriptions`

```
GET /subscriptions?merchantId=acme-saas&payer=DfCu...d5&status=ACTIVE&limit=20&offset=0
```

All query params optional. The API key scopes the result to its merchant; attempting to select another merchant returns 403. The list contains full subscription records.

---

### `POST /subscriptions/:id/pause`

Pauses an `ACTIVE` or `PAST_DUE` subscription. Paused subscriptions are skipped by the scheduler.

---

### `POST /subscriptions/:id/cancel`

Permanently cancels an `ACTIVE`, `PAST_DUE`, or `PAUSED` subscription. It cannot be resumed.

### `POST /subscriptions/:id/resume`

Merchant-only. Resumes a `PAUSED` subscription. A past `nextChargeAt` moves to now plus one interval; a future one is unchanged. An `ACTIVE` subscription can be resumed idempotently. `CANCELLED`, `ENDED`, and `PAST_DUE` return 409.

---

### `POST /subscriptions/:id/charge-now`

Creates an immediate out-of-schedule payer prompt. It does not settle money or increment `chargesUsed`; only a successful `/settle` does that. The payment row links `subscriptionId` and the previous payment as `parentPaymentId`.

**Response:**

```json
{
  "x402Version": 2,
  "paymentId": "sub_charge_sub_abc123_2_0",
  "paymentRequirements": {
    "scheme": "exact",
    "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "amount": "1000",
    "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "payTo": "BhnVfNGV6iYURyHYUvYGoJAURCxhsJJXDirumrkWKzKW",
    "maxTimeoutSeconds": 300,
    "paymentId": "sub_charge_sub_abc123_2_0",
    "merchantId": "mer_abc123",
    "subscriptionId": "sub_abc123",
    "parentPaymentId": "52034a30afb95e1d0e7ec4484a5a4c55",
    "extra": {
      "subscriptionId": "sub_abc123",
      "parentPaymentId": "52034a30afb95e1d0e7ec4484a5a4c55"
    }
  },
  "amount": "1000",
  "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "payTo": "BhnVfNGV6iYURyHYUvYGoJAURCxhsJJXDirumrkWKzKW",
  "expiresAt": "2026-11-12T12:05:00.000Z",
  "subscription": {
    "id": "sub_abc123",
    "userId": "user_abc123",
    "merchantId": "mer_abc123",
    "payer": "DfCusfsmcVhExsjp6dmsyxJdkUtM9pm55UZHRPFbGvd5",
    "chain": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "amount": "1000",
    "interval": "monthly",
    "status": "ACTIVE",
    "nextChargeAt": "2026-12-12T12:00:00.000Z",
    "expiresAt": null,
    "maxCharges": null,
    "chargesUsed": 1,
    "firstPaymentId": "52034a30afb95e1d0e7ec4484a5a4c55",
    "lastPaymentId": "52034a30afb95e1d0e7ec4484a5a4c55",
    "createdAt": "2026-11-12T12:00:00.000Z",
    "updatedAt": "2026-11-12T12:00:00.000Z",
    "pausedAt": null,
    "cancelledAt": null
  }
}
```

### Payer renewal endpoints

`GET /me/subscriptions` lists only the authenticated user's full subscription records. `GET /me/subscriptions/:id` returns one owned record; a different user's subscription returns 403. `POST /me/subscriptions/:id/cancel` cancels only the authenticated user's own subscription. `GET /me/subscriptions/:id/pending-charge` returns the current charge object above, or JSON `null` when no unexpired prompt is pending. Webhooks notify merchants; the payer retrieves the 402 here.

---

## 12. Subscription Scheduler Worker

The scheduler runs **once per hour** in the same Node.js process (`startSubscriptionSchedulerWorker()` in `src/lib/subscriptions.ts`). It never settles a payment automatically.

### Charge cycle

1. Finds due `ACTIVE` and `PAST_DUE` subscriptions plus records that have reached `maxCharges` or hard `expiresAt`.
2. Ends a subscription when `chargesUsed >= maxCharges` or the hard expiration has passed.
3. Creates one pending payment and x402 requirement for a due subscription. The payer retrieves it from `GET /me/subscriptions/:id/pending-charge`; a webhook is not a payer delivery channel.
4. Only after the payer submits a valid signed payment to `/settle` does the facilitator advance `nextChargeAt` and increment `chargesUsed`.
5. A charge prompt unsettled for 24 hours marks the subscription `PAST_DUE`. The scheduler issues one retry prompt per day for three days; after the third daily retry also remains unsettled for 24 hours, the subscription becomes `CANCELLED`.

### Guarantees

- A due subscription gets at most one pending payment per interval, enforced with an atomic database claim
- Early renewal (via `/subscriptions/:id/charge-now`) stacks time: `nextChargeAt` advances by one full interval from the settlement date
- Paused subscriptions are skipped by the scheduler entirely
- A charge prompt alone never increments `chargesUsed`

---

## 13. Webhooks

rainbowGate POSTs a signed JSON payload to the merchant's `webhookUrl` for every significant event.

### Events

| Event                           | Trigger                                                       |
| ------------------------------- | ------------------------------------------------------------- |
| `payment.succeeded`             | Settlement confirmed on-chain                                 |
| `payment.failed`                | Verification or settlement failed                             |
| `payment.refunded`              | Merchant issued a refund                                      |
| `subscription.created`          | A prepaid subscription was created                            |
| `subscription.charge_succeeded` | A payer-approved renewal settled                              |
| `subscription.past_due`         | A charge prompt remains unsettled for 24 hours                |
| `subscription.cancelled`        | Subscription permanently cancelled (by scheduler or manually) |

### Payload shape

```json
{
  "event": "payment.succeeded",
  "createdAt": "2026-11-11T15:34:42.000Z",
  "merchantId": "acme-saas",
  "data": {
    "paymentId": "52034a30afb95e1d0e7ec4484a5a4c55",
    "amount": "1000",
    "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "txHash": "32xk6MZ8rDp5...",
    "payer": "DfCusfsmcVhExsjp6dmsyxJdkUtM9pm55UZHRPFbGvd5"
  }
}
```

`subscription.charge_succeeded` includes `subscriptionId`, `paymentId`, `amount`, and `txHash` in `data`.

### Signature verification

Every delivery includes two headers:

```
X-RainbowGate-Signature: t=1731334482,v1=abc123def456...
X-RainbowGate-Event: payment.succeeded
```

Verify on your server:

```ts
function verifyWebhook(
  body: string,
  header: string,
  merchantApiKey: string,
): boolean {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const timestamp = parts["t"];
  const v1 = parts["v1"];
  const expected = crypto
    .createHmac("sha256", merchantApiKey)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(v1, "hex"),
    Buffer.from(expected, "hex"),
  );
}
```

- **Signing key:** the merchant API key itself, used directly as the HMAC-SHA256 key, not its SHA-256 authentication hash. The facilitator stores an authentication hash plus an AES-256-GCM encrypted copy for webhook signing; configure `API_KEY_ENCRYPTION_KEY` before creating API keys. Legacy keys created before this setting was configured must be rotated for signed webhooks.
- **Timestamp:** `t` is Unix time in seconds and is included in the signed string as `${timestamp}.${rawBodyJson}`.
- **Signed payload:** `"${timestamp}.${rawBodyJson}"`
- **Algorithm:** HMAC-SHA256, hex-encoded

### Retry policy

- Up to **3 delivery attempts** per event
- Exponential backoff: 200ms → 400ms → 800ms
- A delivery is considered successful if the webhook endpoint returns HTTP 2xx
- Failed deliveries are logged but do not block payment processing

---

## 14. Fee Breakdown

```
totalFee (lamports) = gas + gasMargin30Pct
```

- `gas` — actual lamports consumed on-chain (from `Connection.getTransaction`)
- `gasMargin30Pct` — 30% of `gas` only, NOT 30% of payment amount
- `oneClickFee` — USDC base units (6 decimals) charged by 1Click solver; `"0"` for direct payments
- `totalFee` — total lamports deducted from merchant's pre-funded credit balance

**Real mainnet example:**

- On-chain fee: **10001 lamports** = ~0.00001 SOL = ~\$0.0015
- 30% margin: **3000 lamports**
- Total charged to merchant credit: **13001 lamports**
- Merchant USDC received: **1000 base units** = \$0.001 (100% of payment amount, untouched)

Merchants pre-fund a credit balance via `POST /merchants/:id/credit`. The scheduler will pause settlement if credit runs low.

---

## 15. Rescue & Failure Recovery

### Status endpoint

```
GET /payments/:id
```

Check `status`, `failureKind`, and `failureReason`.

### Rescue flow

`POST /rescue` requires a merchant `X-API-Key`. The authenticated merchant must own the payment. `retry` and `refund` are dispatched by this endpoint; do not use per-payment retry/refund routes.

**Request:**

```http
POST /rescue
X-API-Key: <merchant-api-key>
Content-Type: application/json
```

```
{
  "paymentId": "52034a30afb95e1d0e7ec4484a5a4c55",
  "action": "retry"
}
```

For `action: "retry"`, only a `FAILED` payment with `failureKind: "BEFORE_MONEY_MOVED"` is accepted. Retry does not reset or modify the failed payment. It creates a new payment with a fresh `paymentId`, `parentPaymentId`, and incremented `attemptNumber`; the payer must rebuild and sign with a fresh quote, blockhash, nonce, or delegate. Never reuse the failed authorization or payload.

**Retry response:**

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
    "scheme": "exact",
    "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "amount": "1000",
    "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "payTo": "<merchant-address>",
    "paymentId": "pay_new_attempt",
    "parentPaymentId": "pay_failed_parent",
    "attemptNumber": 2
  },
  "message": "A new payment was created. Rebuild and re-sign with fresh payment credentials."
}
```

For `action: "refund"`, the authenticated payment merchant can refund only a settled payment with `failureKind: "SETTLED_RESOURCE_NOT_DELIVERED"`. Refund is idempotent: a repeated request returns the stored refund receipt rather than issuing another refund.

**Refund response:**

```json
{
  "success": true,
  "paymentId": "pay_settled_resource_not_delivered",
  "status": "REFUNDED",
  "refundTxHash": "<refund-transaction-hash>",
  "refundAmount": "1000",
  "refundedAt": "2026-11-12T15:00:00.000Z",
  "idempotent": false
}
```

Errors: 401 for a missing, invalid, or revoked API key; 403 when the key belongs to a different merchant; 404 when `paymentId` is unknown; 409 when the payment state or `failureKind` does not permit the requested action. An invalid action/body returns 400.

For `AFTER_1CLICK_DEPOSIT` failures: the 1Click solver handles refunds automatically. No manual action needed from the facilitator.

---

## 16. Frontend Integration Cheatsheet

### Direct flow (payer already holds USDC on merchant's chain)

```
1. GET /supported → find matching network
2. Build tx (chain-specific) → user signs in wallet
3. POST /verify → check { isValid: true }
4. POST /settle → get txHash
5. GET /payments/:id/receipt → show to user
```

### 1Click flow (payer holds foreign asset)

This flow is mainnet-only and was not run or proven in this job. Do not call the live 1Click API on testnet; testnet coverage must use the mock handler.

```
1. GET /supported → identify merchant's target chain
2. POST /oneclick/quote (dry: true) → show preview price
3. POST /oneclick/quote (dry: false) → get depositAddress
4. User sends amountIn to depositAddress on NEAR
5. POST /settle with network: "intents:near"
6. Poll GET /oneclick/status/:depositTxHash until COMPLETED
7. GET /payments/:id/receipt → show to user
```

### Subscription (first payment → recurring)

```
1. Run any direct or 1Click flow above
2. POST /subscriptions with firstPaymentId = settled payment ID
3. Frontend receives subscription ID and nextChargeAt
4. At each renewal: scheduler fires → user receives 402 → user signs → settle
5. Webhook delivers payment.succeeded on each charge
```

### Key rules for frontend devs

| Rule                                              | Detail                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Always call `/verify` before `/settle`            | Prevents broadcasting invalid txs                                                           |
| Use fresh blockhash                               | Build Solana tx within 2 minutes of calling `/verify`                                       |
| `destinationAsset` in 1Click ≠ native chain asset | Use `nep141:...` IDs from the token table above                                             |
| `firstPaymentId` must be real                     | Use the settled payment's actual ID; never use a placeholder                                |
| Check `isValid` before proceeding                 | If `false`, show `invalidReason` to user and let them retry                                 |
| Merchant USDC ATA must exist                      | The merchant's USDC Associated Token Account on Solana must be created before first payment |
| Webhook signature header                          | `X-RainbowGate-Signature` and `X-RainbowGate-Event`                                         |

---

## 17. User Accounts & Auth

Users authenticate with a wallet signature; there is no password login and rainbowGate never creates a wallet. A user can link multiple wallets across Solana, EVM, and NEAR. A merchant is a business account owned by a user; a user may own multiple merchants.

### SQLite account tables

| Table                 | Stored data and constraints                                                                                                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`               | `id`, primary wallet address and chain, nullable email/display name, `createdAt`, `updatedAt`; the primary wallet and chain identify the user.                                                                              |
| `user_wallets`        | `id`, `userId`, chain, wallet address, `verifiedAt`, `createdAt`, `updatedAt`; `(chain, walletAddress)` is unique and the user may link multiple wallets.                                                                   |
| `merchants`           | `id`, nullable `userId`, name, nullable email/webhook URL, JSON `accepts`, integer-string `creditBalanceUsdc`, and timestamps. Legacy settlement config fields remain for existing facilitator integrations.                |
| `api_keys`            | `id`, `merchantId`, SHA-256 `keyHash`, AES-256-GCM `keyCiphertext` for direct-key webhook signing, `keyPrefix`, name, last-used/revocation timestamps, and creation/update timestamps. Plaintext key is never stored.       |
| `sessions`            | `id`, `userId`, SHA-256 `tokenHash`, chain, wallet address, `expiresAt`, creation/update/revocation timestamps. The raw session token is never stored.                                                                      |
| `subscriptions`       | User and merchant foreign keys, payer/chain/asset/amount, interval/status, dates, charge limits and counters, first/last payment IDs, pause/cancel timestamps. `payer` and `chain` reference a wallet owned by `userId`.    |
| `payments`            | Existing payment columns are retained; nullable `userId`, `merchantId`, `subscriptionId`, and `parentPaymentId` are foreign-key relationships. Existing payer rows are associated with a user when that wallet is verified. |
| `subscription_events` | `id`, `subscriptionId`, old/new status, reason, and creation/update timestamps. Every status transition is recorded.                                                                                                        |
| `auth_nonces`         | Single-use nonce, chain, wallet, exact signed message, expiry, creation/update timestamps, and used timestamp.                                                                                                              |

The configured `DATABASE_PATH` is resolved from the application directory, not the process working directory. Startup migrations preserve legacy payment rows and keep their original columns; legacy merchant keys are hashed into `api_keys` and removed from the merchant table. Configure a random `API_KEY_ENCRYPTION_KEY` before creating merchants or API keys; it encrypts the key copy needed for direct-key webhook signing.

### Wallet login

`POST /auth/nonce` is public:

```json
{
  "chain": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "walletAddress": "<existing-wallet-address>"
}
```

It returns `{ "nonce", "message", "expiresAt" }`. The signed message includes the configured `AUTH_DOMAIN` (default `localhost`), wallet address, chain, nonce, and expiry. Nonces expire after five minutes and can be consumed only once.

`POST /auth/verify` is public and accepts `{ "chain", "walletAddress", "signature", "nonce" }`. Sign the exact returned message with Solana ed25519 `signMessage`, EVM EIP-191 `personal_sign`, or the NEAR account's ed25519 key. An invalid signature, expired nonce, or replay returns 401.

Successful verification creates the user and wallet rows when needed and returns a random 32-byte session token once:

```json
{
  "user": {
    "id": "user_abc123",
    "primaryWalletAddress": "<wallet>",
    "primaryChain": "<chain>"
  },
  "token": "<shown once>",
  "expiresAt": "2026-11-19T12:00:00.000Z"
}
```

The token expires after seven days. Send it as `Authorization: Bearer <token>` on protected user endpoints. Missing, expired, or revoked sessions return 401.

`POST /auth/link-wallet` requires a Bearer token and `{ "chain", "walletAddress", "signature", "nonce" }`. First request a nonce for the wallet being linked, then sign that message with that wallet. An address linked to a different user cannot be claimed.

`POST /auth/logout` requires a Bearer token and revokes that session. `GET /me` returns the authenticated user, linked wallets, and only the merchants that user owns.

### Merchant accounts and keys

`POST /merchants` requires a Bearer token:

```json
{
  "name": "Acme SaaS",
  "email": "billing@acme.example",
  "webhookUrl": "https://acme.example/hooks/rainbowgate",
  "accepts": [
    {
      "chain": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "payTo": "<merchant-token-account>"
    }
  ]
}
```

The response contains the merchant and its first `apiKey`. Copy that key at creation; it is never returned again. `GET /merchants` lists only the caller's merchants. `POST /merchants/:id/api-keys` creates another key and also displays it once. `GET /merchants/:id/api-keys` returns key prefixes and metadata only. `POST /merchants/:id/api-keys/:keyId/revoke` revokes that key; its later use returns 401. A merchant owned by another user returns 403; an unknown merchant/key ID returns 404.

### User subscription and payment endpoints

All require `Authorization: Bearer <token>` and return only the authenticated user's data:

| Endpoint                                   | Behavior                                                                                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /me/subscriptions`                    | Lists full records with `merchantId`, `payer`, `chain`, `asset`, `amount`, `interval`, `status`, `nextChargeAt`, `expiresAt`, `maxCharges`, `chargesUsed`, `firstPaymentId`, and `lastPaymentId`. |
| `GET /me/subscriptions/:id`                | Returns one owned subscription; another user's ID returns 403.                                                                                                                                    |
| `POST /me/subscriptions/:id/cancel`        | Cancels only the authenticated user's own subscription. A merchant key is not user authorization.                                                                                                 |
| `GET /me/subscriptions/:id/pending-charge` | Returns the current unexpired signable 402 object from charge-now, or JSON `null`. This is the payer's renewal retrieval path.                                                                    |
| `GET /me/payments`                         | Lists only payments associated with the user's verified wallets, using the same public payment fields as `GET /payments/:id`.                                                                     |
| `GET /me/stats`                            | Returns `totalVolumeUsdc`, `totalPayments`, `successfulPayments`, `successRate`, and `activeSubscriptions` for that user.                                                                         |

Unknown IDs return 404, records owned by someone else return 403, missing/expired sessions return 401, and invalid state changes return 409. Subscription webhooks go to merchants only; they do not carry the payer's 402 requirement.
