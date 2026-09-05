import { Router, type Request, type Response } from 'express';
import { PaymentPayloadSchema } from '../types/x402.types.js';
import { verifyPayment } from '../services/payment.service.js';
import type { X402VerifierDriver } from '../drivers/driver.interface.js';

export function createVerifyRoute(driver: X402VerifierDriver): Router {
  const router = Router();

  router.post('/v1/verify', async (req: Request, res: Response) => {
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

      const parseResult = PaymentPayloadSchema.safeParse(decodedPayload);
      if (!parseResult.success) {
        res.status(400).json({ 
          error: 'Invalid payment payload', 
          issues: parseResult.error.issues 
        });
        return;
      }

      // 3. Verify
      const result = await verifyPayment(driver, parseResult.data);

      if (!result.valid) {
        res.status(402).json({ error: result.reason || 'Verification failed.' });
        return;
      }

      res.status(200).json({ verified: true });
    } catch (error: any) {
      console.error('Verify error:', error);
      res.status(500).json({ error: 'Internal server error during verification.' });
    }
  });

  return router;
}
