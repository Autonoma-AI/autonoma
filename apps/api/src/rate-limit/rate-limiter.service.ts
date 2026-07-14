import { type PrismaClient } from "@autonoma/db";
import { TooManyRequestsError } from "@autonoma/errors";
import { type Logger, logger as rootLogger } from "@autonoma/logger";

export interface RateLimitPolicy {
    /** Max attempts permitted within the window before requests are rejected. */
    max: number;
    /** Window length in milliseconds. */
    windowMs: number;
}

/**
 * A durable fixed-window rate limiter backed by Postgres (`RateLimitCounter`), so
 * a limit holds across the API's replicas and pod restarts - an in-memory
 * per-pod limiter would be trivially bypassed by spreading requests across pods.
 * Fixed-window (not sliding), so it tolerates a small burst at a window boundary;
 * that is an acceptable trade for abuse / DoS protection.
 */
export class RateLimiterService {
    private readonly logger: Logger;

    constructor(private readonly db: PrismaClient) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /**
     * Records one attempt against `key` and throws {@link TooManyRequestsError}
     * when the count for the current window exceeds `policy.max`. `message` is the
     * caller-safe text surfaced on rejection.
     */
    async consume(key: string, policy: RateLimitPolicy, message = "Too many requests"): Promise<void> {
        const now = new Date();
        const windowFloor = new Date(now.getTime() - policy.windowMs);

        const count = await this.db.$transaction(async (tx) => {
            const existing = await tx.rateLimitCounter.findUnique({
                where: { key },
                select: { windowStartedAt: true },
            });
            const windowExpired = existing == null || existing.windowStartedAt < windowFloor;
            if (windowExpired) {
                await tx.rateLimitCounter.upsert({
                    where: { key },
                    create: { key, windowStartedAt: now, count: 1 },
                    update: { windowStartedAt: now, count: 1 },
                });
                return 1;
            }
            const updated = await tx.rateLimitCounter.update({
                where: { key },
                data: { count: { increment: 1 } },
                select: { count: true },
            });
            return updated.count;
        });

        if (count > policy.max) {
            this.logger.warn("Rate limit exceeded", { extra: { key, count, max: policy.max } });
            throw new TooManyRequestsError(message);
        }
    }
}
