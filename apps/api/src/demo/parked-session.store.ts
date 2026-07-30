import { type Logger, logger } from "@autonoma/logger";
import type Redis from "ioredis";

const KEY_PREFIX = "demo:parked-session:";

/**
 * Upper bound on how long a parked session stays restorable, regardless of how far
 * out the session itself expires. Long enough to survive an afternoon in the demo,
 * short enough that an abandoned browser doesn't keep a live token addressable.
 */
const MAX_TTL_SECONDS = 60 * 60 * 24;

/**
 * Holds the session a visitor arrived with while they browse the read-only demo.
 *
 * Entering the demo overwrites the browser's session cookie (one cookie per parent
 * domain), so a signed-in visitor would otherwise be signed out of their own account
 * by looking at the demo. The token they came with is parked here, keyed by the demo
 * session that replaced it, and handed back when they leave.
 *
 * Keying by the demo session token - which the browser already holds - is what makes
 * this safe: there is no client-supplied handle to plant, so nobody can point another
 * visitor's "back to your account" at a session they control.
 */
export class ParkedSessionStore {
    private readonly logger: Logger;

    constructor(private readonly redis: Redis) {
        this.logger = logger.child({ name: this.constructor.name });
    }

    /** Parks `priorSessionToken` for the lifetime it has left, capped at {@link MAX_TTL_SECONDS}. */
    async park(demoSessionToken: string, priorSessionToken: string, priorExpiresAt: Date): Promise<void> {
        const ttlSeconds = Math.min(Math.floor((priorExpiresAt.getTime() - Date.now()) / 1000), MAX_TTL_SECONDS);
        if (ttlSeconds <= 0) {
            this.logger.info("Not parking an already-expired session");
            return;
        }

        await this.redis.set(this.key(demoSessionToken), priorSessionToken, "EX", ttlSeconds);
        this.logger.info("Parked the visitor's session for the demo", { extra: { ttlSeconds } });
    }

    /** Whether a session is parked for this demo session, without consuming it. */
    async has(demoSessionToken: string | undefined): Promise<boolean> {
        if (demoSessionToken == null) return false;
        const parked = await this.redis.exists(this.key(demoSessionToken));
        return parked === 1;
    }

    /** Returns the parked session token and drops it, so a restore can only happen once. */
    async take(demoSessionToken: string): Promise<string | undefined> {
        const key = this.key(demoSessionToken);
        const priorSessionToken = await this.redis.get(key);
        if (priorSessionToken == null) {
            this.logger.info("No parked session to restore");
            return undefined;
        }

        await this.redis.del(key);
        this.logger.info("Took the parked session for restore");
        return priorSessionToken;
    }

    private key(demoSessionToken: string): string {
        return `${KEY_PREFIX}${demoSessionToken}`;
    }
}
