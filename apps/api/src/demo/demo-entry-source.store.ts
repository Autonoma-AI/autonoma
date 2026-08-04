import { type Logger, logger } from "@autonoma/logger";
import type Redis from "ioredis";

const KEY_PREFIX = "demo:entry-source:";

/**
 * Upper bound on how long the entry source stays readable, regardless of how far out the
 * demo session itself expires. Matches {@link ParkedSessionStore}'s cap so both pieces of
 * per-visit state disappear on the same schedule.
 */
const MAX_TTL_SECONDS = 60 * 60 * 24;

/**
 * Holds the `?source=` a visitor entered the demo with, keyed by their demo session token,
 * for the rest of that session's life.
 *
 * `?source=` is read once today purely for the `demo.entered` analytics event; this store
 * lets UI state (which CTA the demo banner shows) read the same value back on every later
 * request, the same way {@link ParkedSessionStore} lets `canReturnToAccount` do. Unlike
 * parking, this is written for every visitor, not just ones with a prior session - a
 * first-time visitor from an external listing has nothing to park but still has a source.
 */
export class DemoEntrySourceStore {
    private readonly logger: Logger;

    constructor(private readonly redis: Redis) {
        this.logger = logger.child({ name: this.constructor.name });
    }

    /** Records `source` for the demo session for the lifetime it has left, capped at {@link MAX_TTL_SECONDS}. */
    async set(demoSessionToken: string, source: string, expiresAt: Date): Promise<void> {
        const ttlSeconds = Math.min(Math.floor((expiresAt.getTime() - Date.now()) / 1000), MAX_TTL_SECONDS);
        if (ttlSeconds <= 0) {
            this.logger.info("Not recording entry source for an already-expired session");
            return;
        }

        await this.redis.set(this.key(demoSessionToken), source, "EX", ttlSeconds);
        this.logger.info("Recorded demo entry source", { extra: { source } });
    }

    /** The `?source=` the visitor entered with, or undefined once it has expired or was never set. */
    async get(demoSessionToken: string | undefined): Promise<string | undefined> {
        if (demoSessionToken == null) return undefined;
        const stored = await this.redis.get(this.key(demoSessionToken));
        return stored ?? undefined;
    }

    private key(demoSessionToken: string): string {
        return `${KEY_PREFIX}${demoSessionToken}`;
    }
}
