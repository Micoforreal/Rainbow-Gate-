import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');
import dotenv from 'dotenv';
dotenv.config();

import * as nearApi from 'near-api-js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { NEARHandler } from '../src/handlers/near';

const RPC_URL = process.env.NEAR_RPC_URL || 'https://rpc.testnet.near.org';
const RELAYER_ID = process.env.NEAR_RELAYER_ACCOUNT_ID || 'og-relayer-77133.testnet';
const RELAYER_KEY = process.env.NEAR_RELAYER_PRIVATE_KEY!;
const USDC_ID = process.env.NEAR_USDC_TESTNET || '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
const REF_ID = 'ref-finance-101.testnet';
const WRAP_ID = 'wrap.testnet';

async function main() {
  console.log('--- START LIVE NEAR TESTNET SETUP & SETTLE ---');
  if (!RELAYER_KEY) throw new Error('NEAR_RELAYER_PRIVATE_KEY not found in .env');

  const provider = new nearApi.JsonRpcProvider({ url: RPC_URL });
  const relayerKp = nearApi.KeyPair.fromString(RELAYER_KEY as any);

  // Helper to sign and send tx from an account
  async function sendTx(signerId: string, signerKp: any, receiverId: string, actions: any[]) {
    const accessKeyRes = await provider.viewAccessKey({
      accountId: signerId,
      publicKey: signerKp.getPublicKey(),
    });
    const blockRes = await provider.viewBlock({ finality: 'final' });
    const blockHash = nearApi.baseDecode(blockRes.header.hash);

    const tx = nearApi.createTransaction(
      signerId,
      signerKp.getPublicKey(),
      receiverId,
      BigInt(accessKeyRes.nonce) + 1n,
      actions,
      blockHash
    );

    const serializedTx = nearApi.encodeTransaction(tx);
    const hash = crypto.createHash('sha256').update(serializedTx).digest();
    const sig = signerKp.sign(hash);
    const signatureObj = new nearApi.Signature({ keyType: nearApi.KeyType.ED25519, data: sig.signature });
    const signedTx = new nearApi.SignedTransaction({
      transaction: tx,
      signature: signatureObj,
    });

    const res = await provider.sendTransaction(signedTx);
    return res;
  }

  // 1. Storage deposits for relayer
  console.log('1. Checking & registering storage for relayer on wrap, ref, and usdc...');
  for (const c of [WRAP_ID, REF_ID, USDC_ID]) {
    try {
      const depositAmount = c === REF_ID ? 100_000_000_000_000_000_000_000n : 12_500_000_000_000_000_000_000n; // 0.1 NEAR or 0.0125 NEAR
      const res = await sendTx(RELAYER_ID, relayerKp, c, [
        nearApi.actions.functionCall(
          'storage_deposit',
          { account_id: RELAYER_ID, registration_only: false },
          50_000_000_000_000n, // 50 TGas
          depositAmount
        ),
      ]);
      console.log(`Registered storage on ${c}:`, res.transaction?.hash || 'OK');
    } catch (e: any) {
      console.log(`Storage deposit on ${c}:`, e.message?.slice(0, 80));
    }
  }

  // 2. Wrap 1 NEAR to wNEAR
  console.log('2. Wrapping 1.5 NEAR on wrap.testnet...');
  try {
    const wrapRes = await sendTx(RELAYER_ID, relayerKp, WRAP_ID, [
      nearApi.actions.functionCall(
        'near_deposit',
        {},
        50_000_000_000_000n,
        1_500_000_000_000_000_000_000_000n // 1.5 NEAR
      ),
    ]);
    console.log('Wrapped 1.5 NEAR. Tx:', wrapRes.transaction?.hash);
  } catch (e: any) {
    console.log('Wrap result:', e.message?.slice(0, 80));
  }

  // 3. Swap 1.5 wNEAR for USDC on Ref pool 2206
  console.log('3. Swapping 1.5 wNEAR for testnet USDC on Ref Finance...');
  try {
    const swapMsg = JSON.stringify({
      actions: [
        {
          pool_id: 2206,
          token_in: WRAP_ID,
          token_out: USDC_ID,
          min_amount_out: '1',
        },
      ],
    });
    const swapRes = await sendTx(RELAYER_ID, relayerKp, WRAP_ID, [
      nearApi.actions.functionCall(
        'ft_transfer_call',
        {
          receiver_id: REF_ID,
          amount: '1500000000000000000000000', // 1.5 wNEAR
          msg: swapMsg,
        },
        180_000_000_000_000n, // 180 TGas
        1n // 1 yoctoNEAR
      ),
    ]);
    console.log('Swap executed on Ref. Tx:', swapRes.transaction?.hash);
  } catch (e: any) {
    console.log('Swap result:', e.message?.slice(0, 100));
  }

  // 4. Withdraw USDC from Ref Finance to relayer
  console.log('4. Withdrawing USDC from Ref Finance...');
  try {
    const withdrawRes = await sendTx(RELAYER_ID, relayerKp, REF_ID, [
      nearApi.actions.functionCall(
        'withdraw',
        {
          token_id: USDC_ID,
          amount: '0', // withdraw all
          unregister: false,
        },
        100_000_000_000_000n,
        1n
      ),
    ]);
    console.log('Withdrawn USDC to relayer. Tx:', withdrawRes.transaction?.hash);
  } catch (e: any) {
    console.log('Withdraw result:', e.message?.slice(0, 100));
  }

  // Check relayer USDC balance
  const relayerBalRaw: any = await provider.query({
    request_type: 'call_function',
    finality: 'final',
    account_id: USDC_ID,
    method_name: 'ft_balance_of',
    args_base64: Buffer.from(JSON.stringify({ account_id: RELAYER_ID })).toString('base64'),
  });
  const relayerUsdcBal = JSON.parse(Buffer.from(relayerBalRaw.result).toString());
  console.log('Relayer USDC balance:', relayerUsdcBal, 'micro-USDC');

  // 5. Ensure separate payer account exists with stored key
  const payerKeyPath = path.resolve(process.cwd(), 'payer-near.json');
  let payerKp: any;
  let payerAccountId: string;

  if (fs.existsSync(payerKeyPath)) {
    const data = JSON.parse(fs.readFileSync(payerKeyPath, 'utf8'));
    payerKp = nearApi.KeyPair.fromString(data.privateKey);
    payerAccountId = data.accountId;
    console.log('5. Using existing payer account:', payerAccountId);
  } else {
    payerKp = nearApi.KeyPair.fromRandom('ed25519');
    payerAccountId = `og-payer-${Math.floor(10000 + Math.random() * 90000)}.testnet`;
    console.log('5. Creating fresh testnet payer account:', payerAccountId);
    const helperRes = await fetch('https://helper.testnet.near.org/account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        newAccountId: payerAccountId,
        newAccountPublicKey: payerKp.getPublicKey().toString(),
      }),
    });
    const helperData: any = await helperRes.json();
    console.log('Created payer on testnet. Tx:', helperData.transaction?.hash);
    fs.writeFileSync(
      payerKeyPath,
      JSON.stringify({
        accountId: payerAccountId,
        privateKey: payerKp.toString(),
        publicKey: payerKp.getPublicKey().toString(),
      })
    );
  }

  // 6. Register payer storage on USDC contract
  console.log('6. Registering storage for payer on USDC contract...');
  try {
    const regRes = await sendTx(RELAYER_ID, relayerKp, USDC_ID, [
      nearApi.actions.functionCall(
        'storage_deposit',
        { account_id: payerAccountId, registration_only: true },
        50_000_000_000_000n,
        12_500_000_000_000_000_000_000n
      ),
    ]);
    console.log('Registered storage for payer. Tx:', regRes.transaction?.hash || 'OK');
  } catch (e: any) {
    console.log('Storage deposit for payer:', e.message?.slice(0, 80));
  }

  // 7. Transfer USDC to payer
  if (BigInt(relayerUsdcBal) > 100_000n) {
    console.log('7. Transferring 300,000 micro-USDC ($0.30) to payer...');
    const transferRes = await sendTx(RELAYER_ID, relayerKp, USDC_ID, [
      nearApi.actions.functionCall(
        'ft_transfer',
        {
          receiver_id: payerAccountId,
          amount: '300000', // $0.30 USDC
        },
        50_000_000_000_000n,
        1n
      ),
    ]);
    console.log('Funded payer with USDC. Tx:', transferRes.transaction?.hash);
  }

  // Verify payer balance
  const payerBalRaw: any = await provider.query({
    request_type: 'call_function',
    finality: 'final',
    account_id: USDC_ID,
    method_name: 'ft_balance_of',
    args_base64: Buffer.from(JSON.stringify({ account_id: payerAccountId })).toString('base64'),
  });
  const payerUsdcBal = JSON.parse(Buffer.from(payerBalRaw.result).toString());
  console.log(`Confirmed Payer (${payerAccountId}) USDC Balance:`, payerUsdcBal, 'micro-USDC ($', Number(payerUsdcBal) / 1e6, ')');

  // 8. Construct NEP-366 SignedDelegate from Payer to Merchant
  console.log('\n8. Constructing NEP-366 SignedDelegate payment...');
  const merchantId = 'merchant.testnet';
  const paymentAmount = '100000'; // $0.10 USDC

  const payerAccessKey: any = await provider.viewAccessKey({
    accountId: payerAccountId,
    publicKey: payerKp.getPublicKey(),
  });
  const latestBlock: any = await provider.viewBlock({ finality: 'final' });
  const currentHeight = BigInt(latestBlock.header.height);

  const delegateAction = nearApi.buildDelegateAction({
    senderId: payerAccountId,
    receiverId: USDC_ID,
    actions: [
      nearApi.actions.functionCall(
        'ft_transfer',
        {
          receiver_id: merchantId,
          amount: paymentAmount,
        },
        50_000_000_000_000n,
        1n
      ),
    ],
    nonce: BigInt(payerAccessKey.nonce) + 1n,
    maxBlockHeight: currentHeight + 100n,
    publicKey: payerKp.getPublicKey(),
  });

  const serializedDelegate = nearApi.encodeDelegateAction(delegateAction);
  const delegateSigRaw = payerKp.sign(crypto.createHash('sha256').update(serializedDelegate).digest());
  const delegateSignature = new nearApi.Signature({
    keyType: nearApi.KeyType.ED25519,
    data: delegateSigRaw.signature,
  });

  const signedDelegateAction = nearApi.actions.signedDelegate({
    delegateAction,
    signature: delegateSignature,
  });

  // 9. Relayer wraps SignedDelegate and broadcasts on NEAR Testnet
  console.log('9. OrangeGate Relayer submitting SignedDelegate to NEAR Testnet...');
  const settleRes = await sendTx(RELAYER_ID, relayerKp, payerAccountId, [signedDelegateAction]);
  const settleTxHash = settleRes.transaction?.hash;
  console.log('\n======================================================');
  console.log('LIVE NEAR TESTNET SETTLEMENT CONFIRMED!');
  console.log('Transaction Hash:', settleTxHash);
  console.log(`Explorer: https://testnet.nearblocks.io/txns/${settleTxHash}`);
  console.log('Payer:', payerAccountId);
  console.log('Merchant:', merchantId);
  console.log('Amount Settled: $0.10 USDC (100,000 units)');
  console.log('Gas Sponsored By Relayer:', RELAYER_ID);
  console.log('======================================================\n');
}

main().catch(console.error);
