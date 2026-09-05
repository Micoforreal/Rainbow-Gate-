import { Router, type Request, type Response } from 'express';
import { SettlePayloadSchema } from '../types/x402.types.js';
import { verifyPayment } from '../services/payment.service.js';
import type { X402VerifierDriver } from '../drivers/driver.interface.js';
import type { NonceService } from '../services/nonce.service.js';
import { error } from 'console';

export function createSettleRoute(driver: X402VerifierDriver, nonceService: NonceService): Router {
  const router = Router();

  router.post('/v1/settle', async (req: Request, res: Response) => {
    try {
      // 1. Read header: prefer PAYMENT-SIGNATURE, fall back to X-PAYMENT
      const headerValue = req.headers['payment-signature'] || req.headers['x-payment'];
      
      if (!headerValue || typeof headerValue !== 'string') {
        res.status(400).json({ error: 'Missing payment header' });
        return;
      }

      // 2. Base64-decode -> JSON.parse -> safeParse
      let decodedPayload: unknown;
      try {
        const decodedString = Buffer.from(headerValue, 'base64').toString('utf8');
        decodedPayload = JSON.parse(decodedString);
      } catch (error) {
        res.status(400).json({ error: 'Failed to decode or parse payment header as JSON.' });
        return;
      }

      const parseResult = SettlePayloadSchema.safeParse(decodedPayload);
      if (!parseResult.success) {
        res.status(400).json({ 
          error: 'Invalid payment payload', 
          issues: parseResult.error.issues 
        });
        return;
      }

      const payload = parseResult.data;

      // 3. Atomic nonce check-and-mark
      const isUsed = await nonceService.isUsed(payload.nonce);
      if (isUsed) {
        res.status(409).json({ error: 'Payment already settled.' });
        return;
      }
      
      try {
        await nonceService.markUsed(payload.nonce);
      } catch(e) {
          res.status(409).json({ error: 'Payment already settled.' });
          return;
      }

      // 4. Re-verify
      const verifyResult = await verifyPayment(driver, payload);

      if (!verifyResult.valid) {
        await nonceService.unmark(payload.nonce);
        res.status(402).json({ error: verifyResult.reason || 'Verification failed.' });
        return;
      }

      // 5. Settle
      try {
        const settleResult = await driver.settle(payload);
        if(settleResult.status === 'failed') {
            await nonceService.unmark(payload.nonce);
            console.log(settleResult)
            res.status(500).json({ error: settleResult });
            return;
        }
        res.status(200).json(settleResult);
      } catch (error: any) {
        await nonceService.unmark(payload.nonce);
        console.error('Settle error:', error);
        res.status(500).json({ error: 'Internal server error during settlement.' });
      }

    } catch (error: any) {
      console.error('Settle route error:', error);
      res.status(500).json({ error: 'Internal server error.' });
    }
  });

  return router;
}
