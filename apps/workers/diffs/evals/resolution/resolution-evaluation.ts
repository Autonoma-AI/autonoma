import { Evaluation, type RunCaseHelpers } from "@autonoma/ai/evaluation";
import { ResolutionAgent, openModelSession, summarizeSessionCost } from "@autonoma/diffs";
import { logger as rootLogger } from "@autonoma/logger";
import { expect } from "vitest";
import {
    type CodebaseCoords,
    DiffsJudge,
    type LoadedCase,
    UnfetchableShaError,
    ensureCachedCheckout,
} from "../framework";
import { type ResolutionFrontmatter, checkResolutionResult } from "./resolution-frontmatter";
import { type ResolutionCaseInput, rehydrateResolutionInput } from "./resolution-input";

/** A loaded Resolution eval case: frozen input + authored expectations. */
export type ResolutionCase = LoadedCase<ResolutionCaseInput, ResolutionFrontmatter>;

/** Per-case timeout: the agent does real codebase exploration + model calls. */
const CASE_TIMEOUT_MS = 600_000;

/**
 * Scored eval for the Diff Resolution step.
 *
 * For each case it rehydrates the codebase from the frozen coords, runs the
 * {@link ResolutionAgent} directly over the frozen input (no runner, no DB,
 * no callbacks), applies the deterministic frontmatter checks, and finally
 * runs the output-only LLM judge against the rubric. A case passes if every
 * deterministic check passes AND the judge passes. Cases whose codebase can no
 * longer be fetched are skipped, not failed.
 *
 * Runs sequentially: every case shares one on-disk working tree in the repo
 * cache, so concurrent checkouts are impossible.
 */
export class ResolutionEvaluation extends Evaluation<ResolutionCase> {
    private readonly judge = new DiffsJudge();
    private readonly logger = rootLogger.child({ name: this.constructor.name });

    constructor(resultsDir: string, cases: ResolutionCase[]) {
        super(
            {
                name: "diffs-resolution",
                parallel: false,
                testOptions: { timeout: CASE_TIMEOUT_MS },
                resultsDir,
            },
            cases,
        );
    }

    protected override caseName(testCase: ResolutionCase): string {
        const note = testCase.frontmatter.description;
        return note != null ? `${testCase.name} - ${note}` : testCase.name;
    }

    protected override testCaseInfo(testCase: ResolutionCase): Record<string, string> {
        return {
            case: testCase.name,
            repo: `${testCase.input.codebase.owner}/${testCase.input.codebase.repo}`,
            headSha: testCase.input.codebase.headSha,
            baseSha: testCase.input.codebase.baseSha,
        };
    }

    protected override async runCase(
        testCase: ResolutionCase,
        addInfo: (info: Record<string, unknown>) => void,
        helpers: RunCaseHelpers,
    ): Promise<void> {
        if (testCase.frontmatter.skip === true) {
            helpers.skip("case marked skip: true in expected.md frontmatter");
        }

        const { coords, agentInput } = rehydrateResolutionInput(testCase.input);

        const codebase = await this.rehydrateCodebase(coords, helpers, testCase.name);

        const session = openModelSession();
        const model = session.getModel({ model: "smart-visual", tag: "diffs-resolution" });
        const agent = new ResolutionAgent({ model });

        this.logger.info("Running resolution agent for eval case", { extra: { case: testCase.name } });
        const { result } = await agent.run({ ...agentInput, codebase });
        const agentCost = summarizeSessionCost(session.costCollector);

        const deterministicFailures = checkResolutionResult(result, testCase.frontmatter);

        addInfo({
            modifiedSlugs: result.modifiedTests.map((t) => t.slug),
            removedSlugs: result.removedTests.map((t) => t.slug),
            newTestCount: result.newTests.length,
            reportedBugCount: result.reportedBugs.length,
            acceptedCandidates: result.newTests
                .map((t) => t.acceptingCandidateId)
                .filter((id): id is string => id != null),
            deterministicFailures,
            agentCost,
        });

        // Deterministic checks gate the (paid) judge call: a case that already
        // fails the enum checks cannot pass, so there is nothing to judge.
        if (deterministicFailures.length > 0) {
            const summary = deterministicFailures.map((f) => `${f.check}: ${f.message}`).join("; ");
            expect.fail(`Deterministic checks failed: ${summary}`);
        }

        const verdict = await this.judge.judge({ output: result, rubric: testCase.rubric });
        addInfo({ judgePassed: verdict.passed, judgeReasoning: verdict.reasoning, judgeCost: verdict.cost });

        expect(verdict.passed, `Judge failed: ${verdict.reasoning}`).toBe(true);
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
}
