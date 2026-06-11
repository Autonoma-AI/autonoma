import { type AssertCommandSpec, RunPersister } from "@autonoma/engine";
import { integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { FakeStorageProvider, PersisterTestHarness } from "./persister-harness";

/** A custom error class so the persisted `errorName` is a meaningful classifier. */
class ElementNotFoundError extends Error {}

function persisterFor(harness: PersisterTestHarness, runId: string): RunPersister<AssertCommandSpec> {
    return new RunPersister<AssertCommandSpec>({
        db: harness.db,
        storageProvider: new FakeStorageProvider(),
        runId,
        videoExtension: "webm",
    });
}

async function readRunOutputs(harness: PersisterTestHarness, runId: string) {
    const list = await harness.db.stepOutputList.findFirstOrThrow({ where: { runId } });
    return harness.db.stepOutput.findMany({ where: { listId: list.id }, orderBy: { order: "asc" } });
}

integrationTestSuite({
    name: "RunPersister.recordStep",
    createHarness: () => PersisterTestHarness.create(),
    cases: (test) => {
        test("a failed step records the error class under errorName alongside the message", async ({ harness }) => {
            const seed = await harness.seedRun();
            const persister = persisterFor(harness, seed.runId);
            await persister.markRunning();

            await persister.recordStep(
                {
                    interaction: "assert",
                    params: { instruction: "the dashboard is visible" },
                    error: new ElementNotFoundError("could not find 'the dashboard'"),
                },
                1,
            );

            const outputs = await readRunOutputs(harness, seed.runId);
            expect(outputs).toHaveLength(1);
            // The failed step's output carries both the message (outcome) and the
            // error class (errorName) - the attribution classifier the replay
            // reviewer reads back via the shared command-aware renderer.
            expect(outputs[0]!.output).toEqual({
                outcome: "could not find 'the dashboard'",
                errorName: "ElementNotFoundError",
            });
        });

        test("a successful step records the command output verbatim, with no errorName", async ({ harness }) => {
            const seed = await harness.seedRun();
            const persister = persisterFor(harness, seed.runId);
            await persister.markRunning();

            const output = {
                outcome: "All 1 assertion(s) passed",
                results: [{ assertion: "the dashboard is visible", metCondition: true, reason: "rendered" }],
            };
            await persister.recordStep(
                {
                    interaction: "assert",
                    params: { instruction: "the dashboard is visible" },
                    output,
                },
                1,
            );

            const outputs = await readRunOutputs(harness, seed.runId);
            expect(outputs).toHaveLength(1);
            expect(outputs[0]!.output).toEqual(output);
            // No errorName key means the loader reads this back as a success - the
            // discriminant that keeps successful command outputs out of the failure
            // branch (no command output ever carries an `errorName` field).
            expect(outputs[0]!.output).not.toHaveProperty("errorName");
        });
    },
});
