import type { InvestigationTestResult, InvestigationVerdict } from "@autonoma/workflow/activities";
import { describe, expect, it } from "vitest";
import {
    buildInvestigationCommentPayload,
    type InvestigationCommentContext,
} from "../src/activities/investigation-comment-payload";

const stats = { assigned: 5, passed: 4, failed: 1, setupFailed: 0, running: 0, runningLabel: "running" };

const context: InvestigationCommentContext = {
    prNumber: 42,
    commitSha: "e5d627abcdef",
    prUrl: "https://beta.autonoma.app/app/acme/pull-requests/42/",
    reportBaseUrl: "https://beta.autonoma.app/app/acme/pull-requests/42/snapshots/snap_1/investigation",
    previewUrl: "https://preview.example.com",
    assetBaseUrl: "https://beta.autonoma.app/github-comment/",
    repoFullName: "acme/web",
    stats,
    checkpointHeadline: "Autonoma found no issues in this PR.",
};

function verdict(category: string): InvestigationVerdict {
    return {
        category,
        isClientBug: category === "client_bug",
        ran: true,
        confidence: "high",
        headline: `${category} headline`,
        falsePositiveRisk: "low",
        whatHappened: "what happened",
        rootCause: "root cause",
        remediation: "do the fix",
        evidence: [{ source: "diff", detail: "the change", file: "app/x.ts", lines: "1-2", snippet: "- a\n+ b" }],
    };
}

function result(slug: string, category: string, extra: Partial<InvestigationTestResult> = {}): InvestigationTestResult {
    return { slug, plan: "", runSuccess: false, stepCount: 1, verdict: verdict(category), ...extra };
}

const noSign = async (): Promise<undefined> => undefined;

describe("buildInvestigationCommentPayload", () => {
    it("is critical, lists client bugs as rich findings, and signs the recording clip", async () => {
        const signed: string[] = [];
        const payload = await buildInvestigationCommentPayload(
            [result("csv-export", "client_bug", { clipUrl: "s3://b/clip.gif" }), result("ok", "passed")],
            context,
            async (url) => {
                signed.push(url);
                return `signed:${url}`;
            },
        );

        expect(payload.state).toBe("critical");
        // Findings-driven headline; the primary checkpoint's stats ride alongside for dashboard parity.
        expect(payload.headline).toBe("Autonoma found 1 bug in this PR.");
        expect(payload.stats).toEqual(stats);
        expect(payload.bugs).toHaveLength(1);
        expect(payload.bugs[0]).toMatchObject({
            title: "client_bug headline",
            markerState: "critical",
            description: "what happened",
            remediation: "do the fix",
            // The animated clip is preferred over a static screenshot and signed for embedding.
            screenshotUrl: "signed:s3://b/clip.gif",
            evidence: [{ source: "diff", file: "app/x.ts", lines: "1-2", snippet: "- a\n+ b" }],
        });
        expect(payload.bugs[0]?.href).toContain("/investigation/csv-export");
        // A client bug WITH a recording clip carries a replay link.
        expect(payload.bugs[0]?.replayHref).toContain("/investigation/csv-export");
        expect(signed).toEqual(["s3://b/clip.gif"]);
    });

    it("omits the replay link for a client bug with no recording clip", async () => {
        const payload = await buildInvestigationCommentPayload(
            [result("no-clip", "client_bug", { finalScreenshotUrl: "s3://b/shot.png" })],
            context,
            async (url) => `signed:${url}`,
        );

        // The static screenshot still embeds, but with no clip there is no replay to watch.
        expect(payload.bugs[0]?.screenshotUrl).toBe("signed:s3://b/shot.png");
        expect(payload.bugs[0]?.replayHref).toBeUndefined();
    });

    it("builds a coding-agent handoff with deep-links and a full findings+evidence prompt", async () => {
        const payload = await buildInvestigationCommentPayload([result("csv-export", "client_bug")], context, noSign);

        expect(payload.handoff).toBeDefined();
        // The three https deep-links (GitHub strips custom schemes), Claude Code carrying the repo.
        expect(payload.handoff?.links.map((link) => link.label)).toEqual([
            "Open in Claude Code",
            "Open in ChatGPT",
            "Open in Cursor",
        ]);
        expect(payload.handoff?.links[0]?.href).toContain("https://claude.ai/code?prompt=");
        expect(payload.handoff?.links[0]?.href).toContain("repositories=acme%2Fweb");

        // The copy-paste prompt carries the whole finding: headline, file:line evidence, and the snippet.
        const prompt = payload.handoff?.prompt ?? "";
        expect(prompt).toContain("client_bug headline");
        expect(prompt).toContain("app/x.ts:1-2");
        expect(prompt).toContain("+ b");
        // And the auth-free MCP path: connect the MCP + call get_investigation with this repo + PR.
        expect(prompt).toContain("https://api.autonoma.app/v1/mcp/debug");
        expect(prompt).toContain('get_investigation(repoFullName="acme/web", prNumber=42)');
    });

    it("omits the handoff when there are no findings", async () => {
        const payload = await buildInvestigationCommentPayload([result("ok", "passed")], context, noSign);
        expect(payload.handoff).toBeUndefined();
    });

    it("lists every finding type - client bugs, actionable issues, and engine artifacts - ordered by severity", async () => {
        const payload = await buildInvestigationCommentPayload(
            [
                result("engine", "engine_artifact"),
                result("scenario", "scenario_issue"),
                result("bug", "client_bug"),
                result("ok", "passed"),
            ],
            context,
            noSign,
        );

        // Critical (a client bug exists), but the actionable issue and engine artifact are still shown -
        // only the passed result is withheld. Client bug leads, then actionable, then informational.
        expect(payload.state).toBe("critical");
        expect(payload.bugs.map((bug) => bug.title)).toEqual([
            "client_bug headline",
            "scenario_issue headline",
            "engine_artifact headline",
        ]);
        // Each finding carries its own severity marker, ordered client bug -> actionable -> engine artifact.
        expect(payload.bugs.map((bug) => bug.markerState)).toEqual(["critical", "warning", "incomplete"]);
    });

    it("is 'incomplete' (not healthy) when only engine artifacts surfaced - the flow never ran", async () => {
        const payload = await buildInvestigationCommentPayload(
            [result("engine", "engine_artifact"), result("ok", "passed")],
            context,
            noSign,
        );

        // No client bug and no actionable finding, but an engine artifact means the runner never executed the
        // flow, so we cannot claim "healthy / no issues" - the passed result is still withheld.
        expect(payload.state).toBe("incomplete");
        expect(payload.headline).toBe("Autonoma couldn't fully test this PR.");
        expect(payload.bugs.map((bug) => bug.title)).toEqual(["engine_artifact headline"]);
        expect(payload.bugs[0]?.markerState).toBe("incomplete");
    });

    it("is a warning when only actionable findings exist (no client bug)", async () => {
        const payload = await buildInvestigationCommentPayload(
            [result("scenario", "scenario_issue"), result("env", "environment_failure")],
            context,
            noSign,
        );

        expect(payload.state).toBe("warning");
        expect(payload.headline).toBe("Autonoma raised 2 warnings in this PR.");
        expect(payload.bugs).toHaveLength(2);
        expect(payload.bugs.every((bug) => bug.markerState === "warning")).toBe(true);
        // Warnings get no "Watch replay" button - the recording adds nothing for scenario/env/test issues.
        expect(payload.bugs.every((bug) => bug.replayHref == null)).toBe(true);
    });

    it("appends the scenario repair route (and client-factory change) to the remediation when diagnosed", async () => {
        const payload = await buildInvestigationCommentPayload(
            [
                result("integrations", "scenario_issue", {
                    scenarioDiagnosis: {
                        route: "recipe_and_sdk",
                        confidence: "high",
                        reasoning: "the factory has no handler for this model",
                        factoryIssue: "register a defineFactory for external_connectors",
                    },
                }),
            ],
            context,
            noSign,
        );

        const remediation = payload.bugs[0]?.remediation ?? "";
        expect(remediation).toContain("do the fix");
        expect(remediation).toContain("Repair route: `recipe_and_sdk`");
        expect(remediation).toContain("Client factory change: register a defineFactory for external_connectors");
    });

    it("is healthy when nothing is actionable, deferring the headline to the primary checkpoint", async () => {
        const payload = await buildInvestigationCommentPayload([result("ok", "passed")], context, noSign);

        expect(payload.state).toBe("healthy");
        expect(payload.bugs).toHaveLength(0);
        // No findings: the headline is the checkpoint-derived copy, never a hard-coded "no issues".
        expect(payload.headline).toBe("Autonoma found no issues in this PR.");
    });

    it("adds the preview CTA only when a preview URL is present", async () => {
        const withPreview = await buildInvestigationCommentPayload([result("ok", "passed")], context, noSign);
        expect(withPreview.ctas.map((cta) => cta.label)).toEqual(["Open in Autonoma", "See preview"]);
        // "Open in Autonoma" lands on the PR overview page, not the investigation report.
        expect(withPreview.ctas[0]).toEqual({ label: "Open in Autonoma", href: context.prUrl });

        const withoutPreview = await buildInvestigationCommentPayload(
            [result("ok", "passed")],
            { ...context, previewUrl: undefined },
            noSign,
        );
        expect(withoutPreview.ctas.map((cta) => cta.label)).toEqual(["Open in Autonoma"]);
    });
});
