import { Codebase } from "@autonoma/diffs";
import { expect } from "vitest";
import { runGenerationReview } from "../src/review/generation/run";
import { type DiffJobContextHarness, diffJobContextSuite } from "./harness";

// The gate returns before any reviewer/model/storage is constructed, so a tree
// that never gets read is enough to satisfy the `codebase` dependency.
const stubCodebase = new Codebase("/tmp/scenario-setup-skip-test");

// `runGenerationReview` reads the module-global `db` singleton (`@autonoma/db`'s
// proxy resolves `globalThis.prisma`). Point that singleton at the harness's
// Testcontainers client so the production code path runs against the real test
// database. `Reflect.set` avoids an `as` cast on `globalThis`.
function bindGlobalDb(harness: DiffJobContextHarness): void {
    Reflect.set(globalThis, "prisma", harness.db);
}

diffJobContextSuite({
    name: "scenario_setup review skip",
    cases: (test) => {
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
    },
});
