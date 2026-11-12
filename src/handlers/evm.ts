/**
 * evm.ts — EIP-3009 TransferWithAuthorization handler for EVM (Base, Base Sepolia)
 */

import {
  recoverTypedDataAddress,
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import type {
  NetworkHandler,
  VerifyResult,
  SettleResult,
  SupportedKind,
} from "../types/driver.types";
import { getPaymentStore } from "../lib/payments";
import { activeAssets, config, isTestnet } from "../config";
import { checkMerchantCreditAndGasBudget } from "../lib/fees";

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface EVMHandlerOptions {
  rpcUrl?: string;
  submitterPrivateKey?: string;
}

export class EVMHandler implements NetworkHandler {
  readonly networkId = activeAssets.base.network;
  readonly scheme = "exact";

  private rpcUrl: string;
  private submitterPrivateKey?: string;
  private store = getPaymentStore();

  constructor(opts?: EVMHandlerOptions) {
    this.rpcUrl = opts?.rpcUrl ?? config.BASE_RPC_URL;
    this.submitterPrivateKey =
      opts?.submitterPrivateKey ?? config.EVM_SUBMITTER_PRIVATE_KEY;
  }

  /**
   * Only accept Base mainnet (8453) and Base Sepolia (84532)
   */
  public supportsNetwork(network: string): boolean {
    return network === activeAssets.base.network;
  }

  public getSupportedKinds(isTestnet: boolean): SupportedKind[] {
    return [
      {
        x402Version: 2,
        scheme: "exact",
        network: activeAssets.base.network,
        asset: activeAssets.base.usdc,
        methods: ["eip3009"],
      },
    ];
  }

  public getCanonicalUsdc(network: string): string {
    return network === activeAssets.base.network ? activeAssets.base.usdc : "";
  }

  private extractChainId(network: string): number {
    const parts = network.split(":");
    const id = parseInt(parts[1], 10);
    const activeId = Number(activeAssets.base.network.split(":")[1]);
    if (isNaN(id) || id !== activeId) {
      throw new Error(
        `Unsupported EVM network: ${network}. Only ${activeAssets.base.network} is active.`,
      );
    }
    return id;
  }

  public async verify(payload: any, requirements: any): Promise<VerifyResult> {
    try {
      const network = requirements.network ?? payload.network;
      if (!network || !this.supportsNetwork(network)) {
        return {
          isValid: false,
          invalidReason: `Unsupported EVM network: ${network}`,
        };
      }

      let chainId: number;
      try {
        chainId = this.extractChainId(network);
      } catch (err: any) {
        return { isValid: false, invalidReason: err.message };
      }

      const auth =
        payload.authorization ?? payload.payload?.authorization ?? payload;
      const signature = (payload.signature ??
        payload.payload?.signature) as Hex;

      if (!auth || !signature) {
        return {
          isValid: false,
          invalidReason: "Missing authorization or signature in payload",
        };
      }

      const { from, to, value, validAfter, validBefore, nonce } = auth;
      if (
        !from ||
        !to ||
        value === undefined ||
        !validAfter ||
        !validBefore ||
        !nonce
      ) {
        return {
          isValid: false,
          invalidReason: "Malformed EIP-3009 authorization structure",
        };
      }

      // 1. Amount match (as BigInt, never floats)
      const expectedAmount = BigInt(
        requirements.amount ?? requirements.price?.amount,
      );
      const actualAmount = BigInt(value);
      if (actualAmount !== expectedAmount) {
        return {
          isValid: false,
          invalidReason: `Amount mismatch: expected ${expectedAmount}, got ${actualAmount}`,
          payer: from,
        };
      }

      // 2. Recipient match (case insensitive check for Ethereum addresses)
      if (to.toLowerCase() !== requirements.payTo.toLowerCase()) {
        return {
          isValid: false,
          invalidReason: `Recipient mismatch: expected ${requirements.payTo}, got ${to}`,
          payer: from,
        };
      }

      // 3. Canonical asset check: only accept canonical Base USDC for the chain
      const canonicalUsdc = this.getCanonicalUsdc(network);
      const reqAsset = requirements.asset ?? requirements.price?.asset;
      if (reqAsset.toLowerCase() !== canonicalUsdc.toLowerCase()) {
        return {
          isValid: false,
          invalidReason: `Asset mismatch: expected canonical Base USDC ${canonicalUsdc}, got ${reqAsset}`,
          payer: from,
        };
      }

      // 4. Time validity window check
      const now = BigInt(Math.floor(Date.now() / 1000));
      const vAfter = BigInt(validAfter);
      const vBefore = BigInt(validBefore);

      if (now < vAfter) {
        return {
          isValid: false,
          invalidReason: `Authorization not yet valid (validAfter: ${vAfter})`,
          payer: from,
        };
      }
      if (now >= vBefore) {
        return {
          isValid: false,
          invalidReason: `Authorization has expired (validBefore: ${vBefore})`,
          payer: from,
        };
      }

      // 5. Check replay against durable store (EIP-3009 nonce single-use)
      const nonceKey = `${network}:${from.toLowerCase()}:${nonce.toLowerCase()}`;
      if (this.store.isSeen("nonce", nonceKey)) {
        return {
          isValid: false,
          invalidReason: "EIP-3009 nonce has already been used",
          payer: from,
        };
      }

      // 6. Verify EIP-712 signature against canonical USDC contract
      const assetAddress = canonicalUsdc as Address;
      const tokenName = requirements.extra?.name ?? "USD Coin";
      const tokenVersion = requirements.extra?.version ?? "2";

      const domain = {
        name: tokenName,
        version: tokenVersion,
        chainId,
        verifyingContract: assetAddress,
      };

      const message = {
        from: from as Address,
        to: to as Address,
        value: actualAmount,
        validAfter: vAfter,
        validBefore: vBefore,
        nonce: nonce as Hex,
      };

      try {
        const recoveredAddress = await recoverTypedDataAddress({
          domain,
          types: EIP3009_TYPES,
          primaryType: "TransferWithAuthorization",
          message,
          signature,
        });

        if (recoveredAddress.toLowerCase() !== from.toLowerCase()) {
          return {
            isValid: false,
            invalidReason: `Recovered signer ${recoveredAddress} != claimed payer ${from}`,
            payer: from,
          };
        }
      } catch (err: any) {
        return {
          isValid: false,
          invalidReason: `EIP-712 signature verification failed: ${err.message}`,
          payer: from,
        };
      }

      return { isValid: true, payer: from };
    } catch (err: any) {
      return {
        isValid: false,
        invalidReason: `EVM verify error: ${err.message}`,
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

      if (!this.submitterPrivateKey) {
        return {
          success: false,
          errorReason:
            "EVM submitter private key not configured on facilitator",
        };
      }

      const network = requirements.network;
      const auth =
        payload.authorization ?? payload.payload?.authorization ?? payload;
      const nonceKey = `${network}:${auth.from.toLowerCase()}:${auth.nonce.toLowerCase()}`;

      // 2. Mark nonce used atomically with TTL = max(remaining validity, 86400s / 1 day)
      const ttl = Math.max(
        Number(
          BigInt(auth.validBefore) - BigInt(Math.floor(Date.now() / 1000)),
        ),
        86400,
      );
      const marked = this.store.markSeen("nonce", nonceKey, ttl);
      if (!marked) {
        return {
          success: false,
          errorReason: "Nonce already used concurrently",
        };
      }

      // 3. Gas fee check and merchant budget enforcement
      const feeCheck = checkMerchantCreditAndGasBudget(
        network,
        requirements.payTo,
        "evm-submitter",
        80_000n, // typical transferWithAuthorization gas
        1_000_000_000n, // 1 gwei
      );
      if (!feeCheck.allowed) {
        this.store.unmark("nonce", nonceKey);
        return {
          success: false,
          errorReason:
            feeCheck.reason ??
            "Merchant gas budget or credit validation failed",
        };
      }

      // 4. Submit on-chain via Submitter Account
      const chain = isTestnet ? baseSepolia : base;
      const account = privateKeyToAccount(this.submitterPrivateKey as Hex);
      const client = createPublicClient({
        chain,
        transport: http(this.rpcUrl),
      });
      const wallet = createWalletClient({
        account,
        chain,
        transport: http(this.rpcUrl),
      });

      // Split signature into v, r, s
      const sig = (payload.signature ?? payload.payload?.signature) as Hex;
      const r = `0x${sig.slice(2, 66)}` as Hex;
      const s = `0x${sig.slice(66, 130)}` as Hex;
      const v = parseInt(sig.slice(130, 132), 16);

      const assetAddress = this.getCanonicalUsdc(network) as Address;

      const abi = [
        {
          name: "transferWithAuthorization",
          type: "function",
          stateMutability: "nonpayable",
          inputs: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
            { name: "v", type: "uint8" },
            { name: "r", type: "bytes32" },
            { name: "s", type: "bytes32" },
          ],
          outputs: [],
        },
      ] as const;

      try {
        const hash = await wallet.writeContract({
          address: assetAddress,
          abi,
          functionName: "transferWithAuthorization",
          args: [
            auth.from as Address,
            auth.to as Address,
            BigInt(auth.value),
            BigInt(auth.validAfter),
            BigInt(auth.validBefore),
            auth.nonce as Hex,
            v,
            r,
            s,
          ],
        });

        // 5. Wait for on-chain receipt and check status strictly
        const receipt = await client.waitForTransactionReceipt({
          hash,
          confirmations: 1,
        });
        if (receipt.status !== "success") {
          this.store.unmark("nonce", nonceKey);
          return {
            success: false,
            errorReason: `On-chain EVM transaction reverted (status: ${receipt.status})`,
            payer: auth.from,
          };
        }

        return {
          success: true,
          transaction: hash,
          network,
          payer: auth.from,
        };
      } catch (submitErr: any) {
        // Unmark nonce on submit failure so authorization can be retried if not mined
        this.store.unmark("nonce", nonceKey);
        return {
          success: false,
          errorReason: `EVM submission failed: ${submitErr.message}`,
          payer: auth.from,
        };
      }
    } catch (err: any) {
      return {
        success: false,
        errorReason: `EVM settle failed: ${err.message}`,
      };
    }
  }
}
