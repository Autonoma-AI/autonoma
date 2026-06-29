import {
    type EvidenceLoader,
    openModelSession,
    ReplayReviewer,
    type RunContext,
    StorageEvidenceLoader,
    summarizeSessionCost,
} from "@autonoma/diffs";
import { Evaluation, type LoadedCase, type RunCaseHelpers } from "@autonoma/evals";
import { logger as rootLogger } from "@autonoma/logger";
import { S3Storage } from "@autonoma/storage";
import type { ReplayVerdict } from "@autonoma/types";
import { expect } from "vitest";
import {
    type CodebaseCoords,
    DiffsJudge,
    MissingEvidenceError,
    UnfetchableShaError,
    ensureCachedCheckout,
    probeEvidence,
} from "../framework";
import { type ReplayReviewFrontmatter, checkReplayReviewResult } from "./replay-review-frontmatter";
import { type ReplayReviewCaseInput, rehydrateReplayReviewInput } from "./replay-review-input";

/** A loaded replay review eval case: frozen context + authored expectations. */
export type ReplayReviewCase = LoadedCase<ReplayReviewCaseInput, ReplayReviewFrontmatter>;

/** Per-case timeout: the reviewer does video upload + real model calls + tool loops. */
const CASE_TIMEOUT_MS = 600_000;

/**
 * Scored eval for the replay review step. Mirrors {@link
 * import("../generation-review/generation-review-evaluation").GenerationReviewEvaluation}:
 * rehydrates the codebase, probes evidence keys, runs the {@link ReplayReviewer},
 * applies deterministic checks, then runs the LLM judge. Cases whose codebase
 * or media can no longer be fetched are skipped, not failed; a reviewer that
 * fails to submit a verdict is a hard failure.
 *
 * Runs sequentially (shared repo cache + growing codebase tool surface).
 */
export class ReplayReviewEvaluation extends Evaluation<ReplayReviewCase> {
    private readonly judge = new DiffsJudge();
    private readonly logger = rootLogger.child({ name: this.constructor.name });

    constructor(resultsDir: string, cases: ReplayReviewCase[]) {
        super(
            {
                name: "diffs-replay-review",
                parallel: false,
                testOptions: { timeout: CASE_TIMEOUT_MS },
                resultsDir,
            },
            cases,
        );
    }

    protected override caseName(testCase: ReplayReviewCase): string {
        const note = testCase.frontmatter.description;
        return note != null ? `${testCase.name} - ${note}` : testCase.name;
    }

    protected override testCaseInfo(testCase: ReplayReviewCase): Record<string, string> {
        return {
            case: testCase.name,
            repo: `${testCase.input.codebase.owner}/${testCase.input.codebase.repo}`,
            headSha: testCase.input.codebase.headSha,
            baseSha: testCase.input.codebase.baseSha,
            runId: testCase.input.context.runId,
        };
    }

    protected override async runCase(
        testCase: ReplayReviewCase,
        addInfo: (info: Record<string, unknown>) => void,
        helpers: RunCaseHelpers,
    ): Promise<void> {
        if (testCase.frontmatter.skip === true) {
            helpers.skip("case marked skip: true in expected.md frontmatter");
        }

        const { coords, context } = rehydrateReplayReviewInput(testCase.input);

        const codebase = await this.rehydrateCodebase(coords, helpers, testCase.name);

        const evidenceLoader = new StorageEvidenceLoader(S3Storage.createFromEnv());
        await this.probeReferencedEvidence(context, evidenceLoader, helpers, testCase.name);

        const session = openModelSession();
        const videoModel = session.getVideoModel({ model: "smart-visual", tag: "replay-review" });

        const reviewer = new ReplayReviewer({ videoModel, evidenceLoader });

        this.logger.info("Running replay reviewer for eval case", { extra: { case: testCase.name } });
        let verdict: ReplayVerdict;
        try {
            const outcome = await reviewer.run({ context, codebase });
            verdict = outcome.result;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn("Reviewer produced no verdict", { extra: { case: testCase.name, err: message } });
            expect.fail(`Reviewer did not submit a verdict: ${message}`);
        }
        const agentCost = summarizeSessionCost(session.costCollector);

        const deterministicFailures = checkReplayReviewResult(verdict, testCase.frontmatter);

        addInfo({ verdict: verdict.verdict, deterministicFailures, agentCost });

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
        context: RunContext,
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
            video: context.videoS3Key,
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
