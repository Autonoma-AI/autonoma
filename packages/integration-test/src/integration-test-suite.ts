import { type TestAPI, afterAll, afterEach, beforeAll, beforeEach, describe, test } from "vitest";
import type { IntegrationHarness } from "./integration-harness";

// Default per-test timeout for integration cases. Vitest's 5s default is far too tight for
// real-Postgres tests: on a busy CI runner the first query after container boot (connection +
// Prisma engine warmup) alone can approach it, causing flaky timeouts unrelated to the code under
// test. A suite-level timeout is inherited by every case (individual tests can still override with
// their own third-arg timeout for genuinely long-running work).
const INTEGRATION_TEST_TIMEOUT_MS = 30_000;

// Lifecycle-hook timeout. Vitest's 10s default hook timeout is separate from (and not covered by)
// the suite-level test timeout above, and is likewise too tight on a contended CI runner - container
// teardown (afterAll) and any per-test DB work (before/afterEach) can exceed it. beforeAll keeps its
// own larger budget below because it also pulls the image, boots Postgres, and applies migrations.
const HOOK_TIMEOUT_MS = 120_000;

interface IntegrationTestParams<THarness extends IntegrationHarness, TSeedResult> {
    name: string;
    createHarness: () => Promise<THarness>;
    seed?: (harness: THarness) => Promise<TSeedResult>;
    cases: (test: TestAPI<{ harness: THarness; seedResult: TSeedResult }>) => void;
}

export function integrationTestSuite<THarness extends IntegrationHarness, TSeedResult = void>({
    name,
    createHarness,
    seed,
    cases,
}: IntegrationTestParams<THarness, TSeedResult>) {
    describe(name, { timeout: INTEGRATION_TEST_TIMEOUT_MS }, () => {
        let harness: THarness;
        let seedResult: TSeedResult;

        // Startup (Testcontainer image pull + Postgres boot + migrations) dominates this hook. When many
        // integration suites boot their own container in parallel on a busy CI runner, a single container's
        // startup can exceed two minutes purely from contention - so give the hook generous headroom (a ready
        // container resolves it immediately; this only affects how long we wait for a slow start, not the happy path).
        beforeAll(async () => {
            harness = await createHarness();
            await harness.beforeAll();
            if (seed != null) seedResult = await seed(harness);
        }, 300_000);

        afterAll(async () => {
            await harness?.afterAll();
        }, HOOK_TIMEOUT_MS);

        beforeEach(async () => {
            await harness.beforeEach?.();
        }, HOOK_TIMEOUT_MS);

        afterEach(async () => {
            await harness.afterEach?.();
        }, HOOK_TIMEOUT_MS);

        cases(
            test.extend<{ harness: THarness; seedResult: TSeedResult }>({
                harness: async (
                    // biome-ignore lint/correctness/noEmptyPattern: vitest fixture requirement
                    {},
                    use: (value: THarness) => Promise<void>,
                ) => use(harness),
                seedResult: async (
                    // biome-ignore lint/correctness/noEmptyPattern: vitest fixture requirement
                    {},
                    use: (value: TSeedResult) => Promise<void>,
                ) => use(seedResult),
            }),
        );
    });
}
