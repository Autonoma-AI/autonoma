import { db } from "@autonoma/db";
import { logger } from "@autonoma/logger";
import { env } from "../env";

export async function handleGenerationExit(generationId: string): Promise<void> {
    const log = logger.child({ name: "handleGenerationExit", generationId });

    const generation = await db.testGeneration.findUnique({
        where: { id: generationId },
        select: { status: true },
    });

    if (generation == null) {
        log.warn("Notification skipped - generation not found");
        return;
    }

    if (generation.status !== "failed") {
        log.info("Generation exit notification skipped for non-failed status", {
            status: generation.status,
        });
        return;
    }

    if (!env.STRIPE_ENABLED) {
        log.info("Billing notification skipped - STRIPE_ENABLED=false");
        return;
    }

    if (env.API_URL == null || env.ENGINE_BILLING_SECRET == null) {
        log.info("Billing notification skipped - API_URL or ENGINE_BILLING_SECRET not configured");
        return;
    }

    const url = `${env.API_URL}/v1/stripe/run-failed`;

    let response: Response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${env.ENGINE_BILLING_SECRET}`,
            },
            body: JSON.stringify({ generationId }),
        });
    } catch (error) {
        const cause = error instanceof Error ? error.cause : undefined;
        log.error("Billing refund request failed - network error", error, {
            url,
            cause:
                cause instanceof Error
                    ? { message: cause.message, code: (cause as NodeJS.ErrnoException).code }
                    : String(cause),
        });
        throw error;
    }

    if (!response.ok) {
        const body = await response.text().catch(() => "<unreadable>");
        log.error("Billing refund request failed - non-ok status", undefined, {
            url,
            status: response.status,
            body,
        });
        throw new Error(
            `Billing refund notification failed with status ${response.status} for generation ${generationId}: ${body}`,
        );
    }

    log.info("Generation exit billing refund notification succeeded");
}
