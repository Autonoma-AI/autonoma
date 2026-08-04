import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { resolvePreviewkitBypassToken as decryptBypassToken } from "@autonoma/utils";
import { env } from "./env";

export async function resolvePreviewkitBypassToken(url: string): Promise<string | undefined> {
    const normalizedUrl = url.replace(/\/$/, "");
    const logger = rootLogger.child({ name: "resolvePreviewkitBypassToken" });
    logger.info("Looking up previewkit bypass token", { originalUrl: url, normalizedUrl });
    const instance = await db.previewkitAppInstance.findFirst({
        where: { url: normalizedUrl },
        select: { environment: { select: { bypassToken: true } } },
    });
    const stored = instance?.environment.bypassToken;
    logger.info("Previewkit bypass token lookup result", { normalizedUrl, found: stored != null });
    if (stored == null) return undefined;
    return decryptBypassToken(stored, env.PREVIEWKIT_BYPASS_TOKEN_KEY);
}
