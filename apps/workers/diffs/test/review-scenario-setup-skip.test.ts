import { Codebase, buildVerdicts } from "@autonoma/diffs";
import { logger } from "@autonoma/logger";
import { expect } from "vitest";
import { DiffJobContextLoader } from "../src/review/diff-job-context-loader";
import { runGenerationReview } from "../src/review/generation/run";
import { runReplayReview } from "../src/review/replay/run";
import { type DiffJobContextHarness, diffJobContextSuite } from "./harness";

// The gate returns before any reviewer/model/storage is constructed, so a tree
// that never gets read is enough to satisfy the `codebase` dependency.
const stubCodebase = new Codebase("/tmp/scenario-setup-skip-test");

// `runReplayReview` / `runGenerationReview` read the module-global `db` singleton
// (`@autonoma/db`'s proxy resolves `globalThis.prisma`). Point that singleton at
// the harness's Testcontainers client so the production code path runs against
// the real test database. `Reflect.set` avoids an `as` cast on `globalThis`.
function bindGlobalDb(harness: DiffJobContextHarness): void {
    Reflect.set(globalThis, "prisma", harness.db);
}

diffJobContextSuite({
    name: "scenario_setup review skip",
    cases: (test) => {
        test("a scenario_setup-failed run skips review and yields no actionable verdict", async ({
            harness,
            seedResult,
        }) => {
            bindGlobalDb(harness);

            const { runId, snapshotId } = await harness.seedFailedRun({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                baseSha: "base000",
                headSha: "head111",
                affected: { reason: "code_change", reasoning: "stale step" },
                testName: "Scenario setup failure",
                steps: [],
            });
            await harness.db.run.update({
                where: { id: runId },
                data: { failure: { kind: "scenario_setup", message: "HTTP 500 from env-factory" } },
            });

            const result = await runReplayReview(runId, { codebase: stubCodebase });
            expect(result.status).toBe("skipped");

            // No review row was written, so the run has no actionable verdict.
            const review = await harness.db.runReview.findUnique({ where: { runId } });
            expect(review).toBeNull();

            // The resolution path drops runs without a completed review, so the
            // resolution agent receives nothing actionable and no Bug/Issue is created.
            const context = await new DiffJobContextLoader(harness.db).loadSnapshot(snapshotId);
            const verdicts = buildVerdicts(context.runs, logger.child({ name: "buildVerdicts-test" }));
            expect(verdicts).toHaveLength(0);

            const issueCount = await harness.db.issue.count({
                where: { organizationId: seedResult.organizationId },
            });
            const bugCount = await harness.db.bug.count({
                where: { organizationId: seedResult.organizationId },
            });
            expect(issueCount).toBe(0);
            expect(bugCount).toBe(0);
        });

        test("a scenario_setup-failed generation skips review and creates no review row", async ({
            harness,
            seedResult,
        }) => {
            bindGlobalDb(harness);

            const { generationId } = await harness.seedGeneration({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                status: "failed",
                testName: "Scenario setup failure",
                steps: [],
            });
            await harness.db.testGeneration.update({
                where: { id: generationId },
                data: { failure: { kind: "scenario_setup", message: "idempotency-key reuse" } },
            });

            const result = await runGenerationReview(generationId, { codebase: stubCodebase });
            expect(result.status).toBe("skipped");

            const review = await harness.db.generationReview.findUnique({ where: { generationId } });
            expect(review).toBeNull();

            const bugCount = await harness.db.bug.count({
                where: { organizationId: seedResult.organizationId },
            });
            expect(bugCount).toBe(0);
        });

        test("an engine_error-failed run is NOT skipped - the review proceeds and writes a review row", async ({
            harness,
            seedResult,
        }) => {
            bindGlobalDb(harness);

            const { runId } = await harness.seedFailedRun({
                organizationId: seedResult.organizationId,
                applicationId: seedResult.applicationId,
                affected: { reason: "code_change", reasoning: "app would not load" },
                testName: "Engine error failure",
                steps: [],
            });
            await harness.db.run.update({
                where: { id: runId },
                data: { failure: { kind: "engine_error", message: "ERR_CONNECTION_CLOSED" } },
            });

            // engine_error stays on the normal review path. Past the gate the
            // function creates the review row, then reaches the model / storage
            // layer, which is not wired up in the test environment - that
            // downstream failure is expected and proves the gate did not
            // short-circuit.
            let status: string | undefined;
            try {
                ({ status } = await runReplayReview(runId, { codebase: stubCodebase }));
            } catch (err) {
                logger.debug("engine_error review failed downstream as expected in test", { extra: { err } });
            }

            expect(status).not.toBe("skipped");

            // The review row was created - definitive proof the gate let the run through.
            const review = await harness.db.runReview.findUnique({ where: { runId } });
            expect(review).not.toBeNull();
        });
    },
});
