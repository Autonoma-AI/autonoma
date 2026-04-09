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

        beforeAll(async () => {
            harness = await createHarness();
            await harness.beforeAll();
            if (seed != null) seedResult = await seed(harness);
        }, 120_000);

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
