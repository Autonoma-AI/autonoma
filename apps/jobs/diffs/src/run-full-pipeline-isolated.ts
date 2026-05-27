/**
 * Isolated Full Diff Pipeline Runner
 *
 * Runs the entire diff analysis workflow locally without DB, Temporal, S3,
 * or the GitHub App. Takes a git repository, test files, and commit SHAs as
 * input, executes the full pipeline, and produces structured results on disk.
 *
 * Pipeline steps:
 *   1. DiffsAgent - analyze code changes, identify affected tests
 *   2. Replay affected tests - re-execute recorded steps via Playwright locally
 *   3. Review failed runs - AI review of replay failures
 *   4. ResolutionAgent - resolve failures, suggest modifications
 *   5. Run generations - execute new/modified tests (agentic)
 *   6. Review failed generations - AI review of generation failures
 *   7. Summarize - collect everything into pipeline-result.json
 *
 * Usage:
 *   tsx src/run-full-pipeline-isolated.ts \
 *     --repo <url-or-local-path> \
 *     --url <application-url-to-test-against> \
 *     [--tests-dir <path>]       dir with qa-tests/ (defaults to fixtures/)
 *     [--branch <name>]          resolves base/head from branch
 *     [--base <ref>]             explicit base commit
 *     [--head <ref>]             explicit head commit
 *     [--output <path>]          output directory (default: ./pipeline-output)
 *     [--headless]               run browser headless (default: true)
 *     [--skip-generations]       skip steps 5-6
 *
 * Environment variables:
 *   GEMINI_API_KEY       required (real key)
 *   GROQ_KEY             required by @autonoma/ai schema (any non-empty value)
 *   OPENROUTER_API_KEY   required by @autonoma/ai schema (any non-empty value)
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CostCollector, MODEL_ENTRIES, ModelRegistry } from "@autonoma/ai";
import type { DiffsAgentResult, RunReviewVerdict } from "@autonoma/diffs";
import { runDiffsAgentLocally } from "@autonoma/diffs/run-diffs-locally";
import { runResolutionAgentLocally } from "@autonoma/diffs/run-resolution-locally";
import { logger as rootLogger } from "@autonoma/logger";
import { type BaseCliArgs, parseBaseCliArgs, prepareRepo, readTestFiles, resolveCommits } from "./isolated-utils";
import { mapVerdictToResolutionInput } from "./map-verdict-to-resolution-input";
import { type LocalReplayResult, runReplayLocally } from "./run-replay-locally";
import { runReviewLocally } from "./run-review-locally";
import { runTestLocally } from "./run-test-locally";

// ---- CLI -------------------------------------------------------------------

interface PipelineCliArgs extends BaseCliArgs {
    url: string;
    output: string;
    headless: boolean;
    skipGenerations: boolean;
}

function parseCliArgs(): PipelineCliArgs {
    const { base, extra } = parseBaseCliArgs({
        url: { type: "string" },
        output: { type: "string" },
        headless: { type: "boolean" },
        "skip-generations": { type: "boolean" },
    });

    if (extra.url == null) {
        throw new Error("--url is required");
    }

    return {
        ...base,
        url: extra.url as string,
        output: (extra.output as string | undefined) ?? "./pipeline-output",
        headless: (extra.headless as boolean | undefined) ?? true,
        skipGenerations: (extra["skip-generations"] as boolean | undefined) ?? false,
    };
}

// ---- Helpers ---------------------------------------------------------------

async function writeJSON(filePath: string, data: unknown): Promise<void> {
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function slugify(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}

// ---- Pipeline --------------------------------------------------------------

async function runFullPipeline(args: PipelineCliArgs): Promise<void> {
    const logger = rootLogger.child({ name: "run-full-pipeline-isolated" });

    logger.info("Starting full isolated pipeline", {
        repo: args.repo,
        url: args.url,
        testsDir: args.testsDir,
        branch: args.branch,
        output: args.output,
        headless: args.headless,
        skipGenerations: args.skipGenerations,
    });

    const outputDir = args.output;
    await mkdir(outputDir, { recursive: true });

    const { repoDir, tempDir } = await prepareRepo(args);

    try {
        const { baseSha, headSha } = await resolveCommits(repoDir, args);

        const existingTests = await readTestFiles(args.testsDir);

        // Model registry shared across all steps
        const registry = new ModelRegistry({
            models: { flash: MODEL_ENTRIES.GEMINI_3_FLASH_PREVIEW },
        });
        const model = registry.getModel({ model: "flash", tag: "pipeline-isolated" });
        const costCollector = new CostCollector();

        // ---- Step 1: Analyze diffs ----
        logger.info("Step 1: Analyzing diffs");
        const startStep1 = Date.now();
        const step1Result: DiffsAgentResult = await runDiffsAgentLocally({
            model,
            repoDir,
            baseSha,
            headSha,
            existingTests,
        });
        logger.info("Step 1 complete", {
            elapsed: `${((Date.now() - startStep1) / 1000).toFixed(1)}s`,
            affectedTests: step1Result.affectedTests.length,
            testCandidates: step1Result.testCandidates.length,
        });
        await writeJSON(join(outputDir, "step1-analysis/result.json"), step1Result);

        // ---- Step 2: Replay affected tests ----
        logger.info("Step 2: Replaying affected tests", { count: step1Result.affectedTests.length });
        const replayResults = new Map<string, LocalReplayResult>();

        for (const affected of step1Result.affectedTests) {
            const test = existingTests.find((t) => t.slug === affected.slug);
            if (test == null) {
                logger.warn("Affected test not found in existing tests, skipping", { slug: affected.slug });
                continue;
            }

            if (test.steps == null) {
                logger.warn("Affected test has no recorded steps, skipping replay", { slug: affected.slug });
                continue;
            }

            logger.info("Replaying test", { slug: affected.slug, stepCount: test.steps.length });
            const result = await runReplayLocally({
                steps: test.steps,
                url: args.url,
                testSlug: affected.slug,
                outputDir: join(outputDir, "step2-replays"),
                headless: args.headless,
                costCollector,
            });
            replayResults.set(affected.slug, result);
            logger.info("Replay finished", { slug: affected.slug, success: result.success });
        }

        const failedCount = [...replayResults.values()].filter((r) => !r.success).length;
        logger.info("Step 2 complete", { testsReplayed: replayResults.size, failed: failedCount });

        // ---- Step 3: Review failed replays ----
        logger.info("Step 3: Reviewing failed replays");
        const verdicts: RunReviewVerdict[] = [];

        for (const [slug, replayResult] of replayResults) {
            if (replayResult.success) continue;

            const test = existingTests.find((t) => t.slug === slug);
            if (test == null) continue;

            logger.info("Reviewing failed replay", { slug });
            const reviewResult = await runReviewLocally(model, {
                testSlug: slug,
                testInstruction: test.prompt,
                testName: test.name,
                artifactDir: replayResult.artifactDir,
                steps: replayResult.steps,
            });

            if (reviewResult.verdict != null) {
                const affected = step1Result.affectedTests.find((a) => a.slug === slug);
                verdicts.push(
                    mapVerdictToResolutionInput(
                        {
                            testSlug: slug,
                            testName: test.name,
                            originalPrompt: test.prompt,
                            affectedReason: affected?.affectedReason,
                        },
                        reviewResult.verdict,
                    ),
                );
                await writeJSON(join(outputDir, `step3-reviews/${slug}-verdict.json`), reviewResult.verdict);
            }
            logger.info("Review complete", { slug, verdict: reviewResult.verdict?.verdict });
        }

        logger.info("Step 3 complete", { reviewsRun: verdicts.length });

        // ---- Step 4: Resolve ----
        logger.info("Step 4: Running resolution agent");
        const step4Result = await runResolutionAgentLocally({
            model,
            repoDir,
            existingTests,
            verdicts,
            step1Reasoning: step1Result.reasoning,
            testCandidates: step1Result.testCandidates,
        });
        await writeJSON(join(outputDir, "step4-resolution/result.json"), step4Result);

        logger.info("Step 4 complete", {
            modifiedTests: step4Result.modifiedTests.length,
            removedTests: step4Result.removedTests.length,
            reportedBugs: step4Result.reportedBugs.length,
            newTests: step4Result.newTests.length,
        });

        // ---- Steps 5-6: Generate + review new/modified tests ----
        if (!args.skipGenerations) {
            const allTestsToGenerate = [
                ...step4Result.modifiedTests.map((t) => ({
                    slug: t.slug,
                    name: t.slug,
                    instruction: t.newInstruction,
                })),
                ...step4Result.newTests.map((t) => ({
                    slug: slugify(t.name),
                    name: t.name,
                    instruction: t.instruction,
                })),
            ];

            if (allTestsToGenerate.length > 0) {
                logger.info("Step 5: Running generations", { count: allTestsToGenerate.length });

                for (const test of allTestsToGenerate) {
                    logger.info("Generating test", { slug: test.slug });
                    const genResult = await runTestLocally({
                        instruction: test.instruction,
                        url: args.url,
                        testSlug: test.slug,
                        outputDir: join(outputDir, "step5-generations"),
                        headless: args.headless,
                        costCollector,
                    });

                    logger.info("Generation finished", { slug: test.slug, success: genResult.success });

                    if (!genResult.success) {
                        logger.info("Step 6: Reviewing failed generation", { slug: test.slug });
                        const genReview = await runReviewLocally(model, {
                            testSlug: test.slug,
                            testInstruction: test.instruction,
                            testName: test.name,
                            artifactDir: genResult.artifactDir,
                            steps: genResult.steps,
                        });
                        if (genReview.verdict != null) {
                            await writeJSON(
                                join(outputDir, `step6-generation-reviews/${test.slug}-verdict.json`),
                                genReview.verdict,
                            );
                        }
                        logger.info("Generation review complete", {
                            slug: test.slug,
                            verdict: genReview.verdict?.verdict,
                        });
                    }
                }
            } else {
                logger.info("Steps 5-6: No tests to generate, skipping");
            }
        } else {
            logger.info("Steps 5-6: Skipped (--skip-generations)");
        }

        // ---- Step 7: Summary ----
        const summary = {
            pipeline: "full-diff-pipeline-isolated",
            timestamp: new Date().toISOString(),
            args: {
                repo: args.repo,
                url: args.url,
                branch: args.branch,
                baseSha,
                headSha,
            },
            step1: {
                affectedTests: step1Result.affectedTests.length,
                testCandidates: step1Result.testCandidates.length,
            },
            step2: {
                testsReplayed: replayResults.size,
                passed: replayResults.size - failedCount,
                failed: failedCount,
            },
            step3: {
                reviewsRun: verdicts.length,
            },
            step4: {
                modifiedTests: step4Result.modifiedTests.length,
                removedTests: step4Result.removedTests.length,
                reportedBugs: step4Result.reportedBugs.length,
                newTests: step4Result.newTests.length,
            },
            modelUsage: registry.modelUsage,
        };
        await writeJSON(join(outputDir, "pipeline-result.json"), summary);

        logger.info("Pipeline complete", summary);
    } finally {
        if (tempDir != null) {
            await rm(tempDir, { recursive: true, force: true });
        }
    }
}

// ---- Entry point -----------------------------------------------------------

await runFullPipeline(parseCliArgs());
