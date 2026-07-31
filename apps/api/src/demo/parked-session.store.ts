import { type Logger, logger } from "@autonoma/logger";
import type Redis from "ioredis";
import { z } from "zod";

const KEY_PREFIX = "demo:parked-session:";

/**
 * Upper bound on how long a parked session stays restorable, regardless of how far
 * out the session itself expires. Long enough to survive an afternoon in the demo,
 * short enough that an abandoned browser doesn't keep a live token addressable.
 */
const MAX_TTL_SECONDS = 60 * 60 * 24;

const ParkedSessionSchema = z.object({
    /** The better-auth session token to put back in the cookie on exit. */
    token: z.string().min(1),
    /** Who the token belongs to, so an exit can be attributed even when the token is dead. */
    userId: z.string().min(1),
    /** App-relative path the visitor left, so exit returns them to it rather than the app root. */
    returnTo: z.string().optional(),
});

export type ParkedSession = z.infer<typeof ParkedSessionSchema>;

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

    /** Parks `priorSession` for the lifetime it has left, capped at {@link MAX_TTL_SECONDS}. */
    async park(demoSessionToken: string, priorSession: ParkedSession, priorExpiresAt: Date): Promise<void> {
        const ttlSeconds = Math.min(Math.floor((priorExpiresAt.getTime() - Date.now()) / 1000), MAX_TTL_SECONDS);
        if (ttlSeconds <= 0) {
            this.logger.info("Not parking an already-expired session");
            return;
        }

        await this.redis.set(this.key(demoSessionToken), JSON.stringify(priorSession), "EX", ttlSeconds);
        this.logger.info("Parked the visitor's session for the demo", {
            extra: { ttlSeconds, hasReturnPath: priorSession.returnTo != null },
        });
    }

    /** Whether a session is parked for this demo session, without consuming it. */
    async has(demoSessionToken: string | undefined): Promise<boolean> {
        if (demoSessionToken == null) return false;
        const parked = await this.redis.exists(this.key(demoSessionToken));
        return parked === 1;
    }

    /** Returns the parked session and drops it, so a restore can only happen once. */
    async take(demoSessionToken: string): Promise<ParkedSession | undefined> {
        const key = this.key(demoSessionToken);
        const stored = await this.redis.get(key);
        if (stored == null) {
            this.logger.info("No parked session to restore");
            return undefined;
        }

        await this.redis.del(key);
        const parked = this.parse(stored);
        if (parked == null) return undefined;

        this.logger.info("Took the parked session for restore");
        return parked;
    }

    private parse(stored: string): ParkedSession | undefined {
        try {
            return ParkedSessionSchema.parse(JSON.parse(stored));
        } catch (err) {
            this.logger.warn("Dropped an unreadable parked session", { extra: { err } });
            return undefined;
        }
    }

    private key(demoSessionToken: string): string {
        return `${KEY_PREFIX}${demoSessionToken}`;
    }
}
