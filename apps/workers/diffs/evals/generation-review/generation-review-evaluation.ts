import {
    type EvidenceLoader,
    type GenerationContext,
    GenerationReviewer,
    openModelSession,
    StorageEvidenceLoader,
    summarizeSessionCost,
} from "@autonoma/diffs";
import { Evaluation, type LoadedCase, type RunCaseHelpers } from "@autonoma/evals";
import { logger as rootLogger } from "@autonoma/logger";
import { S3Storage } from "@autonoma/storage";
import type { GenerationVerdict } from "@autonoma/types";
import { expect } from "vitest";
import {
    type CodebaseCoords,
    DiffsJudge,
    MissingEvidenceError,
    UnfetchableShaError,
    ensureCachedCheckout,
    probeEvidence,
} from "../framework";
import { type GenerationReviewFrontmatter, checkGenerationReviewResult } from "./generation-review-frontmatter";
import { type GenerationReviewCaseInput, rehydrateGenerationReviewInput } from "./generation-review-input";

/** A loaded generation review eval case: frozen context + authored expectations. */
export type GenerationReviewCase = LoadedCase<GenerationReviewCaseInput, GenerationReviewFrontmatter>;

/** Per-case timeout: the reviewer does video upload + real model calls + tool loops. */
const CASE_TIMEOUT_MS = 600_000;

/**
 * Scored eval for the generation review step.
 *
 * For each case it rehydrates the codebase from the frozen coords, probes that
 * every referenced S3 key is still downloadable, runs the {@link GenerationReviewer}
 * directly over the frozen context (no runner, no DB), applies the deterministic
 * frontmatter checks, and finally runs the output-only LLM judge against the
 * rubric. A case passes if every deterministic check passes AND the judge
 * passes. Cases whose codebase or media can no longer be fetched are skipped,
 * not failed.
 *
 * Runs sequentially: every case shares one on-disk working tree in the repo
 * cache, and reviewers grow more codebase-access tools over time, so concurrent
 * checkouts are impossible.
 */
export class GenerationReviewEvaluation extends Evaluation<GenerationReviewCase> {
    private readonly judge = new DiffsJudge();
    private readonly logger = rootLogger.child({ name: this.constructor.name });

    constructor(resultsDir: string, cases: GenerationReviewCase[]) {
        super(
            {
                name: "diffs-generation-review",
                parallel: false,
                testOptions: { timeout: CASE_TIMEOUT_MS },
                resultsDir,
            },
            cases,
        );
    }

    protected override caseName(testCase: GenerationReviewCase): string {
        const note = testCase.frontmatter.description;
        return note != null ? `${testCase.name} - ${note}` : testCase.name;
    }

    protected override testCaseInfo(testCase: GenerationReviewCase): Record<string, string> {
        return {
            case: testCase.name,
            repo: `${testCase.input.codebase.owner}/${testCase.input.codebase.repo}`,
            headSha: testCase.input.codebase.headSha,
            baseSha: testCase.input.codebase.baseSha,
            generationId: testCase.input.context.generationId,
        };
    }

    protected override async runCase(
        testCase: GenerationReviewCase,
        addInfo: (info: Record<string, unknown>) => void,
        helpers: RunCaseHelpers,
    ): Promise<void> {
        if (testCase.frontmatter.skip === true) {
            helpers.skip("case marked skip: true in expected.md frontmatter");
        }

        const { coords, context } = rehydrateGenerationReviewInput(testCase.input);

        const codebase = await this.rehydrateCodebase(coords, helpers, testCase.name);

        const evidenceLoader = new StorageEvidenceLoader(S3Storage.createFromEnv());
        await this.probeReferencedEvidence(context, evidenceLoader, helpers, testCase.name);

        const session = openModelSession();
        const videoModel = session.getVideoModel({ model: "smart-visual", tag: "generation-review" });

        const reviewer = new GenerationReviewer({ videoModel, evidenceLoader });

        this.logger.info("Running generation reviewer for eval case", { extra: { case: testCase.name } });
        let verdict: GenerationVerdict;
        try {
            const outcome = await reviewer.run({ context, codebase });
            verdict = outcome.result;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn("Reviewer produced no verdict", { extra: { case: testCase.name, err: message } });
            expect.fail(`Reviewer did not submit a verdict: ${message}`);
        }
        const agentCost = summarizeSessionCost(session.costCollector);

        const deterministicFailures = checkGenerationReviewResult(verdict, testCase.frontmatter);

        addInfo({ verdict: verdict.verdict, deterministicFailures, agentCost });

        // Deterministic checks gate the (paid) judge call: a case that already
        // fails enum-equality cannot pass, so there is nothing to judge.
        if (deterministicFailures.length > 0) {
            const summary = deterministicFailures.map((f) => `${f.check}: ${f.message}`).join("; ");
            expect.fail(`Deterministic checks failed: ${summary}`);
        }

        const judgeVerdict = await this.judge.judge({ output: verdict, rubric: testCase.rubric });
        addInfo({
            judgePassed: judgeVerdict.passed,
            judgeReasoning: judgeVerdict.reasoning,
            judgeCost: judgeVerdict.cost,
        });

        expect(judgeVerdict.passed, `Judge failed: ${judgeVerdict.reasoning}`).toBe(true);
    }

    private async rehydrateCodebase(coords: CodebaseCoords, helpers: RunCaseHelpers, caseName: string) {
        try {
            return await ensureCachedCheckout(coords);
        } catch (err) {
            if (err instanceof UnfetchableShaError) {
                this.logger.warn("Skipping case: codebase no longer fetchable", {
                    extra: { case: caseName, sha: err.sha, repo: err.repoFullName },
                });
                helpers.skip(`codebase unfetchable: ${err.message}`);
            }
            throw err;
        }
    }

    private async probeReferencedEvidence(
        context: GenerationContext,
        loader: EvidenceLoader,
        helpers: RunCaseHelpers,
        caseName: string,
    ): Promise<void> {
        const screenshots: string[] = [];
        for (const step of context.steps) {
            if (step.screenshotBeforeKey != null) screenshots.push(step.screenshotBeforeKey);
            if (step.screenshotAfterKey != null) screenshots.push(step.screenshotAfterKey);
        }

        const keys: Parameters<typeof probeEvidence>[0] = {
            screenshots,
            finalScreenshot: context.finalScreenshotKey,
            video: context.videoUrl,
        };

        try {
            await probeEvidence(keys, loader);
        } catch (err) {
            if (err instanceof MissingEvidenceError) {
                this.logger.warn("Skipping case: evidence no longer reachable", {
                    extra: { case: caseName, key: err.key, kind: err.kind },
                });
                helpers.skip(`evidence unreachable: ${err.message}`);
            }
            throw err;
        }
    }
}
