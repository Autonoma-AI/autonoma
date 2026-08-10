import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnalysisVerdict } from "@autonoma/types";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReporterAgent } from "../../../src/analysis/report/reporter-agent";
import type {
    ReporterEvidenceAsset,
    ReporterExistingIssue,
    ReporterFinding,
    ReporterInput,
    ReporterIssueResult,
} from "../../../src/analysis/report/types";
import { Codebase } from "../../../src/codebase";

const FAKE_USAGE = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
} as const;

interface ScriptedCall {
    toolName: string;
    input: Record<string, unknown>;
}

/** A model that emits a fixed sequence of tool calls, one per step - drives the real loop deterministically. */
function scriptedModel(calls: ScriptedCall[]): MockLanguageModelV4 {
    let step = 0;
    return new MockLanguageModelV4({
        doGenerate: async () => {
            const call = calls[Math.min(step, calls.length - 1)];
            step += 1;
            return {
                content: [
                    {
                        type: "tool-call",
                        toolCallId: `call-${step}`,
                        toolName: call?.toolName ?? "finish",
                        input: JSON.stringify(call?.input ?? {}),
                    },
                ],
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage: FAKE_USAGE,
                warnings: [],
            };
        },
    });
}

function issueCall(toolName: string, input: Record<string, unknown>): ScriptedCall {
    return {
        toolName,
        input: { expectedBehavior: null, suspectedCause: null, primaryScreenshotAssetId: null, ...input },
    };
}

/** A finish call with the authored surfaces the tool requires; individual cases override what they assert on. */
function finishCall(input: Record<string, unknown>): ScriptedCall {
    return {
        toolName: "finish",
        input: {
            title: "Checkout broken, login verified",
            headline: "One bug: checkout never completes. Login held up.",
            flows: [],
            ...input,
        },
    };
}

function finding(slug: string, category: AnalysisVerdict, screenshots: ReporterEvidenceAsset[] = []): ReporterFinding {
    return { slug, category, headline: `${slug} headline`, selfHealed: false, screenshots };
}

function openIssue(id: string, findingSlugs: string[]): ReporterExistingIssue {
    return { id, title: id, kind: "bug", severity: "high", status: "open", actualBehavior: "x", findingSlugs };
}

function resolvedIssue(id: string, findingSlugs: string[]): ReporterExistingIssue {
    return { id, title: id, kind: "bug", severity: "high", status: "resolved", actualBehavior: "x", findingSlugs };
}

/** Narrow a union member to its `open` arm, failing the test loudly otherwise. */
function asOpen(issue: ReporterIssueResult | undefined): Extract<ReporterIssueResult, { kind: "open" }> {
    if (issue?.kind !== "open") throw new Error(`expected an open issue, got ${issue?.kind}`);
    return issue;
}

/** Narrow a union member to its `resolve` arm, failing the test loudly otherwise. */
function asResolve(issue: ReporterIssueResult | undefined): Extract<ReporterIssueResult, { kind: "resolve" }> {
    if (issue?.kind !== "resolve") throw new Error(`expected a resolve, got ${issue?.kind}`);
    return issue;
}

let root: string;
const screenshotLoader = { loadScreenshot: async (key: string) => Buffer.from(`png-${key}`) };

function makeInput(overrides: Partial<ReporterInput>): ReporterInput {
    const findings = overrides.findings ?? [];
    return {
        appSlug: "acme",
        target: { kind: "pull_request", prNumber: 42, prTitle: "A PR", prBody: "a description" },
        range: { baseSha: "aaaa111", headSha: "bbbb222" },
        findings: [],
        // A branch whose every test ran at this commit - the simple case, unless a test says otherwise.
        branchTests: findings.map((f) => ({
            slug: f.slug,
            name: `${f.slug} test`,
            category: f.category,
            checkedThisRun: true,
            attributedToClientIssue: false,
        })),
        existingIssues: [],
        priorReports: [],
        scenarioIndex: [],
        codebase: new Codebase(root),
        screenshotLoader,
        ...overrides,
    };
}

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "reporter-agent-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "checkout.ts"), "export function total() {\n  return items.length;\n}\n");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("ReporterAgent - end to end on the AgentLoop harness", () => {
    it("reconciles a bug into an open issue and returns a grounded report", async () => {
        const model = scriptedModel([
            { toolName: "fetch_evidence", input: { assetId: "checkout-final" } },
            issueCall("open_issue", {
                title: "Checkout fails on submit",
                kind: "bug",
                severity: "high",
                expectedBehavior: "the order completes",
                actualBehavior: "the submit button 500s",
                narrativeMarkdown: "Checkout 500s on submit. ![shot](evidence:checkout-final)",
                findingSlugs: ["checkout"],
                primaryFindingSlug: "checkout",
                primaryScreenshotAssetId: "checkout-final",
            }),
            finishCall({ reportMarkdown: "## Report\nCheckout is broken; login works." }),
        ]);
        const input = makeInput({
            findings: [
                finding("checkout", "client_bug", [{ assetId: "checkout-final", s3Key: "k1", label: "final screen" }]),
                finding("login", "passed"),
            ],
        });

        const { result } = await new ReporterAgent({ model }).run(input);

        expect(result.issues).toHaveLength(1);
        const issue = asOpen(result.issues[0]);
        expect(issue.content.findingSlugs).toEqual(["checkout"]);
        expect(issue.content.kind).toBe("bug");
        expect(issue.content.narrativeMarkdown).toContain("evidence:checkout-final");
        expect(issue.content.evidenceManifest.map((e) => e.assetId)).toEqual(["checkout-final"]);
        expect(issue.content.primaryScreenshot).toEqual({ s3Key: "k1" });
        expect(result.reportMarkdown).toContain("Checkout is broken");
    });

    it("drops an unfetched image, a fabricated code reference, and an unfetched hero at persist time", async () => {
        const model = scriptedModel([
            { toolName: "fetch_evidence", input: { assetId: "checkout-final" } },
            issueCall("open_issue", {
                title: "Checkout bug",
                kind: "bug",
                severity: "high",
                actualBehavior: "500 on submit",
                narrativeMarkdown: "Bug. ![a](evidence:checkout-final) and ![b](evidence:checkout-step2)",
                findingSlugs: ["checkout"],
                primaryFindingSlug: "checkout",
                suspectedCause: {
                    explanation: "the count is read wrong",
                    codeReferences: [
                        { file: "src/checkout.ts", lines: "2", snippet: "return items.length;" },
                        { file: "src/checkout.ts", lines: "2", snippet: "return fabricated();" },
                    ],
                },
                // References a screenshot that was never fetched - must not become the hero.
                primaryScreenshotAssetId: "checkout-step2",
            }),
            finishCall({ reportMarkdown: "Report ![c](evidence:checkout-step2)" }),
        ]);
        const input = makeInput({
            findings: [
                finding("checkout", "client_bug", [
                    { assetId: "checkout-final", s3Key: "k1", label: "final" },
                    { assetId: "checkout-step2", s3Key: "k2", label: "step 2" },
                ]),
            ],
        });

        const { result } = await new ReporterAgent({ model }).run(input);

        const issue = asOpen(result.issues[0]);
        expect(issue.content.narrativeMarkdown).toContain("evidence:checkout-final");
        expect(issue.content.narrativeMarkdown).not.toContain("evidence:checkout-step2");
        expect(issue.content.evidenceManifest.map((e) => e.assetId)).toEqual(["checkout-final"]);
        expect(issue.content.suspectedCause?.codeReferences).toHaveLength(1);
        expect(issue.content.suspectedCause?.codeReferences[0]?.snippet).toBe("return items.length;");
        expect(issue.content.primaryScreenshot).toBeUndefined();
        expect(result.reportMarkdown).not.toContain("evidence:checkout-step2");
        expect(result.reportEvidenceManifest).toEqual([]);
    });

    // Coverage enforces issues only for `bug`-bucket findings, so nothing else would catch an environment issue
    // that failed to record.
    it("records an environment issue whose only findings are contained faults with nothing to feature", async () => {
        const model = scriptedModel([
            issueCall("open_issue", {
                title: "Scenario provisioning cannot reach the configured host",
                kind: "environment",
                severity: "high",
                actualBehavior: "every provisioning call to the configured host timed out",
                narrativeMarkdown: "The preview never came up, so no test could run.",
                findingSlugs: ["signup"],
                primaryFindingSlug: "signup",
                primaryScreenshotAssetId: null,
            }),
            finishCall({
                reportMarkdown: "## Report\nThe environment blocked all release validation.",
                headline: "The environment blocked every test; nothing about the app was validated.",
            }),
        ]);
        const input = makeInput({ findings: [finding("signup", "environment_failure")] });

        const { result } = await new ReporterAgent({ model }).run(input);

        expect(result.issues).toHaveLength(1);
        const issue = asOpen(result.issues[0]);
        expect(issue.content.kind).toBe("environment");
        expect(issue.content.primaryScreenshot).toBeUndefined();
        expect(issue.content.expectedBehavior).toBeUndefined();
        expect(issue.content.suspectedCause).toBeUndefined();
    });

    it("still rejects a hero assetId no finding offered, and lets the agent retry without one", async () => {
        const model = scriptedModel([
            issueCall("open_issue", {
                title: "Checkout bug",
                kind: "bug",
                severity: "high",
                actualBehavior: "500",
                narrativeMarkdown: "It 500s.",
                findingSlugs: ["checkout"],
                primaryFindingSlug: "checkout",
                primaryScreenshotAssetId: "no-such-asset",
            }),
            issueCall("open_issue", {
                title: "Checkout bug",
                kind: "bug",
                severity: "high",
                actualBehavior: "500",
                narrativeMarkdown: "It 500s.",
                findingSlugs: ["checkout"],
                primaryFindingSlug: "checkout",
            }),
            finishCall({ reportMarkdown: "final" }),
        ]);
        const input = makeInput({ findings: [finding("checkout", "client_bug")] });

        const { result, conversation } = await new ReporterAgent({ model }).run(input);

        expect(JSON.stringify(conversation)).toContain('Unknown screenshot assetId \\"no-such-asset\\"');
        expect(result.issues).toHaveLength(1);
    });

    it("guarantee 1: rejects finishing until every client_bug finding is covered, then self-corrects", async () => {
        const model = scriptedModel([
            finishCall({ reportMarkdown: "premature" }),
            issueCall("open_issue", {
                title: "Checkout bug",
                kind: "bug",
                severity: "high",
                actualBehavior: "500",
                narrativeMarkdown: "It 500s.",
                findingSlugs: ["checkout"],
                primaryFindingSlug: "checkout",
            }),
            finishCall({ reportMarkdown: "final" }),
        ]);
        const input = makeInput({ findings: [finding("checkout", "client_bug")] });

        const { result, conversation } = await new ReporterAgent({ model }).run(input);

        expect(JSON.stringify(conversation)).toContain("not covered by any issue");
        expect(result.issues).toHaveLength(1);
        expect(model.doGenerateCalls.length).toBe(3);
    });

    it("guarantee 2: rejects finishing until an open issue whose test passed is resolved", async () => {
        const model = scriptedModel([
            finishCall({ reportMarkdown: "premature" }),
            {
                toolName: "resolve_issue",
                input: { existingIssueId: "iss-1", resolvingFindingSlug: "login", note: "login passes now" },
            },
            finishCall({ reportMarkdown: "final" }),
        ]);
        const input = makeInput({
            findings: [finding("login", "passed")],
            existingIssues: [openIssue("iss-1", ["login"])],
        });

        const { result, conversation } = await new ReporterAgent({ model }).run(input);

        expect(JSON.stringify(conversation)).toContain("must be resolved");
        expect(asResolve(result.issues[0]).existingIssueId).toBe("iss-1");
    });

    it("guarantee 3: rejects finishing until an open issue whose test still failed is carried forward", async () => {
        const model = scriptedModel([
            issueCall("open_issue", {
                title: "A new framing",
                kind: "bug",
                severity: "high",
                actualBehavior: "500",
                narrativeMarkdown: "It 500s.",
                findingSlugs: ["checkout"],
                primaryFindingSlug: "checkout",
            }),
            finishCall({ reportMarkdown: "premature" }),
            issueCall("carry_forward_issue", {
                existingIssueId: "iss-2",
                title: "Checkout still broken",
                kind: "bug",
                severity: "high",
                actualBehavior: "still 500",
                narrativeMarkdown: "Still 500s.",
                findingSlugs: ["checkout"],
                primaryFindingSlug: "checkout",
            }),
            finishCall({ reportMarkdown: "final" }),
        ]);
        const input = makeInput({
            findings: [finding("checkout", "client_bug")],
            existingIssues: [openIssue("iss-2", ["checkout"])],
        });

        const { result, conversation } = await new ReporterAgent({ model }).run(input);

        expect(JSON.stringify(conversation)).toContain("must be carried forward");
        expect(result.issues.filter((i) => i.kind === "open")).toHaveLength(1);
        expect(result.issues.filter((i) => i.kind === "carry_forward")).toHaveLength(1);
    });

    it("produces the full set of cross-time outcomes: open, carry-forward, reopen, and resolve", async () => {
        const model = scriptedModel([
            issueCall("open_issue", {
                title: "New bug",
                kind: "bug",
                severity: "high",
                actualBehavior: "broken",
                narrativeMarkdown: "New.",
                findingSlugs: ["a-new-bug"],
                primaryFindingSlug: "a-new-bug",
            }),
            issueCall("carry_forward_issue", {
                existingIssueId: "iss-open",
                title: "Still broken",
                kind: "bug",
                severity: "high",
                actualBehavior: "still broken",
                narrativeMarkdown: "Still.",
                findingSlugs: ["b-still-broken"],
                primaryFindingSlug: "b-still-broken",
            }),
            issueCall("carry_forward_issue", {
                existingIssueId: "iss-resolved",
                title: "Regressed",
                kind: "bug",
                severity: "high",
                actualBehavior: "regressed",
                narrativeMarkdown: "Back again.",
                findingSlugs: ["d-regressed"],
                primaryFindingSlug: "d-regressed",
            }),
            {
                toolName: "resolve_issue",
                input: { existingIssueId: "iss-passing", resolvingFindingSlug: "c-fixed", note: "passes now" },
            },
            finishCall({ reportMarkdown: "Holistic report." }),
        ]);
        const input = makeInput({
            findings: [
                finding("a-new-bug", "client_bug"),
                finding("b-still-broken", "client_bug"),
                finding("c-fixed", "passed"),
                finding("d-regressed", "client_bug"),
            ],
            existingIssues: [
                openIssue("iss-open", ["b-still-broken"]),
                openIssue("iss-passing", ["c-fixed"]),
                resolvedIssue("iss-resolved", ["d-regressed"]),
            ],
        });

        const { result } = await new ReporterAgent({ model }).run(input);

        expect(result.issues.filter((i) => i.kind === "open")).toHaveLength(1);
        expect(result.issues.filter((i) => i.kind === "resolve")).toHaveLength(1);
        const carriedIds = result.issues.flatMap((i) => (i.kind === "carry_forward" ? [i.existingIssueId] : [])).sort();
        expect(carriedIds).toEqual(["iss-open", "iss-resolved"]);
    });

    it("derives each flow's status and owner, and sweeps the tests the agent forgot to place", async () => {
        // The agent names one flow and forgets two tests. Neither omission may cost a verdict: the swept tests keep
        // their real categories, and the named flow cannot read as verified while it holds a gap.
        const model = scriptedModel([
            finishCall({
                reportMarkdown: "Checkout is mostly fine.",
                flows: [{ title: "Guest checkout", detail: "Cart totals were confirmed.", testSlugs: ["cart", "pay"] }],
            }),
        ]);
        const input = makeInput({
            findings: [finding("cart", "passed"), finding("pay", "engine_artifact"), finding("search", "passed")],
            branchTests: [
                {
                    slug: "cart",
                    name: "Cart totals",
                    category: "passed",
                    checkedThisRun: true,
                    attributedToClientIssue: false,
                },
                {
                    slug: "pay",
                    name: "Pay with card",
                    category: "engine_artifact",
                    checkedThisRun: true,
                    attributedToClientIssue: false,
                },
                {
                    slug: "search",
                    name: "Search",
                    category: "passed",
                    checkedThisRun: true,
                    attributedToClientIssue: false,
                },
                {
                    slug: "billing",
                    name: "Billing history",
                    category: "passed",
                    checkedThisRun: false,
                    attributedToClientIssue: false,
                    fromSha: "abc1234",
                },
            ],
        });

        const { result } = await new ReporterAgent({ model }).run(input);

        const [checkout, swept] = result.flows;
        expect(checkout?.title).toBe("Guest checkout");
        expect(checkout?.status).toBe("partial");
        expect(checkout?.passedCount).toBe(1);
        expect(checkout?.gapCount).toBe(1);
        // An engine artifact is ours, so this flow must never be listed as something the reader has to fix.
        expect(checkout?.owner).toBe("autonoma");

        expect(swept?.title).toBe("Other checks");
        expect(swept?.testSlugs).toEqual(["search", "billing"]);
        expect(swept?.status).toBe("verified");
        // The carried verdict counts as a win, and the flow records that neither test ran at this commit.
        expect(swept?.checkedThisRunCount).toBe(1);
        expect(result.flowCorrections.sweptSlugs).toEqual(["search", "billing"]);
    });

    it("refuses a finish whose prose survives validation but not sanitizing, then accepts the retry", async () => {
        // min(1) accepts "#  " and a bare image; flattening then strips both to nothing. Caught here so no read site
        // downstream has to translate an empty string back into "absent".
        const model = scriptedModel([
            finishCall({ reportMarkdown: "Report.", title: "#  ", headline: "![shot](evidence:a1)" }),
            finishCall({ reportMarkdown: "Report.", title: "Cart verified", headline: "The cart held up." }),
        ]);

        const { result, conversation } = await new ReporterAgent({ model }).run(
            makeInput({ findings: [finding("cart", "passed")] }),
        );

        expect(JSON.stringify(conversation)).toContain("Nothing was left of the PR's title and the PR's headline");
        expect(result.title).toBe("Cart verified");
        expect(result.headline).toBe("The cart held up.");
    });

    it("flattens the authored title and headline, which render where Markdown does not", async () => {
        const model = scriptedModel([
            finishCall({
                reportMarkdown: "Report.",
                title: "## Checkout verified",
                headline: "See [the issue](issue:iss-1) for details.",
            }),
        ]);

        const { result } = await new ReporterAgent({ model }).run(makeInput({ findings: [finding("cart", "passed")] }));

        expect(result.title).toBe("Checkout verified");
        expect(result.headline).toBe("See the issue for details.");
    });
});
