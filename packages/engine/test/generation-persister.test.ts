import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssertCommandSpec, type FailedStep, type GeneratedStep, GenerationPersister } from "@autonoma/engine";
import { Screenshot } from "@autonoma/image";
import { integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { FakeStorageProvider, PersisterTestHarness } from "./persister-harness";

function fakeScreenshot(label: string): Screenshot {
    return Screenshot.fromBuffer(Buffer.from(label));
}

interface CompletionResultOptions {
    success: boolean;
    finishReason: "success" | "max_steps" | "error";
    reasoning?: string;
}

function completionResult({ success, finishReason, reasoning }: CompletionResultOptions) {
    return {
        generatedSteps: [],
        memory: {},
        success,
        finishReason,
        reasoning,
        conversation: [],
    };
}

/** Writes a throwaway video file so markCompleted's upload step has something to read. */
async function withVideoFile(run: (videoPath: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "gen-persister-"));
    const videoPath = join(dir, "recording.webm");
    await writeFile(videoPath, Buffer.from("fake-video"));
    try {
        await run(videoPath);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

function successAttempt(
    instruction: string,
    beforeLabel: string,
    afterLabel: string,
): GeneratedStep<AssertCommandSpec> {
    return {
        status: "success",
        executionOutput: {
            stepData: { interaction: "assert", params: { instruction } },
            result: {
                outcome: "All 1 assertion(s) passed",
                results: [{ assertion: instruction, metCondition: true, reason: "looks right" }],
            },
        },
        beforeMetadata: { screenshot: fakeScreenshot(beforeLabel) },
        afterMetadata: { screenshot: fakeScreenshot(afterLabel) },
    };
}

function failedAttempt(instruction: string, beforeLabel: string, afterLabel?: string): FailedStep<AssertCommandSpec> {
    return {
        status: "failed",
        interaction: "assert",
        input: { instruction },
        params: { instruction },
        error: `Assertion failed:\n- ${instruction}: not visible`,
        errorName: "AssertionFailedError",
        beforeMetadata: { screenshot: fakeScreenshot(beforeLabel) },
        afterMetadata: afterLabel != null ? { screenshot: fakeScreenshot(afterLabel) } : undefined,
    };
}

integrationTestSuite({
    name: "GenerationPersister.recordAttempt",
    createHarness: () => PersisterTestHarness.create(),
    cases: (test) => {
        test("a successful attempt writes StepAttempt(success) + StepInput + StepOutput reusing screenshot keys", async ({
            harness,
        }) => {
            const seed = await harness.seedGeneration();
            const storage = new FakeStorageProvider();
            const persister = new GenerationPersister<AssertCommandSpec>({
                db: harness.db,
                storageProvider: storage,
                testGenerationId: seed.generationId,
                videoExtension: "webm",
            });
            await persister.markRunning();

            await persister.recordAttempt({
                attempt: successAttempt("the dashboard is visible", "before-1", "after-1"),
                order: 1,
                successfulOrder: 1,
            });

            const attempts = await harness.db.stepAttempt.findMany({ where: { generationId: seed.generationId } });
            expect(attempts).toHaveLength(1);
            const attempt = attempts[0]!;
            expect(attempt.status).toBe("success");
            expect(attempt.order).toBe(1);
            expect(attempt.error).toBeNull();
            expect(attempt.errorName).toBeNull();

            // StepInput/StepOutput hang off the generation's lists.
            const generation = await harness.db.testGeneration.findUniqueOrThrow({
                where: { id: seed.generationId },
                select: { stepsId: true, outputsId: true },
            });
            const inputs = await harness.db.stepInput.findMany({ where: { listId: generation.stepsId! } });
            const outputs = await harness.db.stepOutput.findMany({ where: { listId: generation.outputsId! } });
            expect(inputs).toHaveLength(1);
            expect(outputs).toHaveLength(1);
            expect(inputs[0]!.order).toBe(1);
            expect(outputs[0]!.order).toBe(1);

            // The successful StepAttempt reuses the StepInput screenshot keys (one upload each phase).
            expect(attempt.screenshotBefore).toBe(inputs[0]!.screenshotBefore);
            expect(attempt.screenshotAfter).toBe(inputs[0]!.screenshotAfter);

            const uploadedKeys = [...storage.uploads.keys()].sort();
            expect(uploadedKeys).toEqual([
                `test-generation/${seed.generationId}/step-1-after.png`,
                `test-generation/${seed.generationId}/step-1-before.png`,
            ]);
        });

        test("a failed attempt writes only StepAttempt(failed) under the attempt namespace", async ({ harness }) => {
            const seed = await harness.seedGeneration();
            const storage = new FakeStorageProvider();
            const persister = new GenerationPersister<AssertCommandSpec>({
                db: harness.db,
                storageProvider: storage,
                testGenerationId: seed.generationId,
                videoExtension: "webm",
            });
            await persister.markRunning();

            await persister.recordAttempt({
                attempt: failedAttempt("the success toast is shown", "before-fail", "after-fail"),
                order: 1,
            });

            const attempts = await harness.db.stepAttempt.findMany({ where: { generationId: seed.generationId } });
            expect(attempts).toHaveLength(1);
            const attempt = attempts[0]!;
            expect(attempt.status).toBe("failed");
            expect(attempt.order).toBe(1);
            expect(attempt.error).toContain("Assertion failed");
            expect(attempt.errorName).toBe("AssertionFailedError");
            expect(attempt.screenshotBefore).toBe(
                `s3://fake/test-generation/${seed.generationId}/attempt-1-before.png`,
            );
            expect(attempt.screenshotAfter).toBe(`s3://fake/test-generation/${seed.generationId}/attempt-1-after.png`);

            const generation = await harness.db.testGeneration.findUniqueOrThrow({
                where: { id: seed.generationId },
                select: { stepsId: true, outputsId: true },
            });
            const inputs = await harness.db.stepInput.findMany({ where: { listId: generation.stepsId! } });
            const outputs = await harness.db.stepOutput.findMany({ where: { listId: generation.outputsId! } });
            // A failure produces no replay rows.
            expect(inputs).toHaveLength(0);
            expect(outputs).toHaveLength(0);

            const uploadedKeys = [...storage.uploads.keys()].sort();
            expect(uploadedKeys).toEqual([
                `test-generation/${seed.generationId}/attempt-1-after.png`,
                `test-generation/${seed.generationId}/attempt-1-before.png`,
            ]);
        });

        test("a failed attempt with no after-screenshot leaves screenshotAfter absent", async ({ harness }) => {
            const seed = await harness.seedGeneration();
            const storage = new FakeStorageProvider();
            const persister = new GenerationPersister<AssertCommandSpec>({
                db: harness.db,
                storageProvider: storage,
                testGenerationId: seed.generationId,
                videoExtension: "webm",
            });
            await persister.markRunning();

            await persister.recordAttempt({
                attempt: failedAttempt("the modal closed", "before-fail"),
                order: 1,
            });

            const attempt = await harness.db.stepAttempt.findFirstOrThrow({
                where: { generationId: seed.generationId },
            });
            expect(attempt.screenshotBefore).toBe(
                `s3://fake/test-generation/${seed.generationId}/attempt-1-before.png`,
            );
            expect(attempt.screenshotAfter).toBeNull();
            expect([...storage.uploads.keys()]).toEqual([`test-generation/${seed.generationId}/attempt-1-before.png`]);
        });

        test("a generation with a failing step records the full timeline but a successful-only replay list", async ({
            harness,
        }) => {
            const seed = await harness.seedGeneration();
            const storage = new FakeStorageProvider();
            const persister = new GenerationPersister<AssertCommandSpec>({
                db: harness.db,
                storageProvider: storage,
                testGenerationId: seed.generationId,
                videoExtension: "webm",
            });
            await persister.markRunning();

            // Full timeline: success, failure, success. Replay list: only the two successes.
            await persister.recordAttempt({
                attempt: successAttempt("step one done", "b1", "a1"),
                order: 1,
                successfulOrder: 1,
            });
            await persister.recordAttempt({
                attempt: failedAttempt("step two condition", "b2", "a2"),
                order: 2,
            });
            await persister.recordAttempt({
                attempt: successAttempt("step three done", "b3", "a3"),
                order: 3,
                successfulOrder: 2,
            });

            const attempts = await harness.db.stepAttempt.findMany({
                where: { generationId: seed.generationId },
                orderBy: { order: "asc" },
            });
            expect(attempts.map((a) => ({ order: a.order, status: a.status }))).toEqual([
                { order: 1, status: "success" },
                { order: 2, status: "failed" },
                { order: 3, status: "success" },
            ]);

            const failed = attempts.find((a) => a.status === "failed")!;
            expect(failed.error).toContain("Assertion failed");
            expect(failed.errorName).toBe("AssertionFailedError");
            expect(failed.screenshotBefore).not.toBeNull();

            const generation = await harness.db.testGeneration.findUniqueOrThrow({
                where: { id: seed.generationId },
                select: { stepsId: true },
            });
            const inputs = await harness.db.stepInput.findMany({
                where: { listId: generation.stepsId! },
                orderBy: { order: "asc" },
            });
            // The replay list skips the failure: two successful steps, contiguous orders.
            expect(inputs.map((i) => i.order)).toEqual([1, 2]);
        });
    },
});

integrationTestSuite({
    name: "GenerationPersister.markCompleted",
    createHarness: () => PersisterTestHarness.create(),
    cases: (test) => {
        test("a max_steps failure records status failed + failure {max_steps} and keeps the reasoning prose", async ({
            harness,
        }) => {
            const seed = await harness.seedGeneration();
            const persister = new GenerationPersister<AssertCommandSpec>({
                db: harness.db,
                storageProvider: new FakeStorageProvider(),
                testGenerationId: seed.generationId,
                videoExtension: "webm",
            });
            await persister.markRunning();

            await withVideoFile((videoPath) =>
                persister.markCompleted({
                    result: completionResult({
                        success: false,
                        finishReason: "max_steps",
                        reasoning: "I kept retrying the login but never reached the dashboard.",
                    }),
                    videoPath,
                }),
            );

            const generation = await harness.db.testGeneration.findUniqueOrThrow({
                where: { id: seed.generationId },
                select: { status: true, failure: true, reasoning: true },
            });
            expect(generation.status).toBe("failed");
            expect(generation.failure).toEqual({ kind: "max_steps" });
            expect(generation.reasoning).toBe("I kept retrying the login but never reached the dashboard.");
        });

        test("an error finishReason records failure {agent_failed} and keeps the reasoning prose", async ({
            harness,
        }) => {
            const seed = await harness.seedGeneration();
            const persister = new GenerationPersister<AssertCommandSpec>({
                db: harness.db,
                storageProvider: new FakeStorageProvider(),
                testGenerationId: seed.generationId,
                videoExtension: "webm",
            });
            await persister.markRunning();

            await withVideoFile((videoPath) =>
                persister.markCompleted({
                    result: completionResult({
                        success: false,
                        finishReason: "error",
                        reasoning: "The expected confirmation never appeared, so I gave up.",
                    }),
                    videoPath,
                }),
            );

            const generation = await harness.db.testGeneration.findUniqueOrThrow({
                where: { id: seed.generationId },
                select: { status: true, failure: true, reasoning: true },
            });
            expect(generation.status).toBe("failed");
            expect(generation.failure).toEqual({ kind: "agent_failed" });
            expect(generation.reasoning).toBe("The expected confirmation never appeared, so I gave up.");
        });

        test("a successful completion records status success and leaves failure null", async ({ harness }) => {
            const seed = await harness.seedGeneration();
            const persister = new GenerationPersister<AssertCommandSpec>({
                db: harness.db,
                storageProvider: new FakeStorageProvider(),
                testGenerationId: seed.generationId,
                videoExtension: "webm",
            });
            await persister.markRunning();

            await withVideoFile((videoPath) =>
                persister.markCompleted({
                    result: completionResult({ success: true, finishReason: "success" }),
                    videoPath,
                }),
            );

            const generation = await harness.db.testGeneration.findUniqueOrThrow({
                where: { id: seed.generationId },
                select: { status: true, failure: true },
            });
            expect(generation.status).toBe("success");
            expect(generation.failure).toBeNull();
        });
    },
});

integrationTestSuite({
    name: "GenerationPersister.markFailed",
    createHarness: () => PersisterTestHarness.create(),
    cases: (test) => {
        test("an engine/driver exception records failure {engine_error} with the real message and no reasoning", async ({
            harness,
        }) => {
            const seed = await harness.seedGeneration();
            const persister = new GenerationPersister<AssertCommandSpec>({
                db: harness.db,
                storageProvider: new FakeStorageProvider(),
                testGenerationId: seed.generationId,
                videoExtension: "webm",
            });
            await persister.markRunning();

            await persister.markFailed(new Error("Driver crashed: ECONNREFUSED"));

            const generation = await harness.db.testGeneration.findUniqueOrThrow({
                where: { id: seed.generationId },
                select: { status: true, failure: true, reasoning: true },
            });
            expect(generation.status).toBe("failed");
            expect(generation.failure).toEqual({ kind: "engine_error", message: "Driver crashed: ECONNREFUSED" });
            expect(generation.reasoning).toBeNull();
        });

        test("a non-Error failure falls back to a generic engine_error message", async ({ harness }) => {
            const seed = await harness.seedGeneration();
            const persister = new GenerationPersister<AssertCommandSpec>({
                db: harness.db,
                storageProvider: new FakeStorageProvider(),
                testGenerationId: seed.generationId,
                videoExtension: "webm",
            });
            await persister.markRunning();

            await persister.markFailed("a raw string throw, not an Error");

            const generation = await harness.db.testGeneration.findUniqueOrThrow({
                where: { id: seed.generationId },
                select: { status: true, failure: true },
            });
            expect(generation.status).toBe("failed");
            expect(generation.failure).toEqual({ kind: "engine_error", message: "Unknown error" });
        });
    },
});
