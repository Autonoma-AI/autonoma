/**
 * LOCAL full-pipeline runner (dev only, NOT shipped). Runs the whole investigation pipeline end-to-end on
 * this machine against a PR's LIVE preview, using the DB-backed generations (the stored reference to the S3
 * video/screenshots): select -> scenario up -> browser generation (local Chromium) -> classify -> report.
 * Proposed/modified tests are run too, retrying until they pass (added incrementally).
 *
 *   REMOTE_BROWSER_URL= HEADLESS=true tsx --env-file=/tmp/investigation-local.env scripts/run-pipeline.ts <snapshotId>
 */
import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { EncryptionHelper, ScenarioManager } from "@autonoma/scenario";
import type { InvestigationSelectedTest, InvestigationTestResult } from "@autonoma/workflow/activities";
// scenarioUp/Down moved into the general worker (main #1111 removed the standalone @autonoma/job-scenario);
// reach them by relative path - this is a dev-only harness, so the cross-app import is acceptable here.
import { scenarioDown } from "../../general/src/activities/scenario/scenario-down";
import { scenarioUp } from "../../general/src/activities/scenario/scenario-up";
import { classifyInvestigationRun } from "../src/activities/classify-run";
import { selectInvestigationTests } from "../src/activities/select-tests";
import { writeInvestigationReport } from "../src/activities/write-report";

const logger = rootLogger.child({ name: "run-pipeline" });

/** Provision the scenario, run the browser generation locally, tear the scenario down. DB-backed. */
async function runGeneration(manager: ScenarioManager, test: InvestigationSelectedTest): Promise<void> {
    let scenarioInstanceId: string | undefined;
    try {
        if (test.scenarioId != null) {
            await scenarioUp({ type: "generation", entityId: test.testGenerationId }, { db, manager });
            // Read the instance id from the DB (scenarioUp links it to the generation), NOT the shared
            // /tmp/scenario-instance-id file - concurrent runs would clobber each other's file.
            const gen = await db.testGeneration.findUnique({
                where: { id: test.testGenerationId },
                select: { scenarioInstanceId: true },
            });
            scenarioInstanceId = gen?.scenarioInstanceId ?? undefined;
            logger.info("Scenario up", { extra: { slug: test.slug, scenarioInstanceId } });
        }
        // Lazy-import engine-web (Playwright) only when we actually run a browser, so the heavy select step
        // runs in a light process and doesn't OOM/crash before producing a selection.
        const { runWebGenerationJob } = await import("@autonoma/engine-web/generation");
        await runWebGenerationJob(test.testGenerationId);
        logger.info("Generation finished", { extra: { slug: test.slug } });
    } catch (error) {
        logger.error("Generation run errored; classifying the failed run anyway", {
            extra: { slug: test.slug },
            err: error,
        });
    } finally {
        if (scenarioInstanceId != null) {
            await scenarioDown({ scenarioInstanceId }, { manager }).catch((error) =>
                logger.warn("scenario down failed", { err: error }),
            );
        }
    }
}

async function main(): Promise<void> {
    const snapshotId = process.argv[2];
    if (snapshotId == null || snapshotId === "") throw new Error("usage: run-pipeline.ts <snapshotId>");
    const key = process.env.SCENARIO_ENCRYPTION_KEY;
    if (key == null || key === "") throw new Error("SCENARIO_ENCRYPTION_KEY missing from env");
    const manager = new ScenarioManager(db, new EncryptionHelper(key));

    logger.info("Selecting affected tests", { extra: { snapshotId } });
    const selection = await selectInvestigationTests({ snapshotId });
    // Synchronous so it survives process.exit even if the async logger drops buffered lines.
    console.log(
        `SELECTED affected=${JSON.stringify(selection.tests.map((test) => test.slug))} ` +
            `suggested=${JSON.stringify(selection.suggested.map((test) => test.name))} ` +
            `quarantine=${JSON.stringify(selection.quarantine.map((item) => item.slug))}`,
    );

    // Run tests with bounded concurrency (default 4). Each test is one live browser + a scenario seeded into
    // the CLIENT preview, so this is deliberately capped, not unbounded - tune with PIPELINE_CONCURRENCY.
    const concurrency = Math.max(1, Number(process.env.PIPELINE_CONCURRENCY ?? 4));
    const results: InvestigationTestResult[] = [];
    const queue = [...selection.tests];
    async function worker(): Promise<void> {
        for (let test = queue.shift(); test != null; test = queue.shift()) {
            logger.info("=== Running affected test ===", { extra: { slug: test.slug } });
            try {
                await runGeneration(manager, test);
                const result = await classifyInvestigationRun({
                    snapshotId,
                    slug: test.slug,
                    reason: test.reason,
                    testGenerationId: test.testGenerationId,
                });
                logger.info("Classified", { extra: { slug: test.slug, category: result.verdict?.category } });
                results.push(result);
            } catch (error) {
                logger.error("Test failed; recording and continuing", { extra: { slug: test.slug }, err: error });
                results.push({
                    slug: test.slug,
                    plan: "",
                    runSuccess: false,
                    stepCount: 0,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }
    logger.info("Running tests", { extra: { count: selection.tests.length, concurrency } });
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));

    const report = await writeInvestigationReport({
        snapshotId,
        results,
        suggested: selection.suggested,
        quarantine: selection.quarantine,
    });
    logger.info("Report written", { extra: { reportUrl: report.reportUrl } });
    console.log(JSON.stringify(report, null, 2));
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
