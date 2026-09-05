import Redis from 'ioredis';

export interface NonceService {
  isUsed(nonce: string): Promise<boolean>;
  markUsed(nonce: string, ttlSeconds?: number): Promise<void>;
  unmark(nonce: string): Promise<void>;
}

export class InMemoryNonceService implements NonceService {
  private usedNonces: Map<string, number> = new Map();

  async isUsed(nonce: string): Promise<boolean> {
    const expiresAt = this.usedNonces.get(nonce);
    if (expiresAt !== undefined) {
      if (Date.now() < expiresAt) {
        return true;
      }
      this.usedNonces.delete(nonce);
    }
    return false;
  }

  async markUsed(nonce: string, ttlSeconds = 900): Promise<void> { // Default 15 minutes
    this.usedNonces.set(nonce, Date.now() + (ttlSeconds * 1000));
  }

  async unmark(nonce: string): Promise<void> {
    this.usedNonces.delete(nonce);
  }
}

export class RedisNonceService implements NonceService {
  private redis: InstanceType<typeof Redis>;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl);
  }

  async isUsed(nonce: string): Promise<boolean> {
    const exists = await this.redis.exists(`nonce:${nonce}`);
    return exists === 1;
  }

  async markUsed(nonce: string, ttlSeconds = 900): Promise<void> { // Default 15 minutes
    const result = await this.redis.set(`nonce:${nonce}`, '1', 'EX', ttlSeconds, 'NX');
    if (result !== 'OK') {
        throw new Error('Nonce already used or Redis error');
    }
  }

  async unmark(nonce: string): Promise<void> {
    await this.redis.del(`nonce:${nonce}`);
  }
}
