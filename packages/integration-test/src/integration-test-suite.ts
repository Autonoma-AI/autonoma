import { type TestAPI, afterAll, afterEach, beforeAll, beforeEach, describe, test } from "vitest";
import type { IntegrationHarness } from "./integration-harness";

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
    describe(name, () => {
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
        });

        beforeEach(async () => {
            await harness.beforeEach?.();
        });

        afterEach(async () => {
            await harness.afterEach?.();
        });

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
