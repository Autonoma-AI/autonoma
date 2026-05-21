import { createHash, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@autonoma/db";

export interface ApiKeyContext {
    userId: string;
    organizationId: string;
}

/**
 * SHA256 hashes the raw key with URL-safe base64 encoding (no padding). This
 * is the storage form used by `apiKey.key` in the DB - the raw key the user
 * sees in the dashboard is never stored, only this hash.
 */
export function hashApiKey(rawKey: string): string {
    const hash = createHash("sha256").update(rawKey).digest();
    return hash.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Pulls an `Authorization: Bearer <key>` token from the header, looks up the
 * hashed key in the `apiKey` table, and returns `{ userId, organizationId }`
 * if it's enabled and not expired. Returns `undefined` on any failure path
 * - callers should treat that as "no auth", not "invalid auth", so the
 * subsequent fallback logic (e.g. session cookie auth) gets a chance.
 *
 * Updates `lastRequest` on the matched row as a side effect (fire and
 * forget; not awaited so per-request latency isn't paying for the write).
 */
export async function verifyApiKey(
    db: PrismaClient,
    authorizationHeader: string | undefined,
): Promise<ApiKeyContext | undefined> {
    const rawKey = authorizationHeader?.replace(/^Bearer\s+/i, "");
    if (rawKey == null || rawKey.length === 0) return undefined;

    const hashedKey = hashApiKey(rawKey);

    const apiKey = await db.apiKey.findFirst({
        where: { key: hashedKey, enabled: true },
        select: { id: true, userId: true, organizationId: true, expiresAt: true },
    });

    if (apiKey == null) return undefined;
    if (apiKey.expiresAt != null && apiKey.expiresAt < new Date()) return undefined;

    void db.apiKey.update({ where: { id: apiKey.id }, data: { lastRequest: new Date() } });

    return { userId: apiKey.userId, organizationId: apiKey.organizationId };
}

/**
 * Constant-time string equality. Wraps `timingSafeEqual` to handle the
 * pre-condition that the two buffers must be the same length - returns
 * false safely when lengths differ rather than throwing.
 *
 * Exported so the service-secret verifier can reuse it.
 */
export function constantTimeEqual(a: string, b: string): boolean {
    const aBuf = Buffer.from(a, "utf8");
    const bBuf = Buffer.from(b, "utf8");
    if (aBuf.length !== bBuf.length) return false;
    return timingSafeEqual(aBuf, bBuf);
}
