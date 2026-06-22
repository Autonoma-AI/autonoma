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
    validateProvenance(testCase);
    validateRemovalsAreCitable(testCase);
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
 * Every `provenance` key must be one of this turn's failing test cases. Unlike
 * `expectedActions` the keyset need not be exhaustive - provenance grades only
 * the test cases whose remove-vs-quarantine disposition matters - but a key for
 * a test case that did not fail this turn is an authoring mistake (the agent
 * could never act on it).
 */
function validateProvenance(testCase: HealingCase): void {
    const provenance = testCase.frontmatter.provenance;
    if (provenance == null) return;

    const failureIds = new Set(testCase.input.failures.map((f) => f.testCaseId));
    const unknown = Object.keys(provenance).filter((id) => !failureIds.has(id));
    if (unknown.length === 0) return;

    throw new Error(
        `Healing case "${testCase.name}" has provenance entries for test case(s) not in input.failures: ` +
            `[${unknown.join(", ")}]. Every provenance key must be one of this turn's failing test cases.`,
    );
}

/**
 * A test case the case expects to be removed - via `expectedActions: remove_test`
 * or `provenance: removed` - must fail through a citable failure. `remove_test`
 * is rejected at the runtime boundary unless the failure carries a source review
 * (`resolveReviewLink`), so a `removed` expectation whose failure has no
 * `reviewLink` is unrunnable: the agent cannot emit the removal and the case can
 * never pass. Catching it at load time is the in-repo enforcement of "no
 * remove_test case lacks a cited review"; the fix is to re-capture against a
 * failure that surfaced a review, or to expect a quarantine instead.
 */
function validateRemovalsAreCitable(testCase: HealingCase): void {
    const expectedRemovals = collectExpectedRemovals(testCase.frontmatter);
    if (expectedRemovals.size === 0) return;

    const reviewLinkByTestCaseId = new Map(testCase.input.failures.map((f) => [f.testCaseId, f.reviewLink]));
    const uncitable = [...expectedRemovals].filter((id) => reviewLinkByTestCaseId.get(id) == null);
    if (uncitable.length === 0) return;

    throw new Error(
        `Healing case "${testCase.name}" expects remove_test for test case(s) whose failure carries no reviewLink: ` +
            `[${uncitable.join(", ")}]. remove_test requires a cited source review, so the failing generation/run ` +
            "must surface a review the removal can cite. Re-capture against a failure that carries a review, or expect " +
            "a quarantine action instead.",
    );
}

/** The set of failing test cases the case expects to be removed, across both check channels. */
function collectExpectedRemovals(frontmatter: HealingFrontmatter): Set<string> {
    const removals = new Set<string>();

    if (frontmatter.expectedActions != null) {
        for (const [testCaseId, kind] of Object.entries(frontmatter.expectedActions)) {
            if (kind === "remove_test") removals.add(testCaseId);
        }
    }
    if (frontmatter.provenance != null) {
        for (const [testCaseId, disposition] of Object.entries(frontmatter.provenance)) {
            if (disposition === "removed") removals.add(testCaseId);
        }
    }

    return removals;
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

        addInfo({
            actionKinds,
            actionCount: result.actions.length,
            targetTestCaseIds,
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
