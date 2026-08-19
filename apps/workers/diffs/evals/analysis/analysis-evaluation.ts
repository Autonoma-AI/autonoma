import { DiffsAgent, summarizeSessionCost } from "@autonoma/diffs";
import { Evaluation, type LoadedCase, type RunCaseHelpers } from "@autonoma/evals";
import { logger as rootLogger } from "@autonoma/logger";
import { expect } from "vitest";
import { createModelSession } from "../../src/services";
import { DiffsJudge, rehydrateOrSkip } from "../framework";
import { type AnalysisFrontmatter, checkAnalysisResult } from "./analysis-frontmatter";
import { type AnalysisCaseInput, rehydrateAnalysisInput } from "./analysis-input";

/** A loaded Analysis eval case: frozen input + authored expectations. */
export type AnalysisCase = LoadedCase<AnalysisCaseInput, AnalysisFrontmatter>;

/** Per-case timeout: the agent does real codebase exploration + model calls. */
const CASE_TIMEOUT_MS = 600_000;

/**
 * Scored eval for the Diff Analysis step.
 *
 * For each case it rehydrates the codebase from the frozen coords, runs the
 * {@link DiffsAgent} directly over the frozen input (no runner, no DB), applies
 * the deterministic frontmatter checks, and finally runs the output-only LLM
 * judge against the rubric. A case passes if every deterministic check passes
 * AND the judge passes. Cases whose codebase can no longer be fetched are
 * skipped, not failed.
 *
 * Cases run concurrently: each rehydrates into its own git worktree off the
 * shared repo clone.
 */
export class AnalysisEvaluation extends Evaluation<AnalysisCase> {
    private readonly judge = new DiffsJudge();
    private readonly logger = rootLogger.child({ name: this.constructor.name });

    constructor(resultsDir: string, cases: AnalysisCase[]) {
        super(
            {
                name: "diffs-analysis",
                parallel: true,
                testOptions: { timeout: CASE_TIMEOUT_MS },
                resultsDir,
            },
            cases,
        );
    }

    protected override caseName(testCase: AnalysisCase): string {
        const note = testCase.frontmatter.description;
        return note != null ? `${testCase.name} - ${note}` : testCase.name;
    }

    protected override testCaseInfo(testCase: AnalysisCase): Record<string, string> {
        return {
            case: testCase.name,
            repo: `${testCase.input.codebase.owner}/${testCase.input.codebase.repo}`,
            headSha: testCase.input.codebase.headSha,
            baseSha: testCase.input.codebase.baseSha,
        };
    }

    protected override async runCase(
        testCase: AnalysisCase,
        addInfo: (info: Record<string, unknown>) => void,
        helpers: RunCaseHelpers,
    ): Promise<void> {
        if (testCase.frontmatter.skip === true) {
            helpers.skip("case marked skip: true in expected.md frontmatter");
        }

        const { coords, agentInput } = rehydrateAnalysisInput(testCase.input);

        const codebase = await rehydrateOrSkip(coords, helpers, { logger: this.logger, caseName: testCase.name });

        const session = createModelSession();
        const model = session.getModel({ model: "impact", tag: "analysis-impact" });
        const agent = new DiffsAgent({ model });

        this.logger.info("Running diffs agent for eval case", { extra: { case: testCase.name } });
        const { result } = await agent.run({ ...agentInput, codebase });
        const agentCost = summarizeSessionCost(session.costCollector);

        const deterministicFailures = checkAnalysisResult(result, testCase.frontmatter);

        addInfo({
            affectedTests: result.affectedTests.map((t) => t.slug),
            createdTestCount: result.createdTests.length,
            createdTestFolders: result.createdTests.map((t) => t.folderName),
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
}
