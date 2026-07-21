import {
    AmpPrometheusClient,
    createBillingService,
    PreviewUsageMeterSweepService,
    SigV4AmpRequestSender,
} from "@autonoma/billing";
import { db } from "@autonoma/db";
import { runWithSentry } from "@autonoma/logger";
import { captureCheckIn } from "@sentry/node";
import { env } from "../env";

const JOB_NAME = "preview-usage-meter";

async function main() {
    const checkInId = captureCheckIn({ monitorSlug: JOB_NAME, status: "in_progress" });

    try {
        const sender = new SigV4AmpRequestSender(env.AMP_WORKSPACE_URL, env.AMP_REGION);
        const amp = new AmpPrometheusClient(sender);
        const billingService = createBillingService(db);
        const sweep = new PreviewUsageMeterSweepService(db, amp, billingService);

        const result = await sweep.run(new Date());

        captureCheckIn({ checkInId, monitorSlug: JOB_NAME, status: "ok" });
        return result;
    } catch (error) {
        captureCheckIn({ checkInId, monitorSlug: JOB_NAME, status: "error" });
        throw error;
    }
}

runWithSentry({ name: JOB_NAME }, async () => {
    const result = await main();
    console.log(`Previewkit usage-meter sweep complete: ${JSON.stringify(result)}`);
});
