import { HealingAgent, openModelSession, summarizeSessionCost } from "@autonoma/diffs";
import { Evaluation, type LoadedCase, type RunCaseHelpers } from "@autonoma/evals";
import { logger as rootLogger } from "@autonoma/logger";
import { expect } from "vitest";
import { type CodebaseCoords, DiffsJudge, UnfetchableShaError, ensureCachedCheckout } from "../framework";
import { type HealingFrontmatter, checkHealingResult } from "./healing-frontmatter";
import { type HealingCaseInput, rehydrateHealingInput } from "./healing-input";

/** A loaded Healing eval case: frozen input + authored expectations. */
export type HealingCase = LoadedCase<HealingCaseInput, HealingFrontmatter>;

/** Per-case timeout: the agent does real codebase exploration + multi-tool model calls. */
const CASE_TIMEOUT_MS = 900_000;

/**
 * Author-time cross-checks for a Healing case. Cases marked `skip: true` are not
 * validated - the author is signaling the case is not yet authored.
 */
export function validateHealingCase(testCase: HealingCase): void {
    if (testCase.frontmatter.skip === true) return;
    validateExpectedActions(testCase);
    validateCandidateChecks(testCase);
}

/**
 * The `expectedActions` keyset must equal the set of `failures[].testCaseId` in
 * `input.json`. Healing's runtime invariant is that every input failure is
 * handled by exactly one action, so a partial map is almost certainly an
 * authoring mistake (and would let the agent silently get away with skipping or
 * hallucinating a test case). A case without `expectedActions` is not validated.
 */
function validateExpectedActions(testCase: HealingCase): void {
    const expected = testCase.frontmatter.expectedActions;
    if (expected == null) return;

    const expectedIds = new Set(Object.keys(expected));
    const failureIds = new Set(testCase.input.failures.map((f) => f.testCaseId));

    const missing = [...failureIds].filter((id) => !expectedIds.has(id));
    const extra = [...expectedIds].filter((id) => !failureIds.has(id));

    if (missing.length === 0 && extra.length === 0) return;

    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing testCaseIds: [${missing.join(", ")}]`);
    if (extra.length > 0) parts.push(`unknown testCaseIds (not in input.failures): [${extra.join(", ")}]`);
    throw new Error(
        `Healing case "${testCase.name}" has a malformed expectedActions: ${parts.join("; ")}. ` +
            "The keyset must equal the set of failing test cases in input.json.",
    );
}

/**
 * Every id named in `acceptsCandidate` / `rejectsCandidate` must reference a
 * candidate actually present in `input.candidates`. A check against a candidate
 * the agent never saw can never pass, so it is an authoring mistake worth
 * surfacing at load time rather than as a confusing run-time failure.
 */
function validateCandidateChecks(testCase: HealingCase): void {
    const referenced = [
        ...(testCase.frontmatter.acceptsCandidate ?? []),
        ...(testCase.frontmatter.rejectsCandidate ?? []),
    ];
    if (referenced.length === 0) return;

    const knownIds = new Set(testCase.input.candidates.map((c) => c.candidateId));
    const unknown = referenced.filter((id) => !knownIds.has(id));
    if (unknown.length === 0) return;

    throw new Error(
        `Healing case "${testCase.name}" references unknown candidate id(s) [${unknown.join(", ")}] in ` +
            "acceptsCandidate / rejectsCandidate. Every id must appear in input.candidates.",
    );
}

/**
 * Scored eval for the Diff Healing step.
 *
 * For each case it rehydrates the codebase from the frozen coords, runs the
 * {@link HealingAgent} directly over the frozen input (no runner, no DB),
 * applies the deterministic frontmatter checks, and finally runs the
 * output-only LLM judge against the rubric. A case passes if every
 * deterministic check passes AND the judge passes. Cases whose codebase can no
 * longer be fetched are skipped, not failed.
 *
 * Runs sequentially: every case shares one on-disk working tree in the repo
 * cache, so concurrent checkouts are impossible.
 */
export class HealingEvaluation extends Evaluation<HealingCase> {
    private readonly judge = new DiffsJudge();
    private readonly logger = rootLogger.child({ name: this.constructor.name });

    constructor(resultsDir: string, cases: HealingCase[]) {
        super(
            {
                name: "diffs-healing",
                parallel: false,
                testOptions: { timeout: CASE_TIMEOUT_MS },
                resultsDir,
            },
            cases,
        );
    }

    protected override caseName(testCase: HealingCase): string {
        const note = testCase.frontmatter.description;
        return note != null ? `${testCase.name} - ${note}` : testCase.name;
    }

    protected override testCaseInfo(testCase: HealingCase): Record<string, string> {
        return {
            case: testCase.name,
            repo: `${testCase.input.codebase.owner}/${testCase.input.codebase.repo}`,
            headSha: testCase.input.codebase.headSha,
            baseSha: testCase.input.codebase.baseSha,
            iteration: String(testCase.input.iteration),
            failures: String(testCase.input.failures.length),
            candidates: String(testCase.input.candidates.length),
        };
    }

    protected override async runCase(
        testCase: HealingCase,
        addInfo: (info: Record<string, unknown>) => void,
        helpers: RunCaseHelpers,
    ): Promise<void> {
        if (testCase.frontmatter.skip === true) {
            helpers.skip("case marked skip: true in expected.md frontmatter");
        }

        const { coords, agentInput } = rehydrateHealingInput(testCase.input);

        const codebase = await this.rehydrateCodebase(coords, helpers, testCase.name);

        const session = openModelSession();
        const model = session.getModel({ model: "smart-visual", tag: "healing-refinement" });
        const agent = new HealingAgent({ model });

        this.logger.info("Running healing agent for eval case", { extra: { case: testCase.name } });
        const { result } = await agent.run({ ...agentInput, codebase });
        const agentCost = summarizeSessionCost(session.costCollector);

        const deterministicFailures = checkHealingResult(result, testCase.frontmatter);

        const actionKinds = result.actions.map((a) => a.kind);
        const targetTestCaseIds = [...new Set(result.actions.map((a) => a.testCaseId))];
        const acceptedCandidates = result.newTests
            .map((t) => t.acceptingCandidateId)
            .filter((id): id is string => id != null);
        const rejectedCandidates = result.rejectedCandidates.map((c) => c.candidateId);

        addInfo({
            actionKinds,
            actionCount: result.actions.length,
            targetTestCaseIds,
            newTestCount: result.newTests.length,
            acceptedCandidates,
            rejectedCandidates,
            deterministicFailures,
            agentCost,
        });

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
