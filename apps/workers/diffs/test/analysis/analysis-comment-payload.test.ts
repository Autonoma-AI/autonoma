import { renderMarkdown } from "@autonoma/github/comment";
import { describe, expect, it } from "vitest";
import {
    type AnalysisCommentContext,
    type AnalysisCommentInput,
    buildAnalysisCommentPayload,
} from "../../src/activities/analysis/analysis-comment-payload";

const context: AnalysisCommentContext = {
    prNumber: 42,
    repoFullName: "acme/storefront",
    commitSha: "e5d627abcdef",
    appSlug: "acme",
    previewUrl: "https://a3f8b21c4d9e.preview.autonoma.app",
    appBaseUrl: "https://beta.autonoma.app",
    assetBaseUrl: "https://beta.autonoma.app/github-comment/",
};

const sign = async (key: string): Promise<string> => `signed:${key}`;

function bugIssue(overrides: Partial<AnalysisCommentInput["bugIssues"][number]> = {}) {
    return {
        id: "issue_csv_export",
        title: "CSV export crashes",
        actualBehavior: "The export button threw a 500.",
        screenshotKey: "s3://bucket/final.png",
        clipKey: "s3://bucket/clip.gif",
        replay: { snapshotId: "snap_1", findingId: "finding_csv" },
        suspectedCause: {
            explanation: "The export handler indexes past the end of the row array.",
            codeReferences: [{ file: "app/export.ts", lines: "12-18", snippet: "rows[i + 1].id" }],
        },
        ...overrides,
    };
}

describe("buildAnalysisCommentPayload", () => {
    it("is critical, prefers the clip, and links the issue and its designated run separately", async () => {
        const signed: string[] = [];
        const payload = await buildAnalysisCommentPayload(
            {
                testCount: 6,
                bugIssues: [bugIssue()],
                coverage: {
                    byCategory: [
                        { category: "engine_artifact", count: 2 },
                        { category: "plan_mismatch", count: 3 },
                    ],
                    total: 5,
                },
                summary: "The app misbehaved on one flow; two runs were engine flakes.",
            },
            context,
            async (key) => {
                signed.push(key);
                return `signed:${key}`;
            },
        );

        expect(payload.state).toBe("critical");
        expect(payload.stateLabel).toBe("BUG FOUND");
        expect(payload.headline).toBe("Autonoma found 1 bug in this PR.");
        expect(payload.summary).toBe("The app misbehaved on one flow; two runs were engine flakes.");
        expect(payload.commitRef).toBe("e5d627a");
        expect(payload.bugs).toHaveLength(1);
        expect(payload.bugs[0]).toMatchObject({
            title: "CSV export crashes",
            // The title links to the branch-scoped ISSUE...
            href: "https://beta.autonoma.app/app/acme/pull-requests/42/issues/issue_csv_export",
            // ...while the media links to the ONE RUN the Reporter designated as the clearest reproduction.
            replayHref: "https://beta.autonoma.app/app/acme/pull-requests/42/snapshots/snap_1/findings/finding_csv",
            markerState: "critical",
            description: "The export button threw a 500.",
            suspectedCause: "The export handler indexes past the end of the row array.",
        });
        // Motion beats a still frame in a comment, so the clip wins over the issue's hero and is the only sign.
        expect(payload.bugs[0]?.screenshotUrl).toBe("signed:s3://bucket/clip.gif");
        expect(signed).toEqual(["s3://bucket/clip.gif"]);
        // The grounded code references become the Evidence collapsible a coding agent reads.
        expect(payload.bugs[0]?.evidence).toEqual([
            { source: "code", file: "app/export.ts", lines: "12-18", snippet: "rows[i + 1].id" },
        ]);
        // Fix instructions are deliberately absent - the card diagnoses, it does not prescribe.
        expect(payload.bugs[0]?.remediation).toBeUndefined();
    });

    it("falls back to the issue's hero frame and drops the replay button when the designated run has no clip", async () => {
        const payload = await buildAnalysisCommentPayload(
            { testCount: 3, bugIssues: [bugIssue({ clipKey: undefined })] },
            context,
            sign,
        );

        expect(payload.bugs[0]?.screenshotUrl).toBe("signed:s3://bucket/final.png");
        expect(payload.bugs[0]?.replayHref).toBeUndefined();
    });

    it("drops the replay link when no reproduction run was resolved, even with a clip", async () => {
        const payload = await buildAnalysisCommentPayload(
            { testCount: 3, bugIssues: [bugIssue({ replay: undefined })] },
            context,
            sign,
        );

        expect(payload.bugs[0]?.replayHref).toBeUndefined();
        expect(payload.bugs[0]?.screenshotUrl).toBe("signed:s3://bucket/clip.gif");
    });

    it("hands off to a coding agent: a grounded brief plus prefilled agent deep-links", async () => {
        const payload = await buildAnalysisCommentPayload(
            {
                testCount: 3,
                bugIssues: [bugIssue({ expectedBehavior: "The export should download a CSV." })],
            },
            context,
            sign,
        );

        const prompt = payload.handoff?.prompt ?? "";
        // The brief has to stand alone: an agent reading only this should know what broke, where to look, and how
        // to check its work.
        expect(prompt).toContain("acme/storefront#42");
        expect(prompt).toContain("e5d627a");
        expect(prompt).toContain("Expected: The export should download a CSV.");
        expect(prompt).toContain("Actual: The export button threw a 500.");
        expect(prompt).toContain("Suspected cause: The export handler indexes past the end of the row array.");
        expect(prompt).toContain("app/export.ts:12-18");
        expect(prompt).toContain("rows[i + 1].id");
        expect(prompt).toContain(
            "Issue details: https://beta.autonoma.app/app/acme/pull-requests/42/issues/issue_csv_export",
        );
        expect(prompt).toContain(
            "Run that reproduces it: https://beta.autonoma.app/app/acme/pull-requests/42/snapshots/snap_1/findings/finding_csv",
        );
        // The suspected cause is a lead, not a verdict - the brief must say so, or an agent will trust it blindly.
        expect(prompt).toContain("confirm it against the code before changing anything");
        // The auth-free channel for an agent, since the in-app links need a login.
        expect(prompt).toContain('get_analysis(repoFullName="acme/storefront", prNumber=42)');

        expect(payload.handoff?.links.map((link) => link.label)).toEqual([
            "Open in Claude Code",
            "Open in ChatGPT",
            "Open in Cursor",
        ]);
        const claudeCode = payload.handoff?.links[0]?.href ?? "";
        expect(claudeCode).toContain("https://claude.ai/code?prompt=");
        expect(claudeCode).toContain("repositories=acme%2Fstorefront");
        // Unescaped parens would prematurely close the markdown link destination this href is rendered into.
        expect(claudeCode).not.toContain("(");
        expect(claudeCode).not.toContain(")");
    });

    it("offers no handoff on a clean pass - there is nothing to hand off", async () => {
        const payload = await buildAnalysisCommentPayload({ testCount: 3, bugIssues: [] }, context, sign);

        expect(payload.handoff).toBeUndefined();
    });

    it("carries no suspected cause or evidence when the issue grounded none", async () => {
        const payload = await buildAnalysisCommentPayload(
            { testCount: 3, bugIssues: [bugIssue({ suspectedCause: undefined })] },
            context,
            sign,
        );

        expect(payload.bugs[0]?.suspectedCause).toBeUndefined();
        expect(payload.bugs[0]?.evidence).toEqual([]);
    });

    it("splits the coverage gaps by owner: what the reader must fix, then what is ours", async () => {
        const payload = await buildAnalysisCommentPayload(
            {
                testCount: 9,
                bugIssues: [],
                coverage: {
                    byCategory: [
                        { category: "scenario_issue", count: 2 },
                        { category: "engine_artifact", count: 2 },
                        { category: "environment_failure", count: 3 },
                        { category: "plan_mismatch", count: 1 },
                    ],
                    total: 8,
                },
                // Of the three env gaps, the Reporter traced one to configuration the reader owns.
                clientEnvironmentFailures: 1,
                coverageIssues: [{ id: "issue_coupon_scenario", title: "Checkout scenario seeds no coupon codes" }],
            },
            context,
            sign,
        );

        const attention = payload.notes.find((note) => note.tone === "attention");
        expect(attention?.heading).toBe("⚠️ Needs your attention");
        expect(attention?.items).toEqual([
            "2 scenario issues - the test data these flows need was not seeded, so they never ran.",
            "1 environment failure - the preview could not be exercised with the configuration it has.",
        ]);
        // The why-it-matters line: a setup gap outlives the run it was found in.
        expect(attention?.lines[0]).toContain("block every future run on this branch");
        // What to fix comes from the issue the Reporter filed, deep-linked to its detail page.
        expect(attention?.links).toEqual([
            {
                label: "Checkout scenario seeds no coupon codes",
                href: "https://beta.autonoma.app/app/acme/pull-requests/42/issues/issue_coupon_scenario",
            },
        ]);

        const ours = payload.notes.find((note) => note.tone === "quiet");
        expect(ours?.heading).toBe("On our side");
        expect(ours?.items).toEqual([
            "2 engine artifacts - our runner could not complete these checks.",
            // The two env gaps the Reporter did not place on the reader read as ours, in our words.
            "2 environment failures - the preview environment was not reachable when we ran.",
            "1 unresolved test - the app rendered correctly, but the test's plan no longer matches it and our rewrite could not stabilize it.",
        ]);
        expect(ours?.lines[0]).toContain("Nothing here is yours to fix.");
        // A kept plan_mismatch might be a defect we misdiagnosed, so it is never silently ours.
        expect(ours?.lines[0]).toContain("Worth a glance");
        expect(ours?.links).toEqual([]);
    });

    it("keeps an unplaced environment failure on our side rather than nagging the reader about it", async () => {
        const payload = await buildAnalysisCommentPayload(
            {
                testCount: 2,
                bugIssues: [],
                coverage: { byCategory: [{ category: "environment_failure", count: 2 }], total: 2 },
            },
            context,
            sign,
        );

        expect(payload.notes.map((note) => note.tone)).toEqual(["quiet"]);
        expect(payload.notes[0]?.items).toEqual([
            "2 environment failures - the preview environment was not reachable when we ran.",
        ]);
    });

    it("reports removed invalid tests as one quiet line, in neither owner's block", async () => {
        const payload = await buildAnalysisCommentPayload(
            {
                testCount: 4,
                bugIssues: [],
                coverage: { byCategory: [{ category: "invalid_test", count: 2 }], total: 2 },
            },
            context,
            sign,
        );

        // Not a problem to chase: no heading, no owner, one sentence.
        expect(payload.notes).toEqual([
            {
                tone: "quiet",
                items: [],
                lines: [
                    "2 invalid tests removed - they covered something the app contradicts, so they will not run again.",
                ],
                links: [],
            },
        ]);
    });

    it("is HEALTHY with no cards, summary, or body blocks on a clean pass", async () => {
        const payload = await buildAnalysisCommentPayload({ testCount: 3, bugIssues: [] }, context, sign);

        expect(payload.state).toBe("healthy");
        expect(payload.stateLabel).toBe("HEALTHY");
        expect(payload.headline).toBe("Autonoma verified this change - the app held up.");
        expect(payload.summary).toBeUndefined();
        expect(payload.bugs).toEqual([]);
        expect(payload.notes).toEqual([]);
        expect(payload.warnings).toEqual([]);
    });

    it("is NOT CONFIRMED when the app passed but a coverage gap left the change unverified", async () => {
        const payload = await buildAnalysisCommentPayload(
            {
                testCount: 4,
                bugIssues: [],
                coverage: {
                    byCategory: [{ category: "scenario_issue", count: 1 }],
                    total: 1,
                },
            },
            context,
            sign,
        );

        // A pass with a coverage gap must NOT read as green: "no bug" is not "verified".
        expect(payload.state).toBe("warning");
        expect(payload.stateLabel).toBe("NOT CONFIRMED");
        expect(payload.headline).toBe("Autonoma couldn't confirm this change - 1 check didn't complete.");
        expect(payload.notes[0]?.items).toEqual([
            "1 scenario issue - the test data these flows need was not seeded, so they never ran.",
        ]);
    });

    it("is a green NO TESTS NEEDED when the run decided the change needed no test", async () => {
        const payload = await buildAnalysisCommentPayload(
            {
                testCount: 0,
                bugIssues: [],
                summary: "The change is a parser refactor already covered by unit tests, so no browser test was added.",
            },
            context,
            sign,
        );

        // GitHub offers a tick, a grey circle or a red cross - there is no calm grey, so anything but green reads as
        // an unresolved problem. The state label and headline carry what kind of green this is.
        expect(payload.state).toBe("healthy");
        expect(payload.stateLabel).toBe("NO TESTS NEEDED");
        expect(payload.headline).toBe("No tests needed for this change.");

        const markdown = renderMarkdown(payload);
        expect(markdown).toContain("🟢");
        expect(markdown).not.toContain("⚪");
        expect(markdown).not.toContain("couldn't fully test this PR");
        // The reason is the Reporter's to give; the deterministic copy never generalizes to "this doesn't touch the UI".
        expect(markdown).toContain("already covered by unit tests");
    });

    it("omits the card media entirely when the issue has neither a clip nor a hero frame", async () => {
        const payload = await buildAnalysisCommentPayload(
            {
                testCount: 3,
                bugIssues: [bugIssue({ screenshotKey: undefined, clipKey: undefined })],
            },
            context,
            sign,
        );

        expect(payload.bugs[0]?.screenshotUrl).toBeUndefined();
    });

    it("appends the /autonoma-skip callout under the summary when the gate is blocking", async () => {
        const payload = await buildAnalysisCommentPayload(
            {
                testCount: 3,
                bugIssues: [bugIssue()],
                summary: "The app misbehaved.",
                mergeGateBlocking: true,
            },
            context,
            sign,
        );
        const body = renderMarkdown(payload);

        expect(payload.summary).toContain("The app misbehaved.");
        expect(payload.summary).toContain("/autonoma-skip <reason>");
        expect(body).toContain("This check blocks merging");
        expect(body).toContain("`/autonoma-skip <reason>`");
    });

    it("shows the skip callout as the whole summary when the gate blocks but there is no summary", async () => {
        const payload = await buildAnalysisCommentPayload(
            { testCount: 3, bugIssues: [bugIssue()], mergeGateBlocking: true },
            context,
            sign,
        );

        expect(payload.summary).toContain("/autonoma-skip <reason>");
    });

    it("omits the skip callout when the gate is not blocking (default)", async () => {
        const payload = await buildAnalysisCommentPayload(
            { testCount: 3, bugIssues: [bugIssue()], summary: "The app misbehaved." },
            context,
            sign,
        );

        expect(payload.summary).toBe("The app misbehaved.");
    });

    it("renders the summary and both owner blocks into the shared markdown, quieting only ours", async () => {
        const payload = await buildAnalysisCommentPayload(
            {
                testCount: 5,
                bugIssues: [],
                coverage: {
                    byCategory: [
                        { category: "scenario_issue", count: 1 },
                        { category: "plan_mismatch", count: 3 },
                    ],
                    total: 4,
                },
                coverageIssues: [{ id: "issue_seed", title: "Orders scenario seeds no paid invoice" }],
                summary: "One flow never ran for want of seeded data; three tests could not be stabilized.",
            },
            context,
            sign,
        );
        const body = renderMarkdown(payload);

        // An amber run has no cards, so the title has to name the outcome rather than fall back to a neutral one.
        expect(body).toContain("## 🟡 Autonoma couldn't confirm this PR");
        expect(body).toContain("One flow never ran for want of seeded data; three tests could not be stabilized.");
        // The reader's block is a plain, visible section with a real bullet list...
        expect(body).toContain("**⚠️ Needs your attention**");
        expect(body).toContain("- 1 scenario issue - the test data these flows need was not seeded");
        expect(body).toContain(
            "- [Orders scenario seeds no paid invoice](<https://beta.autonoma.app/app/acme/pull-requests/42/issues/issue_seed>)",
        );
        // ...while ours is blockquoted, so it reads as reported rather than requested.
        expect(body).toContain("> **On our side**");
        expect(body).toContain("> - 3 unresolved tests - the app rendered correctly");
        expect(body).toContain("> Nothing here is yours to fix.");
    });

    it("points the visible preview CTA at the front door and keeps the raw URL for machines", async () => {
        const payload = await buildAnalysisCommentPayload({ testCount: 3, bugIssues: [bugIssue()] }, context, sign);

        const seePreview = payload.ctas.find((cta) => cta.label === "See preview");
        expect(seePreview?.href).toBe(
            `https://beta.autonoma.app/v1/previewkit/open?to=${encodeURIComponent(context.previewUrl!)}`,
        );
        expect(payload.bugs[0]?.previewHref).toBe(seePreview?.href);
        // No services list on this comment, so the hidden block is the only raw URL an agent gets.
        expect(payload.previewUrls).toEqual([context.previewUrl]);
    });
});
