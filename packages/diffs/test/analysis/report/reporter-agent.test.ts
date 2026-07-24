import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnalysisVerdict } from "@autonoma/types";
import { MockLanguageModelV3 } from "ai/test";
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
function scriptedModel(calls: ScriptedCall[]): MockLanguageModelV3 {
    let step = 0;
    return new MockLanguageModelV3({
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

function finding(slug: string, category: AnalysisVerdict, screenshots: ReporterEvidenceAsset[] = []): ReporterFinding {
    return { slug, category, headline: `${slug} headline`, planEdited: false, screenshots };
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
    return {
        appSlug: "acme",
        pr: { number: 42, title: "A PR", body: "a description" },
        findings: [],
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
            {
                toolName: "open_issue",
                input: {
                    title: "Checkout fails on submit",
                    kind: "bug",
                    severity: "high",
                    expectedBehavior: "the order completes",
                    actualBehavior: "the submit button 500s",
                    narrativeMarkdown: "Checkout 500s on submit. ![shot](evidence:checkout-final)",
                    findingSlugs: ["checkout"],
                    primaryFindingSlug: "checkout",
                    primaryScreenshotAssetId: "checkout-final",
                },
            },
            {
                toolName: "finish",
                input: {
                    reportMarkdown: "## Report\nCheckout is broken; login works.",
                    summary: "One bug: checkout never completes.",
                },
            },
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
            {
                toolName: "open_issue",
                input: {
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
                },
            },
            {
                toolName: "finish",
                input: {
                    reportMarkdown: "Report ![c](evidence:checkout-step2)",
                    summary: "One bug: checkout never completes.",
                },
            },
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

    it("guarantee 1: rejects finishing until every client_bug finding is covered, then self-corrects", async () => {
        const model = scriptedModel([
            {
                toolName: "finish",
                input: { reportMarkdown: "premature", summary: "One bug: checkout never completes." },
            },
            {
                toolName: "open_issue",
                input: {
                    title: "Checkout bug",
                    kind: "bug",
                    severity: "high",
                    actualBehavior: "500",
                    narrativeMarkdown: "It 500s.",
                    findingSlugs: ["checkout"],
                    primaryFindingSlug: "checkout",
                },
            },
            { toolName: "finish", input: { reportMarkdown: "final", summary: "One bug: checkout never completes." } },
        ]);
        const input = makeInput({ findings: [finding("checkout", "client_bug")] });

        const { result, conversation } = await new ReporterAgent({ model }).run(input);

        expect(JSON.stringify(conversation)).toContain("not covered by any issue");
        expect(result.issues).toHaveLength(1);
        expect(model.doGenerateCalls.length).toBe(3);
    });

    it("guarantee 2: rejects finishing until an open issue whose test passed is resolved", async () => {
        const model = scriptedModel([
            {
                toolName: "finish",
                input: { reportMarkdown: "premature", summary: "One bug: checkout never completes." },
            },
            {
                toolName: "resolve_issue",
                input: { existingIssueId: "iss-1", resolvingFindingSlug: "login", note: "login passes now" },
            },
            { toolName: "finish", input: { reportMarkdown: "final", summary: "One bug: checkout never completes." } },
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
            {
                toolName: "open_issue",
                input: {
                    title: "A new framing",
                    kind: "bug",
                    severity: "high",
                    actualBehavior: "500",
                    narrativeMarkdown: "It 500s.",
                    findingSlugs: ["checkout"],
                    primaryFindingSlug: "checkout",
                },
            },
            {
                toolName: "finish",
                input: { reportMarkdown: "premature", summary: "One bug: checkout never completes." },
            },
            {
                toolName: "carry_forward_issue",
                input: {
                    existingIssueId: "iss-2",
                    title: "Checkout still broken",
                    kind: "bug",
                    severity: "high",
                    actualBehavior: "still 500",
                    narrativeMarkdown: "Still 500s.",
                    findingSlugs: ["checkout"],
                    primaryFindingSlug: "checkout",
                },
            },
            { toolName: "finish", input: { reportMarkdown: "final", summary: "One bug: checkout never completes." } },
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
            {
                toolName: "open_issue",
                input: {
                    title: "New bug",
                    kind: "bug",
                    severity: "high",
                    actualBehavior: "broken",
                    narrativeMarkdown: "New.",
                    findingSlugs: ["a-new-bug"],
                    primaryFindingSlug: "a-new-bug",
                },
            },
            {
                toolName: "carry_forward_issue",
                input: {
                    existingIssueId: "iss-open",
                    title: "Still broken",
                    kind: "bug",
                    severity: "high",
                    actualBehavior: "still broken",
                    narrativeMarkdown: "Still.",
                    findingSlugs: ["b-still-broken"],
                    primaryFindingSlug: "b-still-broken",
                },
            },
            {
                toolName: "carry_forward_issue",
                input: {
                    existingIssueId: "iss-resolved",
                    title: "Regressed",
                    kind: "bug",
                    severity: "high",
                    actualBehavior: "regressed",
                    narrativeMarkdown: "Back again.",
                    findingSlugs: ["d-regressed"],
                    primaryFindingSlug: "d-regressed",
                },
            },
            {
                toolName: "resolve_issue",
                input: { existingIssueId: "iss-passing", resolvingFindingSlug: "c-fixed", note: "passes now" },
            },
            {
                toolName: "finish",
                input: { reportMarkdown: "Holistic report.", summary: "One bug: checkout never completes." },
            },
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
});
