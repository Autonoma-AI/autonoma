import type { PrismaClient, ScenarioInstanceStatus } from "@autonoma/db";
import { type ScenarioData, materializeScenarioData } from "@autonoma/diffs";
import type { Logger } from "@autonoma/logger";
import { z } from "zod";

export interface LegacyScenarioInstance {
    id: string;
    status: ScenarioInstanceStatus;
    scenarioName: string;
}

// The `up` request body the scenario manager logs; we only need `create`.
const upWebhookRequestSchema = z.object({ create: z.unknown() });

/**
 * Eval-only fallback: recover a pre-#822 instance's scenario data (null
 * `generatedData`) from its `UP` `webhook_call.request_body.create`. Returns
 * `undefined` - so the caller omits the scenario - when there is no instance,
 * it never came up, no `UP` webhook survives, or the body has no create graph.
 */
export async function recoverScenarioDataFromWebhook(
    db: PrismaClient,
    instance: LegacyScenarioInstance | undefined,
    logger: Logger,
): Promise<ScenarioData | undefined> {
    if (instance == null) {
        logger.info("No scenario instance to recover from - omitting scenario context");
        return undefined;
    }

    const neverCameUp = instance.status === "REQUESTED" || instance.status === "UP_FAILED";
    if (neverCameUp) {
        logger.info("Scenario never came up - no data to recover, omitting scenario context", {
            extra: { instanceId: instance.id, scenarioStatus: instance.status },
        });
        return undefined;
    }

    const call = await db.webhookCall.findFirst({
        where: { instanceId: instance.id, action: "UP" },
        orderBy: { createdAt: "desc" },
        select: { requestBody: true },
    });
    if (call == null) {
        logger.info("No UP webhook_call survives for instance - cannot recover scenario data", {
            extra: { instanceId: instance.id },
        });
        return undefined;
    }

    const parsed = upWebhookRequestSchema.safeParse(call.requestBody);
    if (!parsed.success) {
        logger.warn("UP webhook request body has no usable create graph - omitting scenario context", {
            extra: { instanceId: instance.id, error: parsed.error.message },
        });
        return undefined;
    }

    logger.info("Recovering scenario data from UP webhook create graph", {
        extra: { instanceId: instance.id, scenarioName: instance.scenarioName },
    });
    return materializeScenarioData(instance.scenarioName, parsed.data.create, logger);
}
