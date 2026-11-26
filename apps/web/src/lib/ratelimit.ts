import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

if (typeof window !== 'undefined') {
  throw new Error('ratelimit.ts is server-only.');
}

interface LimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
}

const memoryBuckets = new Map<string, { count: number; resetAt: number }>();

function checkMemoryLimit(key: string, limit: number, windowMs: number): LimitResult {
  const now = Date.now();
  if (memoryBuckets.size > 10_000) {
    for (const [k, v] of memoryBuckets) {
      if (now > v.resetAt) memoryBuckets.delete(k);
    }
  }
  const existing = memoryBuckets.get(key);
  if (!existing || now > existing.resetAt) {
    const resetAt = now + windowMs;
    memoryBuckets.set(key, { count: 1, resetAt });
    return { success: true, limit, remaining: limit - 1, reset: resetAt };
  }
  existing.count += 1;
  return {
    success: existing.count <= limit,
    limit,
    remaining: Math.max(0, limit - existing.count),
    reset: existing.resetAt,
  };
}

let cachedRedis: Redis | null | undefined;
const upstashLimiters = new Map<string, Ratelimit>();

function getRedisClient(): Redis | null {
  if (cachedRedis !== undefined) return cachedRedis;
  const url = (process.env.UPSTASH_REDIS_REST_URL ?? '').trim();
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN ?? '').trim();
  if (url && token) {
    cachedRedis = new Redis({ url, token });
  } else {
    cachedRedis = null;
  }
  return cachedRedis;
}

export async function rateLimitCheck(
  bucketName: string,
  identifier: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<LimitResult> {
  const redis = getRedisClient();
  const key = `${bucketName}:${identifier}`;

  if (!redis) {
    return checkMemoryLimit(key, maxRequests, windowSeconds * 1000);
  }

  const limiterKey = `${bucketName}:${maxRequests}:${windowSeconds}`;
  let limiter = upstashLimiters.get(limiterKey);
  if (!limiter) {
    limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(maxRequests, `${windowSeconds} s`),
      prefix: `clipper:rl:${bucketName}`,
      analytics: false,
    });
    upstashLimiters.set(limiterKey, limiter);
  }

  const res = await limiter.limit(identifier);
  return {
    success: res.success,
    limit: res.limit,
    remaining: res.remaining,
    reset: res.reset,
  };
}

export function extractClientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const realIp = req.headers.get('x-real-ip')?.trim();
  return realIp || '127.0.0.1';
}
