/**
 * Dev-only: validate the LOCAL browser-run path in isolation (no clone, no select/classify). Creates a
 * DB-backed shadow generation for one existing test's latest plan, provisions the scenario, runs the
 * generation on a LOCAL Chromium against the PR's live preview, and prints the resulting status + media.
 *
 *   HEADLESS=true tsx --env-file=/tmp/investigation-local.env scripts/run-one.ts <snapshotId> <testPlanId>
 */
import { readFile } from "node:fs/promises";
import { db } from "@autonoma/db";
import { runWebGenerationJob } from "@autonoma/engine-web/generation";
import { EncryptionHelper, ScenarioManager } from "@autonoma/scenario";
// scenarioUp/Down moved into the general worker (main #1111 removed the standalone @autonoma/job-scenario).
import { scenarioDown } from "../../general/src/activities/scenario/scenario-down";
import { scenarioUp } from "../../general/src/activities/scenario/scenario-up";

async function main(): Promise<void> {
    const [snapshotId, testPlanId] = process.argv.slice(2);
    if (snapshotId == null || testPlanId == null) {
        throw new Error("usage: run-one.ts <snapshotId> <testPlanId>");
    }
    const key = process.env.SCENARIO_ENCRYPTION_KEY;
    if (key == null || key === "") throw new Error("SCENARIO_ENCRYPTION_KEY missing");

    const plan = await db.testPlan.findUniqueOrThrow({
        where: { id: testPlanId },
        select: { id: true, scenarioId: true, organizationId: true },
    });

    const generation = await db.testGeneration.create({
        data: { testPlanId: plan.id, snapshotId, organizationId: plan.organizationId },
        select: { id: true },
    });
    console.log(`generation=${generation.id} scenario=${plan.scenarioId ?? "(none)"}`);

    const manager = new ScenarioManager(db, new EncryptionHelper(key));
    let scenarioInstanceId: string | undefined;
    try {
        if (plan.scenarioId != null) {
            await scenarioUp({ type: "generation", entityId: generation.id }, { db, manager });
            scenarioInstanceId = (await readFile("/tmp/scenario-instance-id", "utf-8")).trim();
            console.log(`scenario up: ${scenarioInstanceId}`);
        }
        await runWebGenerationJob(generation.id);
        console.log("generation job returned");
    } finally {
        if (scenarioInstanceId != null) {
            await scenarioDown({ scenarioInstanceId }, { manager }).catch((error) =>
                console.warn("scenario down failed", error),
            );
        }
    }

    const result = await db.testGeneration.findUniqueOrThrow({
        where: { id: generation.id },
        select: { status: true, videoUrl: true, finalScreenshot: true },
    });
    console.log("RESULT:", JSON.stringify(result));
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
