import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');
import dotenv from 'dotenv';
dotenv.config();

import * as nearApi from 'near-api-js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RPC_URL = process.env.NEAR_RPC_URL || 'https://rpc.testnet.near.org';
const RELAYER_ID = process.env.NEAR_RELAYER_ACCOUNT_ID || 'og-relayer-77133.testnet';
const RELAYER_KEY = process.env.NEAR_RELAYER_PRIVATE_KEY!;
const USDC_ID = process.env.NEAR_USDC_TESTNET || '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
const MERCHANT_ID = 'merchant.testnet';

async function main() {
  const provider = new nearApi.JsonRpcProvider({ url: RPC_URL });
  const payerConfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../payer-near.json'), 'utf8'));
  const payerAccountId = payerConfig.accountId;
  const payerKp = nearApi.KeyPair.fromString(payerConfig.privateKey);
  const relayerKp = nearApi.KeyPair.fromString(RELAYER_KEY as any);

  // Helper to query USDC balance
  async function getUsdcBal(accountId: string): Promise<string> {
    try {
      const res: any = await provider.query({
        request_type: 'call_function',
        finality: 'final',
        account_id: USDC_ID,
        method_name: 'ft_balance_of',
        args_base64: Buffer.from(JSON.stringify({ account_id: accountId })).toString('base64'),
      });
      return JSON.parse(Buffer.from(res.result).toString());
    } catch {
      return '0';
    }
  }

  // Helper to query NEAR balance
  async function getNearBal(accountId: string): Promise<string> {
    const state: any = await provider.query({
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    return (Number(BigInt(state.amount) / 1000000000000000000000000n)).toString();
  }

  const payerNearBefore = await getNearBal(payerAccountId);
  let payerUsdcBefore = await getUsdcBal(payerAccountId);
  const merchantUsdcBefore = await getUsdcBal(MERCHANT_ID);
  const relayerNearBefore = await getNearBal(RELAYER_ID);

  console.log('Payer NEAR before:', payerNearBefore);
  console.log('Payer USDC before:', payerUsdcBefore);
  console.log('Merchant USDC before:', merchantUsdcBefore);
  console.log('Relayer NEAR before:', relayerNearBefore);

  // If payer has less than 100,000 micro-USDC ($0.10), transfer 300,000 from relayer
  if (BigInt(payerUsdcBefore) < 100_000n) {
    console.log('Payer needs USDC. Transferring 300,000 micro-USDC from relayer...');
    const accessKeyRes: any = await provider.viewAccessKey({
      accountId: RELAYER_ID,
      publicKey: relayerKp.getPublicKey(),
    });
    const blockRes: any = await provider.viewBlock({ finality: 'final' });
    const blockHash = nearApi.baseDecode(blockRes.header.hash);

    const tx = nearApi.createTransaction(
      RELAYER_ID,
      relayerKp.getPublicKey(),
      USDC_ID,
      BigInt(accessKeyRes.nonce) + 1n,
      [
        nearApi.actions.functionCall(
          'ft_transfer',
          { receiver_id: payerAccountId, amount: '300000' },
          50_000_000_000_000n,
          1n
        ),
      ],
      blockHash
    );

    const serializedTx = nearApi.encodeTransaction(tx);
    const hash = crypto.createHash('sha256').update(serializedTx).digest();
    const sig = relayerKp.sign(hash);
    const signatureObj = new nearApi.Signature({ keyType: nearApi.KeyType.ED25519, data: sig.signature });
    const signedTx = new nearApi.SignedTransaction({ transaction: tx, signature: signatureObj });
    await provider.sendTransaction(signedTx);
    payerUsdcBefore = await getUsdcBal(payerAccountId);
    console.log('Payer USDC reloaded to:', payerUsdcBefore);
  }

  // Construct NEP-366 SignedDelegate
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
          receiver_id: MERCHANT_ID,
          amount: paymentAmount,
        },
        50_000_000_000_000n,
        1n
      ),
    ],
    nonce: BigInt(payerAccessKey.nonce) + 1n,
    maxBlockHeight: currentHeight + 200n,
    publicKey: payerKp.getPublicKey(),
  });

  const serializedDelegate = nearApi.encodeDelegateAction(delegateAction);
  const delegateSigRaw = payerKp.sign(crypto.createHash('sha256').update(serializedDelegate).digest());
  const delegateSignature = new nearApi.Signature({
    keyType: nearApi.KeyType.ED25519,
    data: delegateSigRaw.signature,
  });

  const signedDelegate = {
    delegateAction,
    signature: 'ed25519:' + nearApi.baseEncode(delegateSigRaw.signature),
  };

  // Compute delegate hash
  const delegateHash = crypto.createHash('sha256').update(serializedDelegate).digest('hex');
  console.log('Delegate Hash:', delegateHash);

  const payload = {
    signedDelegate,
  };

  const requirements = {
    scheme: 'exact',
    network: 'near:testnet',
    amount: paymentAmount,
    asset: USDC_ID,
    payTo: MERCHANT_ID,
  };

  function safeJsonStringify(obj: any): string {
    return JSON.stringify(obj, (_, v) => {
      if (typeof v === 'bigint') return v.toString();
      if (v && typeof v.toString === 'function' && v.constructor?.name === 'PublicKey') return v.toString();
      return v;
    });
  }

  console.log('\n--- Calling POST http://localhost:3002/verify ---');
  const verifyHttpRes = await fetch('http://localhost:3002/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: safeJsonStringify({ payload, requirements }),
  });
  const verifyHttpBody = await verifyHttpRes.json();
  console.log('Verify Status:', verifyHttpRes.status);
  console.log('Verify Body:', JSON.stringify(verifyHttpBody));

  if (!verifyHttpBody.isValid) {
    throw new Error('NEAR Verification failed: ' + JSON.stringify(verifyHttpBody));
  }

  console.log('\n--- Calling POST http://localhost:3002/settle ---');
  const settleHttpRes = await fetch('http://localhost:3002/settle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: safeJsonStringify({ payload, requirements }),
  });
  const settleHttpBody = await settleHttpRes.json();
  console.log('Settle Status:', settleHttpRes.status);
  console.log('Settle Body:', JSON.stringify(settleHttpBody));

  if (!settleHttpBody.success) {
    throw new Error('NEAR Settlement failed: ' + JSON.stringify(settleHttpBody));
  }

  const txHash = settleHttpBody.transaction;
  console.log('\nWaiting for on-chain status of tx:', txHash);
  const txOutcome: any = await provider.txStatus(txHash, RELAYER_ID);
  const blockHash = txOutcome?.transaction_outcome?.block_hash;

  const payerNearAfter = await getNearBal(payerAccountId);
  const payerUsdcAfter = await getUsdcBal(payerAccountId);
  const merchantUsdcAfter = await getUsdcBal(MERCHANT_ID);
  const relayerNearAfter = await getNearBal(RELAYER_ID);

  console.log('\nPayer NEAR after:', payerNearAfter);
  console.log('Payer USDC after:', payerUsdcAfter);
  console.log('Merchant USDC after:', merchantUsdcAfter);
  console.log('Relayer NEAR after:', relayerNearAfter);

  console.log('\nSUMMARY FOR SECTION F (NEAR):');
  console.log(JSON.stringify({
    chain: 'NEAR Testnet (near:testnet)',
    priceCharged: '0.10 USDC (100,000 micro-USDC)',
    payerAddress: payerAccountId,
    payerUsdcBefore: `${payerUsdcBefore} micro-USDC ($${Number(payerUsdcBefore)/1e6})`,
    payerUsdcAfter: `${payerUsdcAfter} micro-USDC ($${Number(payerUsdcAfter)/1e6})`,
    payerNearBefore: `${payerNearBefore} NEAR`,
    payerNearAfter: `${payerNearAfter} NEAR`,
    merchantAddress: MERCHANT_ID,
    merchantUsdcBefore: `${merchantUsdcBefore} micro-USDC ($${Number(merchantUsdcBefore)/1e6})`,
    merchantUsdcAfter: `${merchantUsdcAfter} micro-USDC ($${Number(merchantUsdcAfter)/1e6})`,
    relayerAddress: RELAYER_ID,
    relayerNearBefore: `${relayerNearBefore} NEAR`,
    relayerNearAfter: `${relayerNearAfter} NEAR`,
    verifyRequest: { payload: { signedDelegate: '[NEP-366 structure]' }, requirements },
    verifyResponse: { status: verifyHttpRes.status, body: verifyHttpBody },
    settleRequest: { payload: { signedDelegate: '[NEP-366 structure]' }, requirements },
    settleResponse: { status: settleHttpRes.status, body: settleHttpBody },
    txHash,
    blockHash,
    delegateHash,
    explorerUrl: `https://testnet.nearblocks.io/txns/${txHash}`,
  }, null, 2));
}

main().catch(console.error);
