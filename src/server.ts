import express from 'express';
import { config } from './config.js';
import { healthRoute } from './routes/health.route.js';
import { createVerifyRoute } from './routes/verify.route.js';
import { createSettleRoute } from './routes/settle.route.js';
import { ArchVerifierDriver } from './drivers/arch/arch.driver.js';
import { RedisNonceService, InMemoryNonceService } from './services/nonce.service.js';

async function bootstrap() {
  const app = express();
  
  // Use JSON parsing middleware (even though we read headers, useful if we expand later)
  app.use(express.json());

  // Instantiate the driver and nonce service
  const archDriver = new ArchVerifierDriver(config.ARCH_RPC_URL);
  
  const nonceService = config.REDIS_URL 
    ? new RedisNonceService(config.REDIS_URL) 
    : new InMemoryNonceService();

  // Register routes
  app.use(healthRoute);
  app.use(createVerifyRoute(archDriver));
  app.use(createSettleRoute(archDriver, nonceService));

  // Start server
  app.listen(config.PORT, () => {
    console.log(`🚀 x402 Facilitator listening on port ${config.PORT}`);
    console.log(`🔗 Arch RPC connected to ${config.ARCH_RPC_URL}`);
  });
}

bootstrap().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
