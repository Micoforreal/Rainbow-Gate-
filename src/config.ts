import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const ConfigSchema = z.object({
  PORT: z.string().default('3000'),
  ARCH_RPC_URL: z.string().url(),
});

const parsed = ConfigSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;
