import { createHash } from "node:crypto";
import type { PrismaClient } from "@autonoma/db";

export interface ApiKeyContext {
    userId: string;
    organizationId: string;
}

export function hashApiKey(rawKey: string): string {
    const hash = createHash("sha256").update(rawKey).digest();
    return hash.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export async function verifyApiKeyAndGetContext(
    db: PrismaClient,
    authorizationHeader: string | undefined,
): Promise<ApiKeyContext | undefined> {
    const rawKey = authorizationHeader?.replace(/^Bearer\s+/i, "");
    if (rawKey == null) return undefined;

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
