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

const RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

async function getAta(owner: PublicKey, mint = USDC_MINT): Promise<PublicKey> {
  const [ata] = await PublicKey.findProgramAddress(
    [owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
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
  data[0] = 12; // TransferChecked discriminator
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

  // Fee Payer from .env
  const feePayerSecret = bs58.decode(process.env.SOLANA_FEE_PAYER_PRIVATE_KEY!);
  const feePayer = await Keypair.fromSecretKey(feePayerSecret);
  const feePayerPub = feePayer.publicKey;
  const feePayerAta = await getAta(feePayerPub);

  // Merchant ATA from prompt: 6TXZqPXwsi3ijBZvf8Ncx75CnZebYyX7xrRPm73z7iSr
  const merchantAta = new PublicKey('6TXZqPXwsi3ijBZvf8Ncx75CnZebYyX7xrRPm73z7iSr');
  const merchantAccountInfo = await conn.getParsedAccountInfo(merchantAta);
  const merchantOwner = (merchantAccountInfo.value?.data as any)?.parsed?.info?.owner;
  console.log('Merchant ATA confirmed owner:', merchantOwner);

  // We can generate a fresh payer or use the existing payer
  // Let's create a fresh payer and fund it with 1 USDC from feePayerAta so payer has 0 SOL
  const payer = await Keypair.generate();
  const payerPub = payer.publicKey;
  const payerAta = await getAta(payerPub);

  console.log('Payer Pubkey:', payerPub.toBase58());
  console.log('Payer ATA:', payerAta.toBase58());

  // Funding payer ATA with 1.00 USDC (1_000_000 micro-units) from feePayer
  const fundLatestBh = await conn.getLatestBlockhash('confirmed');
  const fundIxs = [
    {
      programId: ASSOCIATED_TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: feePayerPub, isSigner: true, isWritable: true },
        { pubkey: payerAta, isSigner: false, isWritable: true },
        { pubkey: payerPub, isSigner: false, isWritable: false },
        { pubkey: USDC_MINT, isSigner: false, isWritable: false },
        { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: new Uint8Array(0),
    },
    createTransferCheckedInstruction(feePayerAta, USDC_MINT, payerAta, feePayerPub, 1_000_000n, 6),
  ];
  const fundMsg = new TransactionMessage({
    payerKey: feePayerPub,
    recentBlockhash: fundLatestBh.blockhash,
    instructions: fundIxs,
  }).compileToV0Message();
  const fundTx = new VersionedTransaction(fundMsg);
  await fundTx.sign([feePayer]);
  const fundSig = await conn.sendRawTransaction(fundTx.serialize(), { preflightCommitment: 'confirmed' });
  await conn.confirmTransaction({ signature: fundSig, ...fundLatestBh }, 'confirmed');
  console.log('Funded payer ATA with 1.00 USDC. Sig:', fundSig);

  // Balances BEFORE
  const payerSolBefore = await conn.getBalance(payerPub);
  const payerUsdcBefore = (await conn.getTokenAccountBalance(payerAta)).value.uiAmountString;
  const merchantUsdcBefore = (await conn.getTokenAccountBalance(merchantAta)).value.uiAmountString;
  const feePayerSolBefore = await conn.getBalance(feePayerPub);

  console.log(`Payer SOL before: ${payerSolBefore} (lamports)`);
  console.log(`Payer USDC before: ${payerUsdcBefore}`);
  console.log(`Merchant USDC before: ${merchantUsdcBefore}`);
  console.log(`Fee Payer SOL before: ${feePayerSolBefore} (lamports)`);

  // Build partial transaction for orangeGate: payer signs, feePayer does not
  // Requirements: 3-6 instructions, TransferChecked
  const freshBh = await conn.getLatestBlockhash('confirmed');
  const paymentAmount = 1_000_000n; // 1.00 USDC
  const payIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    createTransferCheckedInstruction(payerAta, USDC_MINT, merchantAta, payerPub, paymentAmount, 6),
  ];

  const payMsg = new TransactionMessage({
    payerKey: feePayerPub,
    recentBlockhash: freshBh.blockhash,
    instructions: payIxs,
  }).compileToV0Message();

  const partialTx = new VersionedTransaction(payMsg);
  await partialTx.sign([payer]);

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

  console.log('\n--- Calling POST http://localhost:3002/verify ---');
  const verifyHttpRes = await fetch('http://localhost:3002/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload, requirements }),
  });
  const verifyHttpBody = await verifyHttpRes.json();
  console.log('Verify Status:', verifyHttpRes.status);
  console.log('Verify Body:', JSON.stringify(verifyHttpBody));

  if (!verifyHttpBody.isValid) {
    throw new Error('Verification failed: ' + JSON.stringify(verifyHttpBody));
  }

  console.log('\n--- Calling POST http://localhost:3002/settle ---');
  const settleHttpRes = await fetch('http://localhost:3002/settle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload, requirements }),
  });
  const settleHttpBody = await settleHttpRes.json();
  console.log('Settle Status:', settleHttpRes.status);
  console.log('Settle Body:', JSON.stringify(settleHttpBody));

  if (!settleHttpBody.success) {
    throw new Error('Settlement failed: ' + JSON.stringify(settleHttpBody));
  }

  const txHash = settleHttpBody.transaction;
  console.log('\nWaiting for on-chain confirmation of tx:', txHash);
  const txStatus = await conn.getTransaction(txHash, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  const slot = txStatus?.slot;
  console.log('Confirmed in slot:', slot);

  // Balances AFTER
  const payerSolAfter = await conn.getBalance(payerPub);
  const payerUsdcAfter = (await conn.getTokenAccountBalance(payerAta)).value.uiAmountString;
  const merchantUsdcAfter = (await conn.getTokenAccountBalance(merchantAta)).value.uiAmountString;
  const feePayerSolAfter = await conn.getBalance(feePayerPub);

  console.log(`\nPayer SOL after: ${payerSolAfter} (lamports)`);
  console.log(`Payer USDC after: ${payerUsdcAfter}`);
  console.log(`Merchant USDC after: ${merchantUsdcAfter}`);
  console.log(`Fee Payer SOL after: ${feePayerSolAfter} (lamports)`);
  console.log(`Gas spent by Fee Payer: ${feePayerSolBefore - feePayerSolAfter} lamports`);

  console.log('\nSUMMARY FOR SECTION F:');
  console.log(JSON.stringify({
    chain: 'Solana Devnet (solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1)',
    priceCharged: '1.00 USDC (1,000,000 micro-units)',
    payerAddress: payerPub.toBase58(),
    payerUsdcBefore,
    payerUsdcAfter,
    payerSolBefore: `${payerSolBefore / 1e9} SOL`,
    payerSolAfter: `${payerSolAfter / 1e9} SOL`,
    merchantAta: merchantAta.toBase58(),
    merchantOwner,
    merchantUsdcBefore,
    merchantUsdcAfter,
    feePayerAddress: feePayerPub.toBase58(),
    gasSpentLamports: feePayerSolBefore - feePayerSolAfter,
    verifyRequest: { payload: { transaction: '[base64 partial tx]' }, requirements },
    verifyResponse: { status: verifyHttpRes.status, body: verifyHttpBody },
    settleRequest: { payload: { transaction: '[base64 partial tx]' }, requirements },
    settleResponse: { status: settleHttpRes.status, body: settleHttpBody },
    txHash,
    slot,
    explorerUrl: `https://explorer.solana.com/tx/${txHash}?cluster=devnet`,
  }, null, 2));
}

main().catch(console.error);

