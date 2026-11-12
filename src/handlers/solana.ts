/**
 * solana.ts — SVM partial-transaction validation, fee-payer co-sign, and submit
 */

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import type {
  NetworkHandler,
  VerifyResult,
  SettleResult,
  SupportedKind,
} from "../types/driver.types";
import { getPaymentStore } from "../lib/payments";
import { activeAssets, config, isTestnet } from "../config";
import { checkMerchantCreditAndGasBudget, SOLANA_DEFAULTS } from "../lib/fees";

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSOCIATED_TOKEN_PROGRAM_ID =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

export interface SolanaHandlerOptions {
  rpcUrl?: string;
  feePayerPrivateKey?: string;
}

export class SolanaHandler implements NetworkHandler {
  readonly networkId = activeAssets.solana.network;
  readonly scheme = "exact";

  private connection: Connection;
  private feePayer?: Keypair;
  private feePayerPromise?: Promise<Keypair>;
  private feePayerPubkey?: string;
  private rpcUrl: string;
  private store = getPaymentStore();

  constructor(opts?: SolanaHandlerOptions) {
    this.rpcUrl = opts?.rpcUrl ?? config.SOLANA_RPC_URL;
    this.connection = new Connection(this.rpcUrl, "confirmed");

    const privKey =
      opts?.feePayerPrivateKey ?? config.SOLANA_FEE_PAYER_PRIVATE_KEY;
    if (privKey) {
      try {
        const decoded = bs58.decode(privKey);
        if (decoded.length === 64) {
          this.feePayerPubkey = new PublicKey(decoded.slice(32, 64)).toBase58();
          console.log(
            `[Solana Module] Fee payer pubkey: ${this.feePayerPubkey}`,
          );
        }
        const res = Keypair.fromSecretKey(decoded) as any;
        if (res && typeof res.then === "function") {
          this.feePayerPromise = res;
          res.then((kp: Keypair) => {
            this.feePayer = kp;
            this.feePayerPubkey = kp.publicKey.toBase58();
          });
        } else {
          this.feePayer = res;
          this.feePayerPubkey = res.publicKey.toBase58();
        }
      } catch (err: any) {
        throw new Error(
          `[Solana Module] Failed to initialize fee payer key: ${err.message}`,
        );
      }
    }
  }

  private async ensureFeePayer(): Promise<Keypair | undefined> {
    if (!this.feePayer && this.feePayerPromise) {
      this.feePayer = await this.feePayerPromise;
    }
    return this.feePayer;
  }

  public supportsNetwork(network: string): boolean {
    return network.startsWith("solana:");
  }

  public getSupportedKinds(isTestnet: boolean): SupportedKind[] {
    const feePayer = this.getFeePayerPublicKey();
    const extra = feePayer ? { feePayer } : undefined;

    return [
      {
        x402Version: 2,
        scheme: "exact",
        network: activeAssets.solana.network,
        asset: activeAssets.solana.usdc,
        ...(extra ? { extra } : {}),
      },
    ];
  }

  public getFeePayerPublicKey(): string | null {
    if (this.feePayerPubkey) return this.feePayerPubkey;
    return this.feePayer?.publicKey ? this.feePayer.publicKey.toBase58() : null;
  }

  public getCanonicalUsdc(network: string): string {
    return network === activeAssets.solana.network
      ? activeAssets.solana.usdc
      : "";
  }

  public async verify(payload: any, requirements: any): Promise<VerifyResult> {
    try {
      // 0. Verify network matches configured RPC
      const network = requirements.network ?? payload.network;
      if (!network || !this.supportsNetwork(network)) {
        return {
          isValid: false,
          invalidReason: `Unsupported Solana network: ${network}`,
        };
      }
      if (network !== activeAssets.solana.network) {
        return {
          isValid: false,
          invalidReason: `Network and RPC mismatch: configured environment is ${config.NETWORK_ENVIRONMENT}, network is ${network}`,
        };
      }

      const txBase64 = payload.transaction ?? payload.payload?.transaction;
      if (!txBase64) {
        return {
          isValid: false,
          invalidReason: "Missing transaction in Solana payload",
        };
      }

      let tx: VersionedTransaction;
      try {
        tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
      } catch (err: any) {
        return {
          isValid: false,
          invalidReason: `Invalid Solana versioned transaction format: ${err.message}`,
        };
      }

      const message = tx.message;
      const staticKeys = message.staticAccountKeys;
      if (staticKeys.length < 2) {
        return {
          isValid: false,
          invalidReason: "Malformed transaction: not enough account keys",
        };
      }

      const feePayerKey = staticKeys[0].toBase58();
      // Ensure facilitator is the fee payer if configured
      const expectedFeePayer = this.getFeePayerPublicKey();
      if (expectedFeePayer && feePayerKey !== expectedFeePayer) {
        return {
          isValid: false,
          invalidReason: `Fee payer ${feePayerKey} does not match expected facilitator ${expectedFeePayer}`,
        };
      }

      // Check instructions count (must match message: 3 to 6 instructions)
      const compiledInstructions = message.compiledInstructions;
      if (compiledInstructions.length < 3 || compiledInstructions.length > 6) {
        return {
          isValid: false,
          invalidReason: `Invalid instruction count: expected 3-6, found ${compiledInstructions.length}`,
        };
      }

      // Replay protection: Keyed on payer payment signature, NOT on blockhash
      const payerSigBytes =
        tx.signatures.length > 1 ? tx.signatures[1] : tx.signatures[0];
      const payerSignature = bs58.encode(payerSigBytes);
      const replayKey = `solana:sig:${payerSignature}`;
      if (this.store.isSeen("nonce", replayKey)) {
        return {
          isValid: false,
          invalidReason:
            "Solana payment signature already seen in settlement cache (replay protection)",
        };
      }

      // Check live blockhash validity with reasonable timeout — FAIL CLOSED on error or timeout
      const recentBlockhash = message.recentBlockhash;
      try {
        const checkPromise = this.connection.isBlockhashValid(recentBlockhash, {
          commitment: "confirmed",
        });
        const timeoutPromise = new Promise<{ value: boolean }>((_, reject) =>
          setTimeout(
            () => reject(new Error("RPC blockhash liveness check timeout")),
            5000,
          ),
        );
        const isValidBlockhash = await Promise.race([
          checkPromise,
          timeoutPromise,
        ]);
        if (!isValidBlockhash.value) {
          return {
            isValid: false,
            invalidReason:
              "Solana blockhash has expired (requires fresh blockhash and re-sign)",
          };
        }
      } catch (err: any) {
        // Fail-closed on timeout or RPC error
        return {
          isValid: false,
          invalidReason: `Failed to verify Solana blockhash liveness: ${err.message}`,
        };
      }

      // Fee payer must not appear as authority, source, or destination in static or ALT keys
      const fp = this.getFeePayerPublicKey();
      if (fp) {
        for (let i = 1; i < staticKeys.length; i++) {
          if (staticKeys[i].toBase58() === fp) {
            return {
              isValid: false,
              invalidReason:
                "Fee payer must not appear as authority, source, or destination in transaction",
            };
          }
        }
      }

      // DECODE & VERIFY TransferChecked Instruction
      // Fast path: find TransferChecked (discriminator 12) in compiled instructions
      let transferFound = false;
      let actualAmount = 0n;
      let actualRecipient = "";
      let actualMint = "";
      let instructionAuthority = "";

      const canonicalUsdc = this.getCanonicalUsdc(network);

      for (const ix of compiledInstructions) {
        const progKey = staticKeys[ix.programIdIndex]?.toBase58();
        if (progKey === TOKEN_PROGRAM_ID || progKey === TOKEN_2022_PROGRAM_ID) {
          const data = ix.data;
          // Discriminator for TransferChecked is 12 (0x0c)
          if (data && data.length >= 10 && data[0] === 12) {
            // Read 64-bit integer amount (little-endian)
            const view = new DataView(data.buffer, data.byteOffset + 1, 8);
            actualAmount = view.getBigUint64(0, true);
            const decimals = data[9];

            if (decimals !== 6) {
              return {
                isValid: false,
                invalidReason: `Invalid token decimals: expected 6 for USDC, got ${decimals}`,
              };
            }

            const accounts = ix.accountKeyIndexes;
            if (accounts.length >= 4) {
              actualMint = staticKeys[accounts[1]]?.toBase58() ?? "";
              actualRecipient = staticKeys[accounts[2]]?.toBase58() ?? "";
              instructionAuthority = staticKeys[accounts[3]]?.toBase58() ?? "";
              transferFound = true;
              break;
            }
          }
        }
      }

      if (!transferFound) {
        return {
          isValid: false,
          invalidReason:
            "No valid TransferChecked instruction found in transaction",
        };
      }

      // 1. Verify exact amount
      const expectedAmount = BigInt(
        requirements.amount ?? requirements.price?.amount,
      );
      if (actualAmount !== expectedAmount) {
        return {
          isValid: false,
          invalidReason: `Amount mismatch: expected ${expectedAmount}, got ${actualAmount}`,
          payer: instructionAuthority,
        };
      }

      // 2. Verify exact recipient (payTo direct account or ATA of payTo)
      let isRecipientValid = actualRecipient === requirements.payTo;
      if (!isRecipientValid && requirements.payTo && actualMint) {
        try {
          const ownerPubkey = new PublicKey(requirements.payTo);
          const mintPubkey = new PublicKey(actualMint);
          const programId = new PublicKey(TOKEN_PROGRAM_ID);
          const ataProgramId = new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID);
          const [expectedAta] = await PublicKey.findProgramAddress(
            [ownerPubkey.toBytes(), programId.toBytes(), mintPubkey.toBytes()],
            ataProgramId,
          );
          if (actualRecipient === expectedAta.toBase58()) {
            isRecipientValid = true;
          }
        } catch {
          // ignore parsing error
        }
      }

      if (!isRecipientValid) {
        return {
          isValid: false,
          invalidReason: `Recipient mismatch: expected ${requirements.payTo}, got ${actualRecipient}`,
          payer: instructionAuthority,
        };
      }

      // 3. Verify canonical mint matches requirements and network
      if (actualMint !== canonicalUsdc) {
        return {
          isValid: false,
          invalidReason: `Token mint mismatch: expected canonical USDC ${canonicalUsdc}, got ${actualMint}`,
          payer: instructionAuthority,
        };
      }

      if (requirements.asset && requirements.asset !== canonicalUsdc) {
        return {
          isValid: false,
          invalidReason: `Requirements asset ${requirements.asset} does not match canonical USDC ${canonicalUsdc}`,
          payer: instructionAuthority,
        };
      }

      // 4. Verify authority is not the fee payer and is a transaction signer
      if (fp && instructionAuthority === fp) {
        return {
          isValid: false,
          invalidReason: "TransferChecked authority cannot be the fee payer",
          payer: instructionAuthority,
        };
      }

      return { isValid: true, payer: instructionAuthority };
    } catch (err: any) {
      return {
        isValid: false,
        invalidReason: `Solana verify error: ${err.message}`,
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

      await this.ensureFeePayer();
      if (!this.feePayer) {
        return {
          success: false,
          errorReason:
            "Solana fee payer private key not configured on facilitator",
        };
      }

      const txBase64 = payload.transaction ?? payload.payload?.transaction;
      const tx = VersionedTransaction.deserialize(
        Buffer.from(txBase64, "base64"),
      );
      const blockhash = tx.message.recentBlockhash;

      // 2. Check blockhash liveness at settle time (fail-closed)
      try {
        const checkPromise = this.connection.isBlockhashValid(blockhash, {
          commitment: "confirmed",
        });
        const timeoutPromise = new Promise<{ value: boolean }>((_, reject) =>
          setTimeout(
            () => reject(new Error("RPC blockhash check timeout")),
            5000,
          ),
        );
        const isValid = await Promise.race([checkPromise, timeoutPromise]);
        if (!isValid.value) {
          return {
            success: false,
            errorReason:
              "Solana blockhash expired at settle time. Re-signable 402 required.",
          };
        }
      } catch (err: any) {
        return {
          success: false,
          errorReason: `Solana blockhash liveness check failed at settle: ${err.message}`,
        };
      }

      // 3. Replay Protection: Single-use check on payer's transaction signature
      const payerSigBytes =
        tx.signatures.length > 1 ? tx.signatures[1] : tx.signatures[0];
      const payerSignature = bs58.encode(payerSigBytes);
      const replayKey = `solana:sig:${payerSignature}`;

      const marked = this.store.markSeen("nonce", replayKey, 120);
      if (!marked) {
        return {
          success: false,
          errorReason:
            "Solana payment signature already settled (duplicate settle)",
        };
      }

      // 4. Gas fee check and merchant budget enforcement
      const feeCheck = checkMerchantCreditAndGasBudget(
        requirements.network,
        requirements.payTo,
        this.feePayer.publicKey.toBase58(),
        BigInt(SOLANA_DEFAULTS.COMPUTE_UNITS_LIMIT),
        BigInt(SOLANA_DEFAULTS.MIN_MICROLAMPORTS),
      );
      if (!feeCheck.allowed) {
        this.store.unmark("nonce", replayKey);
        return {
          success: false,
          errorReason:
            feeCheck.reason ??
            "Merchant gas budget or credit validation failed",
        };
      }

      // 5. Co-sign as fee payer
      await tx.sign([this.feePayer]);

      try {
        const rawTx = tx.serialize();
        const txid = await this.connection.sendRawTransaction(rawTx, {
          skipPreflight: false,
          preflightCommitment: "confirmed",
        });

        // Wait for confirmation using the transaction's OWN blockhash
        const latestBh = await this.connection.getLatestBlockhash("confirmed");
        const confirmRes = await this.connection.confirmTransaction(
          {
            signature: txid,
            blockhash: blockhash, // Uses tx's own blockhash
            lastValidBlockHeight: latestBh.lastValidBlockHeight,
          },
          "confirmed",
        );

        if (confirmRes.value.err) {
          this.store.unmark("nonce", replayKey);
          return {
            success: false,
            errorReason: `Solana transaction failed on-chain: ${JSON.stringify(confirmRes.value.err)}`,
            payer: verifyRes.payer,
          };
        }

        return {
          success: true,
          transaction: txid,
          network: requirements.network,
          payer: verifyRes.payer,
        };
      } catch (sendErr: any) {
        // Unmark seen on send failure so transaction can be legitimately retried if not broadcast
        this.store.unmark("nonce", replayKey);
        return {
          success: false,
          errorReason: `Solana sendRawTransaction failed: ${sendErr.message}`,
          payer: verifyRes.payer,
        };
      }
    } catch (err: any) {
      return {
        success: false,
        errorReason: `Solana settle error: ${err.message}`,
      };
    }
  }
}
