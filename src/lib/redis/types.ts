export interface RedisSetOptions {
  expiresInMs?: number;
}

export interface TokenBucketInput {
  capacity: number;
  cost: number;
  key: string;
  refillAmount: number;
  refillIntervalMs: number;
  ttlMs: number;
}

export interface TokenBucketResult {
  allowed: boolean;
  remainingMicrotokens: number;
  retryAfterMs: number;
}

export interface RedisStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: RedisSetOptions): Promise<void>;
  delete(key: string): Promise<void>;
  increment(key: string, amount?: number): Promise<number>;
  acquireLease(key: string, token: string, ttlMs: number): Promise<boolean>;
  extendLease(key: string, token: string, ttlMs: number): Promise<boolean>;
  releaseLease(key: string, token: string): Promise<boolean>;
  consumeTokenBucket(input: TokenBucketInput): Promise<TokenBucketResult>;
}
