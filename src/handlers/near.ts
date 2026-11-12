/**
 * near.ts — NEP-366 SignedDelegate verify and relayer submit
 * Fresh TypeScript implementation for rainbowGate multi-rail x402 facilitator.
 */

import dns from "dns";
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {}
import crypto from "crypto";
import * as nearApi from "near-api-js";
import type {
  NetworkHandler,
  VerifyResult,
  SettleResult,
  SupportedKind,
} from "../types/driver.types";
import { getPaymentStore } from "../lib/payments";
import { activeAssets, config, isTestnet } from "../config";
import { checkMerchantCreditAndGasBudget } from "../lib/fees";

export interface NEARHandlerOptions {
  rpcUrl?: string;
  relayerAccountId?: string;
  relayerPrivateKey?: string;
}

function normalizeDelegateActions(actions: any[]): any[] {
  return (actions || []).map((act) => {
    if (act?.constructor?.name === "Action") return act;
    if (act.enum === "functionCall" || act.functionCall) {
      const fc = act.functionCall || act;
      const methodName = fc.methodName ?? fc.method_name;
      let rawArgs = fc.args;
      if (typeof rawArgs === "string") {
        // String format: either base64 encoded or stringified JSON
        try {
          rawArgs = Buffer.from(rawArgs, "base64");
        } catch {
          rawArgs = Buffer.from(rawArgs, "utf8");
        }
      } else if (
        rawArgs &&
        typeof rawArgs === "object" &&
        !Buffer.isBuffer(rawArgs) &&
        !(rawArgs instanceof Uint8Array)
      ) {
        if (rawArgs.type === "Buffer" && Array.isArray(rawArgs.data)) {
          rawArgs = Buffer.from(rawArgs.data);
        } else if (rawArgs["0"] !== undefined) {
          const bytes = Object.keys(rawArgs)
            .filter((k) => !isNaN(Number(k)))
            .sort((a, b) => Number(a) - Number(b))
            .map((k) => rawArgs[k]);
          rawArgs = Buffer.from(bytes);
        } else {
          // Plain object e.g. { receiver_id, amount }
          rawArgs = Buffer.from(JSON.stringify(rawArgs), "utf8");
        }
      }
      const gas = BigInt(fc.gas ?? 30000000000000n);
      const deposit = BigInt(fc.deposit ?? 1n);
      return nearApi.actions.functionCall(methodName, rawArgs, gas, deposit);
    }
    return act;
  });
}

function normalizeSignatureBytes(rawSig: any): Uint8Array {
  if (!rawSig) return new Uint8Array(64);
  if (typeof rawSig === "string") {
    return rawSig.startsWith("ed25519:")
      ? nearApi.baseDecode(rawSig.slice(8))
      : nearApi.baseDecode(rawSig);
  }
  const inner = rawSig.data ?? rawSig.signature ?? rawSig;
  if (typeof inner === "string") {
    return inner.startsWith("ed25519:")
      ? nearApi.baseDecode(inner.slice(8))
      : nearApi.baseDecode(inner);
  }
  if (inner.type === "Buffer" && Array.isArray(inner.data)) {
    return new Uint8Array(inner.data);
  }
  if (inner["0"] !== undefined && typeof inner === "object") {
    const bytes = Object.keys(inner)
      .filter((k) => !isNaN(Number(k)))
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => inner[k]);
    return new Uint8Array(bytes);
  }
  return Buffer.isBuffer(inner) ? new Uint8Array(inner) : (inner as Uint8Array);
}
function normalizePublicKey(pubKeyRaw: any): nearApi.PublicKey | null {
  if (!pubKeyRaw) return null;
  if (pubKeyRaw instanceof nearApi.PublicKey) return pubKeyRaw;
  if (typeof pubKeyRaw === "string")
    return nearApi.PublicKey.fromString(pubKeyRaw);
  if (pubKeyRaw.ed25519Key && pubKeyRaw.ed25519Key.data) {
    const d = pubKeyRaw.ed25519Key.data;
    const bytes = Array.isArray(d)
      ? d
      : Object.keys(d)
          .filter((k) => !isNaN(Number(k)))
          .sort((a, b) => Number(a) - Number(b))
          .map((k) => d[k]);
    return nearApi.PublicKey.fromString(
      "ed25519:" + nearApi.baseEncode(Buffer.from(bytes)),
    );
  }
  try {
    return nearApi.PublicKey.from(pubKeyRaw);
  } catch {
    return null;
  }
}

/**
 * Handles BigInt by converting to string, and Uint8Array/Buffer by converting to hex.
 */
export function canonicalizeJson(obj: any): string {
  if (obj === null) return "null";
  if (typeof obj === "bigint") return `"${obj.toString()}"`;
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (obj instanceof Uint8Array || Buffer.isBuffer(obj)) {
    return `"${Buffer.from(obj).toString("hex")}"`;
  }
  if (Array.isArray(obj)) {
    return `[${obj.map((item) => canonicalizeJson(item)).join(",")}]`;
  }
  const sortedKeys = Object.keys(obj).sort();
  const keyVals = sortedKeys.map(
    (k) => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`,
  );
  return `{${keyVals.join(",")}}`;
}

export class NEARHandler implements NetworkHandler {
  readonly networkId = activeAssets.near.network;
  readonly scheme = "exact";

  private rpcUrl: string;
  private relayerAccountId: string;
  private relayerPrivateKey?: string;
  private store = getPaymentStore();

  constructor(opts?: NEARHandlerOptions) {
    this.rpcUrl = opts?.rpcUrl ?? config.NEAR_RPC_URL;
    this.relayerAccountId =
      opts?.relayerAccountId ?? config.NEAR_RELAYER_ACCOUNT_ID;
    this.relayerPrivateKey =
      opts?.relayerPrivateKey ?? config.NEAR_RELAYER_PRIVATE_KEY;
  }

  public supportsNetwork(network: string): boolean {
    return network === activeAssets.near.network;
  }

  public getSupportedKinds(isTestnet: boolean): SupportedKind[] {
    return [
      {
        x402Version: 2,
        scheme: "exact",
        network: activeAssets.near.network,
        asset: activeAssets.near.usdc,
      },
    ];
  }

  public getRelayerAccountId(): string {
    return this.relayerAccountId;
  }

  public getCanonicalUsdc(network: string): string {
    return network === activeAssets.near.network ? activeAssets.near.usdc : "";
  }

  /**
   * Computes deterministic SHA-256 hash of a SignedDelegate action for deduplication.
   * Canonicalizes keys to avoid JSON key-order sensitivity.
   */
  public computeDelegateHash(signedDelegate: any): string {
    const canonicalStr = canonicalizeJson(signedDelegate);
    return crypto.createHash("sha256").update(canonicalStr).digest("hex");
  }

  public async verify(payload: any, requirements: any): Promise<VerifyResult> {
    try {
      // 0. Verify network matches RPC environment
      const network =
        requirements.network ?? payload.network ?? activeAssets.near.network;
      if (!this.supportsNetwork(network)) {
        return {
          isValid: false,
          invalidReason: `Unsupported NEAR network: ${network}`,
        };
      }
      if (network !== activeAssets.near.network) {
        return {
          isValid: false,
          invalidReason: `Network and RPC mismatch: configured environment is ${config.NETWORK_ENVIRONMENT}, network is ${network}`,
        };
      }

      const signedDelegate =
        payload.signedDelegate ?? payload.payload?.signedDelegate ?? payload;
      if (!signedDelegate) {
        return {
          isValid: false,
          invalidReason: "Missing signedDelegate in NEAR payload",
        };
      }

      const delegateAction =
        signedDelegate.delegateAction ??
        signedDelegate.delegate ??
        signedDelegate;
      const rawSignature = signedDelegate.signature;

      if (!delegateAction) {
        return {
          isValid: false,
          invalidReason: "Malformed delegateAction structure",
        };
      }

      const senderId = delegateAction.senderId ?? delegateAction.sender_id;
      const receiverId =
        delegateAction.receiverId ?? delegateAction.receiver_id;
      const actions = delegateAction.actions ?? [];

      if (!senderId) {
        return {
          isValid: false,
          invalidReason: "Missing senderId in delegateAction",
        };
      }

      // 1. Mandatory ReceiverId check: must not be missing and must match canonical USDC
      if (!receiverId) {
        return {
          isValid: false,
          invalidReason: "Missing receiverId in delegateAction",
          payer: senderId,
        };
      }

      const canonicalUsdc = this.getCanonicalUsdc(network);
      if (receiverId !== canonicalUsdc) {
        return {
          isValid: false,
          invalidReason: `Delegate receiverId ${receiverId} does not match canonical USDC contract ${canonicalUsdc}`,
          payer: senderId,
        };
      }

      // 2. Single-use replay protection: verify delegate hash hasn't been seen
      const delegateHash = this.computeDelegateHash(signedDelegate);
      if (this.store.isSeen("delegate", delegateHash)) {
        return {
          isValid: false,
          invalidReason:
            "NEAR SignedDelegate hash already seen (delegate action replay detected)",
          payer: senderId,
        };
      }

      // 3. Enforce expiry server-side using typed nearApi.JsonRpcProvider
      if (delegateAction.maxBlockHeight || delegateAction.max_block_height) {
        const maxBlock = BigInt(
          delegateAction.maxBlockHeight ?? delegateAction.max_block_height,
        );
        try {
          const provider = new nearApi.JsonRpcProvider({ url: this.rpcUrl });
          const statusPromise = provider.viewNodeStatus();
          const timeoutPromise = new Promise<null>((r) =>
            setTimeout(() => r(null), 1500),
          );
          const status: any = await Promise.race([
            statusPromise,
            timeoutPromise,
          ]);
          if (status?.sync_info?.latest_block_height) {
            const currentHeight = BigInt(status.sync_info.latest_block_height);
            if (currentHeight > maxBlock) {
              return {
                isValid: false,
                invalidReason: `SignedDelegate has expired (current block ${currentHeight} > max ${maxBlock})`,
                payer: senderId,
              };
            }
          }
        } catch {
          // If RPC status check is unreachable or times out, proceed to action validation
        }
      }

      // 4. Verify asset requirement matches canonical USDC
      const expectedAsset = requirements.asset ?? requirements.price?.asset;
      if (expectedAsset !== canonicalUsdc && expectedAsset !== "USDC") {
        return {
          isValid: false,
          invalidReason: `Asset mismatch: expected ${canonicalUsdc}, got ${expectedAsset}`,
          payer: senderId,
        };
      }

      // 5. Action check: MUST contain EXACTLY ONE action (reject 0 actions and extra actions)
      if (!actions || actions.length !== 1) {
        return {
          isValid: false,
          invalidReason: `SignedDelegate must contain exactly 1 action, found ${actions ? actions.length : 0}`,
          payer: senderId,
        };
      }

      const action = actions[0];
      const method =
        action.functionCall?.methodName ??
        action.method_name ??
        action.methodName;
      if (method !== "ft_transfer") {
        return {
          isValid: false,
          invalidReason: `Action method must be ft_transfer, found ${method}`,
          payer: senderId,
        };
      }

      // Check attached deposit: NEP-141 ft_transfer requires exactly 1 yoctoNEAR
      const rawDeposit = action.functionCall?.deposit ?? action.deposit ?? "0";
      const depositBig = BigInt(rawDeposit.toString());
      if (depositBig !== 1n) {
        return {
          isValid: false,
          invalidReason: `ft_transfer requires exactly 1 yoctoNEAR deposit, got ${rawDeposit}`,
          payer: senderId,
        };
      }

      // Decode and check ft_transfer args
      const rawArgs = action.functionCall?.args ?? action.args;
      let args: any;
      if (typeof rawArgs === "string") {
        // String: try base64 decode first (on-chain format), then plain JSON
        try {
          args = JSON.parse(Buffer.from(rawArgs, "base64").toString("utf8"));
        } catch {
          try {
            args = JSON.parse(rawArgs);
          } catch {
            args = {};
          }
        }
      } else if (rawArgs instanceof Uint8Array || Buffer.isBuffer(rawArgs)) {
        // Uint8Array / Buffer: near-api-js v7 stores args as UTF-8 JSON bytes
        try {
          args = JSON.parse(Buffer.from(rawArgs).toString("utf8"));
        } catch {
          args = {};
        }
      } else if (rawArgs && typeof rawArgs === "object") {
        if (rawArgs.receiver_id !== undefined) {
          args = rawArgs;
        } else if (rawArgs.type === "Buffer" && Array.isArray(rawArgs.data)) {
          try {
            args = JSON.parse(Buffer.from(rawArgs.data).toString("utf8"));
          } catch {
            args = {};
          }
        } else if (Array.isArray(rawArgs)) {
          try {
            args = JSON.parse(Buffer.from(rawArgs).toString("utf8"));
          } catch {
            args = {};
          }
        } else if (rawArgs["0"] !== undefined) {
          try {
            const bytes = Object.keys(rawArgs)
              .filter((k) => !isNaN(Number(k)))
              .sort((a, b) => Number(a) - Number(b))
              .map((k) => rawArgs[k]);
            args = JSON.parse(Buffer.from(bytes).toString("utf8"));
          } catch {
            args = {};
          }
        } else {
          args = rawArgs;
        }
      } else {
        args = rawArgs ?? {};
      }

      const expectedPayTo = requirements.payTo;
      if (args.receiver_id !== expectedPayTo) {
        return {
          isValid: false,
          invalidReason: `Recipient mismatch: expected ${expectedPayTo}, got ${args.receiver_id}`,
          payer: senderId,
        };
      }

      const expectedAmount = BigInt(
        requirements.amount ?? requirements.price?.amount,
      );
      const actualAmount = BigInt(args.amount ?? "0");
      if (actualAmount !== expectedAmount) {
        return {
          isValid: false,
          invalidReason: `ft_transfer amount mismatch: expected ${expectedAmount}, got ${actualAmount}`,
          payer: senderId,
        };
      }

      // 6. Mandatory NEP-366 Cryptographic Signature Verification
      if (!rawSignature) {
        return {
          isValid: false,
          invalidReason:
            "Missing cryptographic signature in SignedDelegate payload",
          payer: senderId,
        };
      }

      try {
        const pubKeyRaw = delegateAction.publicKey ?? delegateAction.public_key;
        if (!pubKeyRaw) {
          return {
            isValid: false,
            invalidReason:
              "Missing public key in delegateAction for signature verification",
            payer: senderId,
          };
        }

        const publicKey = normalizePublicKey(pubKeyRaw);
        if (!publicKey) {
          return {
            isValid: false,
            invalidReason:
              "Missing or invalid public key in delegateAction for signature verification",
            payer: senderId,
          };
        }

        // Serialize the delegate action according to Borsh NEP-366 schema
        const normalizedActions = normalizeDelegateActions(
          delegateAction.actions,
        );
        const serializedDelegate = nearApi.encodeDelegateAction(
          delegateAction instanceof nearApi.DelegateAction
            ? delegateAction
            : nearApi.buildDelegateAction({
                senderId: delegateAction.senderId ?? delegateAction.sender_id,
                receiverId:
                  delegateAction.receiverId ?? delegateAction.receiver_id,
                actions: normalizedActions,
                nonce: BigInt(delegateAction.nonce),
                maxBlockHeight: BigInt(
                  delegateAction.maxBlockHeight ??
                    delegateAction.max_block_height,
                ),
                publicKey,
              }),
        );

        const msgHash = crypto
          .createHash("sha256")
          .update(serializedDelegate)
          .digest();
        const sigBytes = normalizeSignatureBytes(rawSignature);

        const isSignatureValid = publicKey.verify(msgHash, sigBytes);
        if (!isSignatureValid) {
          return {
            isValid: false,
            invalidReason:
              "Invalid cryptographic signature on NEAR SignedDelegate",
            payer: senderId,
          };
        }
      } catch (sigErr: any) {
        return {
          isValid: false,
          invalidReason: `NEAR signature verification error: ${sigErr.message}`,
          payer: senderId,
        };
      }

      return { isValid: true, payer: senderId };
    } catch (err: any) {
      return {
        isValid: false,
        invalidReason: `NEAR verify error: ${err.message}`,
      };
    }
  }

  public async settle(payload: any, requirements: any): Promise<SettleResult> {
    try {
      // 1. Explicit Re-verify at settle time
      const verifyRes = await this.verify(payload, requirements);
      if (!verifyRes.isValid) {
        return { success: false, errorReason: verifyRes.invalidReason };
      }

      if (!this.relayerPrivateKey || !this.relayerAccountId) {
        return {
          success: false,
          errorReason:
            "NEAR relayer private key or account ID not configured on facilitator",
        };
      }

      const signedDelegate =
        payload.signedDelegate ?? payload.payload?.signedDelegate ?? payload;
      const delegateHash = this.computeDelegateHash(signedDelegate);

      // 2. Gas fee check and merchant budget enforcement
      const feeCheck = checkMerchantCreditAndGasBudget(
        requirements.network,
        requirements.payTo,
        this.relayerAccountId,
        30_000_000_000_000n, // 30 TGas estimated
        100_000_000n, // gas price
      );
      if (!feeCheck.allowed) {
        return {
          success: false,
          errorReason:
            feeCheck.reason ??
            "Merchant gas budget or credit validation failed",
        };
      }

      // 3. Broadcast SignedDelegate on-chain via Relayer
      try {
        const provider = new nearApi.JsonRpcProvider({ url: this.rpcUrl });
        const relayerKp = nearApi.KeyPair.fromString(
          this.relayerPrivateKey as any,
        );
        const payerAccountId = verifyRes.payer!;

        let actionToSubmit: any;
        if (payload.signedDelegateAction) {
          actionToSubmit = payload.signedDelegateAction;
        } else if (signedDelegate.delegateAction && signedDelegate.signature) {
          const sigBytes = normalizeSignatureBytes(signedDelegate.signature);
          const sigObj = new nearApi.Signature({
            keyType: nearApi.KeyType.ED25519,
            data: sigBytes,
          });

          const normalizedActions = normalizeDelegateActions(
            signedDelegate.delegateAction.actions,
          );
          const delAction =
            signedDelegate.delegateAction instanceof nearApi.DelegateAction
              ? signedDelegate.delegateAction
              : nearApi.buildDelegateAction({
                  senderId:
                    signedDelegate.delegateAction.senderId ??
                    signedDelegate.delegateAction.sender_id,
                  receiverId:
                    signedDelegate.delegateAction.receiverId ??
                    signedDelegate.delegateAction.receiver_id,
                  actions: normalizedActions,
                  nonce: BigInt(signedDelegate.delegateAction.nonce),
                  maxBlockHeight: BigInt(
                    signedDelegate.delegateAction.maxBlockHeight ??
                      signedDelegate.delegateAction.max_block_height,
                  ),
                  publicKey: normalizePublicKey(
                    signedDelegate.delegateAction.publicKey,
                  )!,
                });

          actionToSubmit = nearApi.actions.signedDelegate({
            delegateAction: delAction,
            signature: sigObj,
          });
        }

        if (!actionToSubmit) {
          return {
            success: false,
            errorReason:
              "Could not construct valid SignedDelegate action for relayer submission",
          };
        }

        const accessKeyRes = await provider.viewAccessKey({
          accountId: this.relayerAccountId,
          publicKey: relayerKp.getPublicKey(),
        });
        const blockRes = await provider.viewBlock({ finality: "final" });
        const blockHash = nearApi.baseDecode(blockRes.header.hash);

        // Outer transaction: receiver_id is the payer (senderId of the delegate action)
        const tx = nearApi.createTransaction(
          this.relayerAccountId,
          relayerKp.getPublicKey(),
          payerAccountId,
          BigInt(accessKeyRes.nonce) + 1n,
          [actionToSubmit],
          blockHash,
        );

        const serializedTx = nearApi.encodeTransaction(tx);
        const hash = crypto.createHash("sha256").update(serializedTx).digest();
        const sig = relayerKp.sign(hash);
        const signatureObj = new nearApi.Signature({
          keyType: nearApi.KeyType.ED25519,
          data: sig.signature,
        });
        const signedTx = new nearApi.SignedTransaction({
          transaction: tx,
          signature: signatureObj,
        });

        const res = await provider.sendTransaction(signedTx);
        const txHash = res.transaction?.hash;

        if (!txHash) {
          return {
            success: false,
            errorReason: "NEAR RPC response did not contain transaction hash",
            payer: verifyRes.payer,
          };
        }

        // Mark delegate seen ONLY after successful broadcast (24h TTL)
        this.store.markSeen("delegate", delegateHash, 86400);

        return {
          success: true,
          transaction: txHash,
          network: requirements.network,
          payer: verifyRes.payer,
        };
      } catch (submitErr: any) {
        // Broadcast failed: do NOT mark delegate seen, allowing retry
        return {
          success: false,
          errorReason: `NEAR relayer on-chain broadcast failed: ${submitErr.message}`,
          payer: verifyRes.payer,
        };
      }
    } catch (err: any) {
      return {
        success: false,
        errorReason: `NEAR settle error: ${err.message}`,
      };
    }
  }
}
