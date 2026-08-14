import type { ModelMessage } from "@autonoma/ai";
import { StorageEvidenceLoader, summarizeSessionCost } from "@autonoma/diffs";
import { ReporterAgent, type ReporterResult } from "@autonoma/diffs/analysis";
import { Evaluation, type LoadedCase, type RunCaseHelpers } from "@autonoma/evals";
import { logger as rootLogger } from "@autonoma/logger";
import { S3Storage } from "@autonoma/storage";
import { expect } from "vitest";
import { type EvidenceKeys, DiffsJudge, rehydrateOrSkip, skipIfEvidenceUnreachable } from "../framework";
import { type ReporterFrontmatter, checkReporterResult } from "./reporter-frontmatter";
import { type ReporterCaseInput, rehydrateReporterInput } from "./reporter-input";

/** A loaded Reporter eval case: frozen reporter input + authored expectations. */
export type ReporterCase = LoadedCase<ReporterCaseInput, ReporterFrontmatter>;

/**
 * Per-run timeout. A report is a tool loop over a real clone plus on-demand screenshot reads and finish-time
 * self-heal retries, and `runs: N` multiplies all of it, so the budget is per run rather than per case.
 */
const TIMEOUT_PER_RUN_MS = 900_000;

/**
 * The finish-time `FixableToolError` prefixes worth counting: the coverage-guarantee rejection and the
 * empty-after-sanitizing rejection. Both are stable strings the result tool throws, so their occurrence in the
 * returned transcript is how many times the agent had to self-correct at `finish`. Counted, never gating - a
 * rising count across the corpus means the prompt is drifting into finishes the tool has to reject.
 */
const FIXABLE_RETRY_PREFIXES = ["Cannot finish yet.", "Nothing was left of"];

/**
 * Scored eval for the analysis Reporter.
 *
 * Each case rehydrates the codebase from frozen coords, checks every screenshot key it references is still
 * downloadable, rebuilds the frozen input, and runs {@link ReporterAgent} directly - no workflow, no DB, no writes.
 * The reconciliation the run produces is graded by the deterministic checks; the report prose is graded by the
 * output-only LLM judge.
 *
 * Every tool the Reporter uses in production is served identically in replay: `bash` over the real clone,
 * `fetch_evidence` from S3 by the frozen keys, and `read_scenario` as a pure lookup over the frozen recipes. The
 * Reporter has no live-infra tool (no preview backend, no log stream), so - unlike the classifier - there is no
 * production-only capability to record, and a replay grades an agent that saw exactly what production's did.
 *
 * A case passes when every run satisfies the deterministic checks AND the judge passes. Cases whose codebase or
 * media can no longer be fetched are skipped, not failed.
 *
 * Runs sequentially: every case shares one on-disk working tree in the repo cache.
 */
export class ReporterEvaluation extends Evaluation<ReporterCase> {
    private readonly judge = new DiffsJudge();
    private readonly logger = rootLogger.child({ name: this.constructor.name });

    constructor(resultsDir: string, cases: ReporterCase[]) {
        const slowestCase = cases.reduce((most, testCase) => Math.max(most, testCase.frontmatter.runs), 1);
        super(
            {
                name: "diffs-reporter",
                parallel: false,
                testOptions: { timeout: slowestCase * TIMEOUT_PER_RUN_MS },
                resultsDir,
            },
            cases,
        );
    }

    protected override caseName(testCase: ReporterCase): string {
        const note = testCase.frontmatter.description;
        return note != null ? `${testCase.name} - ${note}` : testCase.name;
    }

    protected override testCaseInfo(testCase: ReporterCase): Record<string, string> {
        return {
            case: testCase.name,
            repo: `${testCase.input.codebase.owner}/${testCase.input.codebase.repo}`,
            headSha: testCase.input.codebase.headSha,
            baseSha: testCase.input.codebase.baseSha,
            runKind: testCase.input.target.kind,
            findings: String(testCase.input.findings.length),
            branchTests: String(testCase.input.branchTests.length),
            existingIssues: String(testCase.input.existingIssues.length),
        };
    }

    protected override async runCase(
        testCase: ReporterCase,
        addInfo: (info: Record<string, unknown>) => void,
        helpers: RunCaseHelpers,
    ): Promise<void> {
        if (testCase.frontmatter.skip === true) {
            helpers.skip("case marked skip: true in expected.md frontmatter");
        }

        const storage = S3Storage.createFromEnv();
        const evidenceLoader = new StorageEvidenceLoader(storage);
        const skipContext = { logger: this.logger, caseName: testCase.name };

        // The clone and the S3 probe are independent - the probe reads only the frozen case, not the checkout - so
        // overlap the git-clone latency with the HEAD probes rather than paying them back to back.
        const [codebase] = await Promise.all([
            rehydrateOrSkip(testCase.input.codebase, helpers, skipContext),
            skipIfEvidenceUnreachable(collectScreenshotKeys(testCase.input), evidenceLoader, helpers, skipContext),
        ]);

        const input = rehydrateReporterInput(testCase.input, codebase, storage);

        // Imported here rather than at module scope: `services` pulls the worker's env, which demands the OpenAI
        // credential at import time and would break the credential-free zero-case no-op.
        const { createModelSession } = await import("../../src/services");

        const results: ReporterResult[] = [];
        const failuresByRun: string[] = [];
        const costs: ReturnType<typeof summarizeSessionCost>[] = [];
        const fixableRetries: number[] = [];

        for (let run = 1; run <= testCase.frontmatter.runs; run++) {
            const session = createModelSession();
            const agent = new ReporterAgent({ model: session.getModel({ model: "reporter", tag: "reporter-eval" }) });

            this.logger.info("Reporting eval case", {
                extra: { case: testCase.name, run, runs: testCase.frontmatter.runs },
            });

            const { result, conversation } = await this.report(agent, input);
            results.push(result);
            costs.push(summarizeSessionCost(session.costCollector));
            fixableRetries.push(countFixableRetries(conversation));

            const failures = checkReporterResult(result, testCase.frontmatter);
            if (failures.length > 0) {
                failuresByRun.push(`run ${run}: ${failures.map((f) => `${f.check}: ${f.message}`).join("; ")}`);
            }
        }

        // The full output of every run, not just a pass flag: diffing two result files is how a change is shown to
        // have moved the Reporter. The swept/duplicate/unknown counts and the finish-time retry count are the
        // quality signals the deterministic checks deliberately do not gate on (bar `unknownSlugs`, which does).
        addInfo({
            titles: results.map((r) => r.title),
            headlines: results.map((r) => r.headline),
            issueReconciliations: results.map(describeIssues),
            flowCounts: results.map((r) => r.flows.length),
            sweptSlugCounts: results.map((r) => r.flowCorrections.sweptSlugs.length),
            duplicateSlugCounts: results.map((r) => r.flowCorrections.duplicateSlugs.length),
            unknownSlugCounts: results.map((r) => r.flowCorrections.unknownSlugs.length),
            fixableRetries,
            deterministicFailures: failuresByRun,
            agentCosts: costs,
        });

        // Deterministic checks gate the (paid) judge call: a case that already fails a dedup or membership check
        // cannot pass, so there is nothing to judge.
        if (failuresByRun.length > 0) {
            expect.fail(`Deterministic checks failed: ${failuresByRun.join(" | ")}`);
        }

        // One judge call, on the first result. The rubric grades prose quality, which the deterministic checks
        // have already confirmed is consistent across every run of this case.
        const [judged] = results;
        if (judged == null) expect.fail("No result was produced");

        const judgeVerdict = await this.judge.judge({ output: judged, rubric: testCase.rubric });
        addInfo({
            judgePassed: judgeVerdict.passed,
            judgeReasoning: judgeVerdict.reasoning,
            judgeCost: judgeVerdict.cost,
        });

        expect(judgeVerdict.passed, `Judge failed: ${judgeVerdict.reasoning}`).toBe(true);
    }

    /**
     * Run one report. A Reporter that exhausts its steps or loses a tool fatally throws instead of returning a
     * result - in production the workflow fails the run over it, but for an eval it is simply a case that produced
     * nothing to grade.
     */
    private async report(
        agent: ReporterAgent,
        input: Parameters<ReporterAgent["run"]>[0],
    ): Promise<Awaited<ReturnType<ReporterAgent["run"]>>> {
        try {
            return await agent.run(input);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn("Reporter produced no result", { extra: { err: message } });
            expect.fail(`Reporter did not commit to a report: ${message}`);
        }
    }
}

/**
 * The distinct screenshot keys a case's findings reference, for the pre-flight reachability probe. A dead key would
 * otherwise surface mid-run as a `fetch_evidence` error the Reporter would reason about as if it were evidence
 * about the app.
 */
function collectScreenshotKeys(input: ReporterCaseInput): EvidenceKeys {
    const screenshots = new Set<string>();
    for (const finding of input.findings) {
        for (const asset of finding.screenshots) screenshots.add(asset.s3Key);
    }
    return { screenshots: [...screenshots] };
}

/** A compact, per-run account of how the run reconciled its findings, for the result file's diff. */
function describeIssues(result: ReporterResult): { opened: string[]; carried: string[]; resolved: string[] } {
    const opened: string[] = [];
    const carried: string[] = [];
    const resolved: string[] = [];
    for (const issue of result.issues) {
        if (issue.kind === "open") opened.push(issue.content.title);
        else if (issue.kind === "carry_forward") carried.push(issue.existingIssueId);
        else resolved.push(issue.existingIssueId);
    }
    return { opened, carried, resolved };
}

/**
 * How many times the run's finish was rejected and re-attempted, read off the returned transcript by the stable
 * prefixes the result tool throws (see {@link FIXABLE_RETRY_PREFIXES}). Grep the whole serialized conversation
 * rather than walk the message tree: the prefixes are unique enough that a substring count is exact, and it does
 * not couple this metric to the transcript's message shape.
 */
function countFixableRetries(conversation: ModelMessage[]): number {
    const transcript = JSON.stringify(conversation);
    return FIXABLE_RETRY_PREFIXES.reduce((total, prefix) => total + countOccurrences(transcript, prefix), 0);
}

function countOccurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
}
