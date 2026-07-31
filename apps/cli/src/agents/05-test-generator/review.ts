import { readFile } from "node:fs/promises";
import { join, relative, basename } from "node:path";
import { type LanguageModel } from "ai";
import { glob } from "glob";
import { debugLog } from "../../core/debug";
import { createStepLogger } from "../../core/display";
import { captureLog } from "../../core/logs";
import { runPool } from "../../core/pool";
import { isTestFile, TEST_FILE_GLOB, TESTS_DIR } from "../../core/test-files";
import { loadRecipeContext } from "./recipe-context";
import { runReviewPass } from "./review-pass";
import { ALL_RUBRICS, type DimensionResult } from "./rubrics";

/**
 * Review agents in flight at once, across every (test, rubric) pair.
 *
 * The old scheduler ran 4 tests x 4 rubrics as one batch and awaited the whole
 * batch, which measured 44% utilisation - a fifth of the phase sat at a single
 * call in flight, waiting out one slow rubric. A pool over pairs keeps the
 * slots full, and review is the overwhelming majority of the step's wall clock.
 */
const REVIEW_CONCURRENCY = 16;

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

/**
 * Flatten one test's per-rubric results into the flat dimension map the fix
 * prompt reads. A dimension whose rubric errored or returned nothing fails
 * open - a reviewer that could not answer must not condemn a good test.
 */
function mergeRubricResults(reported: ReadonlyMap<string, ReviewResult>): ReviewResult {
    const merged: ReviewResult = {};
    for (const rubric of ALL_RUBRICS) {
        const result = reported.get(rubric.name);
        for (const dim of rubric.dimensions) {
            merged[dim] = result?.[dim] ?? {
                pass: true,
                evidence: "Rubric pass did not return result - fail-open",
            };
        }
    }
    return merged;
}

/** One test's verdict across every rubric, as the pipeline hands it back. */
export interface SingleTestReview {
    relativePath: string;
    /** The file content at review time, so a later rewrite can be compared against it. */
    content: string;
    dimensions: ReviewResult;
    failedDimensions: string[];
}

/** A test as the generator just wrote it, passed straight to review. */
export interface WrittenTest {
    /** Path relative to the tests dir - an identifier here, and where the fix pass writes. */
    relativePath: string;
    content: string;
    flow: string;
}

export interface ReviewOneTestInput {
    projectRoot: string;
    model: LanguageModel;
    test: WrittenTest;
    /** The rendered data contract, loaded once by the caller rather than per test. */
    dataContract?: string;
}

/**
 * Review one test against every rubric, on content held in memory.
 *
 * The generator has just rendered this test, so re-reading it back off disk
 * would only re-derive what the caller already has - and coupling the two
 * through a path meant they could disagree about what that path was relative to,
 * which is exactly how the first version reviewed nothing at all. The bulk pass
 * below still reads from disk, because by then the fix cycles have rewritten
 * files and only disk knows the current content.
 */
export async function reviewOneTest({
    projectRoot,
    model,
    test,
    dataContract,
}: ReviewOneTestInput): Promise<SingleTestReview> {
    const reported = new Map<string, ReviewResult>();
    await Promise.all(
        ALL_RUBRICS.map(async (rubric) => {
            const result = await runReviewPass(
                test.content,
                test.relativePath,
                rubric,
                projectRoot,
                model,
                dataContract,
            ).catch((err: unknown) => {
                console.warn(
                    `  [review] ${rubric.name} error on ${basename(test.relativePath)}: ${err instanceof Error ? err.message : String(err)}`,
                );
                return undefined;
            });
            reported.set(rubric.name, result ?? {});
        }),
    );

    const dimensions = mergeRubricResults(reported);
    return {
        relativePath: test.relativePath,
        content: test.content,
        dimensions,
        failedDimensions: Object.entries(dimensions)
            .filter(([, dim]) => !dim.pass)
            .map(([key]) => key),
    };
}

/**
 * The data the reviewers check assertions against. Prefers the rendered recipe -
 * the rows actually written to the database - and falls back to the scenario
 * summary, matching what the generator itself was given.
 */
export async function readDataContract(outputDir: string): Promise<string | undefined> {
    const recipe = await loadRecipeContext(outputDir);
    if (recipe !== "") return recipe;
    try {
        return await readFile(join(outputDir, "scenarios.md"), "utf-8");
    } catch (err) {
        debugLog("No data contract available for review", { err });
        return undefined;
    }
}

export interface ConsolidatedReviewResult {
    passed: number;
    failed: number;
    feedback: TestReviewFeedback[];
    ranOutOfTime: boolean;
    /** Tests that passed every rubric this cycle, by path relative to the tests dir. */
    passedPaths: string[];
}

/**
 * Review every test that has not already passed.
 *
 * `settled` carries the tests earlier cycles cleared. Skipping them is not just
 * a saving: nothing rewrites a passing test, so re-grading it can only produce a
 * different answer to the same question - the rubrics are model calls, not
 * predicates - and a test that flips back to failing gets deleted and rewritten
 * for no reason. That is why cycle counts used to move backwards (10 passed,
 * then 7) instead of converging.
 */
export async function runConsolidatedReview(
    outputDir: string,
    projectRoot: string,
    model: LanguageModel,
    deadline: number,
    settled: ReadonlySet<string> = new Set(),
    precomputed: readonly SingleTestReview[] = [],
): Promise<ConsolidatedReviewResult> {
    const testsDir = join(outputDir, TESTS_DIR);
    const logger = createStepLogger("review", 5);

    const scenarioData = await readDataContract(outputDir);

    const testFiles = await glob(join(testsDir, TEST_FILE_GLOB));
    const tests: { path: string; relativePath: string; content: string; flow: string }[] = [];
    for (const testPath of testFiles) {
        if (!isTestFile(testPath)) continue;
        if (testPath.includes("/_invalid/")) continue;
        const relativePath = relative(testsDir, testPath);
        if (settled.has(relativePath)) continue;
        const content = await readFile(testPath, "utf-8");
        const flowMatch = content.match(/^---\n[\s\S]*?flow:\s*["']?([^"'\n]+)["']?\s*\n[\s\S]*?---/m);
        tests.push({ path: testPath, relativePath, content, flow: flowMatch?.[1]?.trim() ?? "unknown" });
    }

    // Verdicts the pipeline already produced while generation was still running.
    // Only usable while the file is byte-identical to what was reviewed - a fix
    // pass may have rewritten it since, and then the old verdict is about a test
    // that no longer exists.
    const reusable = new Map<string, SingleTestReview>();
    for (const review of precomputed) {
        const current = tests.find((test) => test.relativePath === review.relativePath);
        if (current != null && current.content === review.content) reusable.set(review.relativePath, review);
    }

    const toReview = tests.filter((test) => !reusable.has(test.relativePath));

    // One job per (test, rubric). Scheduling the pair rather than the test keeps
    // the pool packed: the rubrics differ by more than 2x in step budget (8 to
    // 20), so a test-sized job is only as fast as its slowest rubric and leaves
    // slots idle waiting for it.
    const jobs = toReview.flatMap((test) => ALL_RUBRICS.map((rubric) => ({ test, rubric })));

    logger.log({
        stepNumber: 1,
        maxSteps: 2,
        text:
            `Reviewing ${toReview.length} tests × ${ALL_RUBRICS.length} rubrics = ${jobs.length} agents ` +
            `(${REVIEW_CONCURRENCY} concurrent)` +
            (reusable.size > 0 ? `; ${reusable.size} already reviewed during generation` : ""),
        toolCalls: [],
        toolErrors: [],
        writtenFiles: [],
    });

    let passed = 0;
    let failed = 0;
    const feedback: TestReviewFeedback[] = [];
    const passedPaths: string[] = [];

    // Partial results per test, keyed by rubric name. A test is only judged once
    // every one of its rubrics has reported.
    const byTest = new Map<string, Map<string, ReviewResult>>();
    let reviewed = 0;

    const outcome = await runPool(
        jobs,
        { limit: REVIEW_CONCURRENCY, shouldContinue: () => Date.now() <= deadline },
        (job) => runReviewPass(job.test.content, job.test.relativePath, job.rubric, projectRoot, model, scenarioData),
    );

    for (const { item, error } of outcome.failed) {
        console.warn(
            `  [review] ${item.rubric.name} error on ${basename(item.test.path)}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    // Every dispatched job counts as reported, including one that threw or came
    // back empty - `mergeRubricResults` fails those dimensions open, exactly as
    // the per-rubric catch used to. Recording only the successes instead would
    // leave the test permanently short of a full set and drop it from judgment.
    const record = (relativePath: string, rubricName: string, result: ReviewResult) => {
        const slot = byTest.get(relativePath) ?? new Map<string, ReviewResult>();
        slot.set(rubricName, result);
        byTest.set(relativePath, slot);
    };
    for (const { item, result } of outcome.completed) {
        record(item.test.relativePath, item.rubric.name, result ?? {});
    }
    for (const { item } of outcome.failed) {
        record(item.test.relativePath, item.rubric.name, {});
    }

    // Tests the deadline cut off mid-way are left unjudged rather than merged
    // from partial evidence: a half-reviewed test that fails open would be
    // recorded as settled and never looked at again.
    const skippedTests = new Set(outcome.skipped.map((job) => job.test.relativePath));
    const ranOutOfTime = outcome.skipped.length > 0;

    for (const test of tests) {
        const alreadyReviewed = reusable.get(test.relativePath);
        const reported = byTest.get(test.relativePath);
        const complete = reported != null && reported.size === ALL_RUBRICS.length;
        if (alreadyReviewed == null && (!complete || skippedTests.has(test.relativePath))) continue;

        reviewed++;
        const merged = alreadyReviewed?.dimensions ?? mergeRubricResults(reported ?? new Map());
        const failedDimensions =
            alreadyReviewed?.failedDimensions ??
            Object.entries(merged)
                .filter(([, dim]) => !dim.pass)
                .map(([key]) => key);

        if (failedDimensions.length === 0) {
            passed++;
            passedPaths.push(test.relativePath);
        } else {
            failed++;
            feedback.push({
                testPath: test.path,
                relativePath: test.relativePath,
                content: test.content,
                flow: test.flow,
                passed: false,
                dimensions: merged,
                failedDimensions,
            });
        }
    }

    if (ranOutOfTime) {
        const unreviewed = tests.length - reviewed;
        console.log(`  [review] Out of time - ${unreviewed} of ${tests.length} tests left unreviewed`);
        captureLog("warn", `Review out of time - ${unreviewed} of ${tests.length} tests left unreviewed`, {
            source: "review",
            unreviewed,
            total: tests.length,
        });
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
    return { passed, failed, feedback, ranOutOfTime, passedPaths };
}
