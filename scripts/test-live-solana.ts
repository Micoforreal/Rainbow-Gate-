/**
 * test-live-solana.ts
 *
 * 1. Derives fee payer from SOLANA_FEE_PAYER_PRIVATE_KEY in .env (BhnV...)
 * 2. Creates a separate payer wallet and moves $3 USDC to it.
 * 3. Verifies payer has $3 USDC and 0 SOL.
 * 4. Builds x402 partial versioned transaction with TransferChecked to merchant ATA.
 * 5. Passes to orangeGate SolanaHandler.verify() and settle() to co-sign and broadcast.
 * 6. Logs the live on-chain Solana devnet tx hash.
 */

import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');
import dotenv from 'dotenv';
dotenv.config();

import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import bs58Mod from 'bs58';
const bs58 = (bs58Mod as any).default || bs58Mod;
import { SolanaHandler } from '../src/handlers/solana';

const RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

async function getAta(owner: PublicKey, mint = USDC_MINT): Promise<PublicKey> {
  const [ata] = await PublicKey.findProgramAddress(
    [owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

function createAtaInstruction(payer: PublicKey, ata: PublicKey, owner: PublicKey, mint = USDC_MINT) {
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: new Uint8Array(0),
  };
}

function createTransferCheckedInstruction(
  sourceAta: PublicKey,
  mint: PublicKey,
  destAta: PublicKey,
  owner: PublicKey,
  amount: bigint,
  decimals = 6,
) {
  const data = new Uint8Array(10);
  data[0] = 12; // TransferChecked instruction index
  new DataView(data.buffer).setBigUint64(1, amount, true);
  data[9] = decimals;

  return {
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: sourceAta, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destAta, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  };
}

async function main() {
  const conn = new Connection(RPC_URL, 'confirmed');

  // 1. Fee Payer (BhnV...)
  const feePayerSecret = bs58.decode(process.env.SOLANA_FEE_PAYER_PRIVATE_KEY!);
  const feePayer = await Keypair.fromSecretKey(feePayerSecret);
  const feePayerPub = feePayer.publicKey;
  const feePayerAta = await getAta(feePayerPub);

  console.log(`[Fee Payer]: ${feePayerPub.toBase58()}`);
  console.log(`[Fee Payer ATA]: ${feePayerAta.toBase58()}`);

  // 2. Separate Payer Wallet
  const payer = await Keypair.generate();
  const payerPub = payer.publicKey;
  const payerAta = await getAta(payerPub);
  console.log(`[Separate Payer Wallet]: ${payerPub.toBase58()}`);
  console.log(`[Separate Payer ATA]: ${payerAta.toBase58()}`);

  // 3. Merchant Wallet & ATA
  const merchant = await Keypair.generate();
  const merchantPub = merchant.publicKey;
  const merchantAta = await getAta(merchantPub);
  console.log(`[Merchant Wallet]: ${merchantPub.toBase58()}`);
  console.log(`[Merchant ATA]: ${merchantAta.toBase58()}`);

  // Step A: Fund Payer ATA with $3 USDC from Fee Payer
  console.log('\n--- Step A: Moving $3 USDC from Fee Payer to Payer Wallet ---');
  const setupIxs = [
    createAtaInstruction(feePayerPub, payerAta, payerPub),
    createAtaInstruction(feePayerPub, merchantAta, merchantPub),
    createTransferCheckedInstruction(feePayerAta, USDC_MINT, payerAta, feePayerPub, 3_000_000n, 6),
  ];

  const latestBh = await conn.getLatestBlockhash('confirmed');
  const setupMsg = new TransactionMessage({
    payerKey: feePayerPub,
    recentBlockhash: latestBh.blockhash,
    instructions: setupIxs,
  }).compileToV0Message();

  const setupTx = new VersionedTransaction(setupMsg);
  await setupTx.sign([feePayer]);

  console.log('Broadcasting setup transaction...');
  const setupTxid = await conn.sendRawTransaction(setupTx.serialize(), { preflightCommitment: 'confirmed' });
  console.log(`Setup tx sent: ${setupTxid}`);
  await conn.confirmTransaction({ signature: setupTxid, ...latestBh }, 'confirmed');
  console.log('Setup confirmed!');

  // Check balances
  const payerSolBal = await conn.getBalance(payerPub);
  console.log(`Payer SOL Balance: ${Number(payerSolBal) / 1e9} SOL (Must be 0 SOL)`);

  const payerTokenAccounts = await conn.getParsedTokenAccountsByOwner(payerPub, { mint: USDC_MINT });
  console.log(`Payer USDC Balance: ${payerTokenAccounts.value[0]?.account.data.parsed.info.tokenAmount.uiAmountString} USDC`);

  // Step B: Build x402 Partial Versioned Transaction
  console.log('\n--- Step B: Building x402 Partial Transaction (Payer signs, Fee Payer does not) ---');
  const freshBh = await conn.getLatestBlockhash('confirmed');
  const memoText = `orangeGate:payment:${Date.now()}`;

  const x402Ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    createTransferCheckedInstruction(payerAta, USDC_MINT, merchantAta, payerPub, 1_000_000n, 6), // $1 USDC
    {
      programId: MEMO_PROGRAM_ID,
      keys: [{ pubkey: payerPub, isSigner: true, isWritable: false }],
      data: Buffer.from(memoText, 'utf8'),
    },
  ];

  const x402Msg = new TransactionMessage({
    payerKey: feePayerPub, // Fee payer set to BhnV...
    recentBlockhash: freshBh.blockhash,
    instructions: x402Ixs,
  }).compileToV0Message();

  const partialTx = new VersionedTransaction(x402Msg);
  await partialTx.sign([payer]); // Payer partially signs as token authority

  const payload = {
    transaction: Buffer.from(partialTx.serialize()).toString('base64'),
  };

  const requirements = {
    scheme: 'exact',
    network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    amount: '1000000',
    asset: USDC_MINT.toBase58(),
    payTo: merchantAta.toBase58(),
  };

  // Step C: Execute Facilitator Verification and Settlement
  console.log('\n--- Step C: Facilitator /verify and /settle ---');
  const handler = new SolanaHandler({
    rpcUrl: RPC_URL,
    feePayerPrivateKey: process.env.SOLANA_FEE_PAYER_PRIVATE_KEY,
  });

  console.log('1. Verifying partial transaction...');
  const verifyResult = await handler.verify(payload, requirements);
  console.log('Verify result:', verifyResult);
  if (!verifyResult.isValid) {
    throw new Error(`Verification rejected: ${verifyResult.invalidReason}`);
  }

  console.log('2. Settling on-chain (co-signing and broadcasting)...');
  const settleResult = await handler.settle(payload, requirements);
  console.log('\n======================================================');
  console.log('SOLANA DEVNET LIVE SETTLEMENT SUCCESSFUL!');
  console.log('Transaction Hash:', settleResult.transaction);
  console.log(`Explorer Link: https://explorer.solana.com/tx/${settleResult.transaction}?cluster=devnet`);
  console.log('======================================================\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
