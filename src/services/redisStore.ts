import Redis from "ioredis";

export interface KeyValueStore<T> {
  get(key: string): Promise<T | null>;
  set(key: string, value: T, ttlSeconds?: number): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

class RedisStore<T> implements KeyValueStore<T> {
  private redis: Redis | null = null;
  private inMemoryStore: Map<string, { value: T; expiresAt?: number }> = new Map();
  private useRedis: boolean;

  constructor(redisUrl?: string) {
    this.useRedis = !!redisUrl;

    if (this.useRedis && redisUrl) {
      try {
        this.redis = new Redis(redisUrl, {
          retryStrategy: times => {
            const delay = Math.min(times * 50, 2000);
            return delay;
          },
          maxRetriesPerRequest: 3,
          enableReadyCheck: true,
          lazyConnect: true,
        });

        this.redis.on("error", err => {
          console.error("❌ Redis connection error:", err.message);
        });

        this.redis.on("connect", () => {
          console.log("✅ Connected to Redis/ElastiCache");
        });

        // Connect asynchronously
        this.redis.connect().catch(err => {
          console.error(
            "❌ Failed to connect to Redis, falling back to in-memory store:",
            err.message,
          );
          this.useRedis = false;
          this.redis = null;
        });
      } catch (error) {
        console.error("❌ Failed to initialize Redis, falling back to in-memory store:", error);
        this.useRedis = false;
        this.redis = null;
      }
    } else {
      console.log("📦 Using in-memory store (Redis URL not provided)");
    }
  }

  async get(key: string): Promise<T | null> {
    if (this.useRedis && this.redis) {
      try {
        const value = await this.redis.get(key);
        if (value === null) return null;
        return JSON.parse(value) as T;
      } catch (error) {
        console.error(`❌ Redis get error for key ${key}:`, error);
        // Fallback to in-memory on error
        return this.getFromMemory(key);
      }
    }
    return this.getFromMemory(key);
  }

  private getFromMemory(key: string): T | null {
    const entry = this.inMemoryStore.get(key);
    if (!entry) return null;

    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this.inMemoryStore.delete(key);
      return null;
    }

    return entry.value;
  }

  async set(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const serialized = JSON.stringify(value);

    if (this.useRedis && this.redis) {
      try {
        if (ttlSeconds) {
          await this.redis.setex(key, ttlSeconds, serialized);
        } else {
          await this.redis.set(key, serialized);
        }
        return;
      } catch (error) {
        console.error(`❌ Redis set error for key ${key}:`, error);
        // Fallback to in-memory on error
      }
    }

    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined;
    this.inMemoryStore.set(key, { value, expiresAt });

    // Clean up expired entries periodically (every 1000 operations)
    if (this.inMemoryStore.size % 1000 === 0) {
      this.cleanupExpired();
    }
  }

  async has(key: string): Promise<boolean> {
    if (this.useRedis && this.redis) {
      try {
        const exists = await this.redis.exists(key);
        return exists === 1;
      } catch (error) {
        console.error(`❌ Redis has error for key ${key}:`, error);
        return this.hasInMemory(key);
      }
    }
    return this.hasInMemory(key);
  }

  private hasInMemory(key: string): boolean {
    const entry = this.inMemoryStore.get(key);
    if (!entry) return false;

    // Check if expired
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this.inMemoryStore.delete(key);
      return false;
    }

    return true;
  }

  async delete(key: string): Promise<void> {
    if (this.useRedis && this.redis) {
      try {
        await this.redis.del(key);
        return;
      } catch (error) {
        console.error(`❌ Redis delete error for key ${key}:`, error);
        // Fallback to in-memory on error
      }
    }

    this.inMemoryStore.delete(key);
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.inMemoryStore.entries()) {
      if (entry.expiresAt && entry.expiresAt < now) {
        this.inMemoryStore.delete(key);
      }
    }
  }

  /**
   * Gracefully close Redis connection
   */
  async disconnect(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }
  }
}

export function createRedisStore<T>(redisUrl?: string): KeyValueStore<T> {
  return new RedisStore<T>(redisUrl);
}
