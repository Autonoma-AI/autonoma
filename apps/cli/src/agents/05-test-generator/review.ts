import { readFile } from "node:fs/promises";
import { join, relative, basename } from "node:path";
import { type LanguageModel } from "ai";
import { glob } from "glob";
import { createStepLogger } from "../../core/display";
import { captureLog } from "../../core/logs";
import { isTestFile, TEST_FILE_GLOB, TESTS_DIR } from "../../core/test-files";
import { runReviewPass } from "./review-pass";
import { ALL_RUBRICS, type DimensionResult } from "./rubrics";

const MAX_CONCURRENT_TESTS = 4;

export type ReviewResult = Record<string, DimensionResult>;

export interface TestReviewFeedback {
    testPath: string;
    relativePath: string;
    content: string;
    flow: string;
    passed: boolean;
    dimensions: ReviewResult;
    failedDimensions: string[];
}

async function reviewSingleTest(
    testContent: string,
    testPath: string,
    projectRoot: string,
    model: LanguageModel,
    scenarioData?: string,
): Promise<ReviewResult> {
    const passes = await Promise.all(
        ALL_RUBRICS.map((rubric) =>
            runReviewPass(testContent, testPath, rubric, projectRoot, model, scenarioData).catch((err) => {
                console.warn(
                    `  [review] ${rubric.name} error on ${basename(testPath)}: ${err instanceof Error ? err.message : String(err)}`,
                );
                return undefined;
            }),
        ),
    );

    const merged: ReviewResult = {};
    for (let i = 0; i < ALL_RUBRICS.length; i++) {
        const rubric = ALL_RUBRICS[i]!;
        const passResult = passes[i];
        for (const dim of rubric.dimensions) {
            if (passResult && dim in passResult) {
                merged[dim] = passResult[dim]!;
            } else {
                merged[dim] = { pass: true, evidence: "Rubric pass did not return result - fail-open" };
            }
        }
    }

    return merged;
}

export async function runConsolidatedReview(
    outputDir: string,
    projectRoot: string,
    model: LanguageModel,
    deadline: number,
): Promise<{ passed: number; failed: number; feedback: TestReviewFeedback[]; ranOutOfTime: boolean }> {
    const testsDir = join(outputDir, TESTS_DIR);
    const logger = createStepLogger("review", 5);

    let scenarioData: string | undefined;
    try {
        scenarioData = await readFile(join(outputDir, "scenarios.md"), "utf-8");
    } catch {
        /* scenarios not available */
    }

    const testFiles = await glob(join(testsDir, TEST_FILE_GLOB));
    const tests: { path: string; relativePath: string; content: string; flow: string }[] = [];
    for (const testPath of testFiles) {
        if (!isTestFile(testPath)) continue;
        if (testPath.includes("/_invalid/")) continue;
        const content = await readFile(testPath, "utf-8");
        const flowMatch = content.match(/^---\n[\s\S]*?flow:\s*["']?([^"'\n]+)["']?\s*\n[\s\S]*?---/m);
        tests.push({
            path: testPath,
            relativePath: relative(testsDir, testPath),
            content,
            flow: flowMatch?.[1]?.trim() ?? "unknown",
        });
    }

    const totalAgents = tests.length * ALL_RUBRICS.length;
    logger.log({
        stepNumber: 1,
        maxSteps: 2,
        text: `Reviewing ${tests.length} tests × ${ALL_RUBRICS.length} rubrics = ${totalAgents} agents (${MAX_CONCURRENT_TESTS} tests concurrent)`,
        toolCalls: [],
        toolErrors: [],
        writtenFiles: [],
    });

    let passed = 0;
    let failed = 0;
    let ranOutOfTime = false;
    const feedback: TestReviewFeedback[] = [];

    for (let i = 0; i < tests.length; i += MAX_CONCURRENT_TESTS) {
        if (Date.now() > deadline) {
            ranOutOfTime = true;
            const unreviewed = tests.length - i;
            console.log(`  [review] Out of time - ${unreviewed} of ${tests.length} tests left unreviewed`);
            captureLog("warn", `Review out of time - ${unreviewed} of ${tests.length} tests left unreviewed`, {
                source: "review",
                unreviewed,
                total: tests.length,
            });
            break;
        }

        const batch = tests.slice(i, i + MAX_CONCURRENT_TESTS);
        const results = await Promise.all(
            batch.map(async (test) => {
                const result = await reviewSingleTest(
                    test.content,
                    test.relativePath,
                    projectRoot,
                    model,
                    scenarioData,
                );
                return { test, result };
            }),
        );

        for (const { test, result } of results) {
            const failedDimensions: string[] = [];
            for (const [key, dim] of Object.entries(result)) {
                if (!dim.pass) failedDimensions.push(key);
            }

            if (failedDimensions.length === 0) {
                passed++;
            } else {
                failed++;
                feedback.push({
                    testPath: test.path,
                    relativePath: test.relativePath,
                    content: test.content,
                    flow: test.flow,
                    passed: false,
                    dimensions: result,
                    failedDimensions,
                });
            }
        }

        console.log(
            `  [review] Progress: ${Math.min(i + MAX_CONCURRENT_TESTS, tests.length)}/${tests.length} reviewed, ${passed} passed, ${failed} failed`,
        );
    }

    logger.log({
        stepNumber: 2,
        maxSteps: 2,
        text: `Review complete: ${passed} passed, ${failed} failed`,
        toolCalls: [],
        toolErrors: [],
        writtenFiles: [],
    });

    logger.summary();
    return { passed, failed, feedback, ranOutOfTime };
}
