import dns from 'dns';
try { dns.setDefaultResultOrder('ipv4first'); } catch {}
import { NEARHandler } from '../src/handlers/near';
import * as na from 'near-api-js';
import crypto from 'crypto';

async function test() {
  const handler = new NEARHandler();
  const canonicalUsdcTestnet = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
  const requirements = {
    scheme: 'exact',
    network: 'near:testnet',
    amount: '1000000',
    asset: canonicalUsdcTestnet,
    payTo: 'merchant.testnet',
  };

  const kp = na.KeyPair.fromRandom('ed25519');
  const pubkey = kp.getPublicKey();
  const ftAction = na.actions.functionCall(
    'ft_transfer',
    { receiver_id: 'merchant.testnet', amount: '1000000' },
    30000000000000n,
    1n
  );

  const delegateAction = na.buildDelegateAction({
    senderId: 'alice.testnet',
    receiverId: canonicalUsdcTestnet,
    actions: [ftAction],
    nonce: 1n,
    maxBlockHeight: 999999999n,
    publicKey: pubkey,
  });

  const encoded = na.encodeDelegateAction(delegateAction);
  const msgHash = crypto.createHash('sha256').update(encoded).digest();
  const sigResult = kp.sign(msgHash);

  const payload = {
    signedDelegate: {
      delegateAction,
      signature: sigResult.signature,
    },
  };

  console.log('Calling verify...');
  const res = await handler.verify(payload, requirements);
  console.log('Verify returned:', JSON.stringify(res));
  process.exit(0);
}

test().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});

