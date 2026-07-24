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
    prUrl: "https://beta.autonoma.app/app/acme/pull-requests/42/",
    issueBaseUrl: "https://beta.autonoma.app/app/acme/pull-requests/42/issues",
    findingBaseUrl: "https://beta.autonoma.app/app/acme/pull-requests/42/snapshots",
    previewUrl: "https://preview.example.com",
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
        replay: { snapshotId: "snap_1", findingKey: "csv-export" },
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
                verdict: "client_bug",
                bugIssues: [bugIssue()],
                coverage: {
                    byCategory: [
                        { category: "engine_artifact", count: 2 },
                        { category: "delete", count: 3 },
                    ],
                    total: 5,
                    unestablishedProposed: 2,
                    obsoleteRemoved: 1,
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
        expect(payload.headline).toBe("Autonoma found 1 bug in this PR.");
        expect(payload.summary).toBe("The app misbehaved on one flow; two runs were engine flakes.");
        expect(payload.commitRef).toBe("e5d627a");
        expect(payload.bugs).toHaveLength(1);
        expect(payload.bugs[0]).toMatchObject({
            title: "CSV export crashes",
            // The title links to the branch-scoped ISSUE...
            href: "https://beta.autonoma.app/app/acme/pull-requests/42/issues/issue_csv_export",
            // ...while the media links to the ONE RUN the Reporter designated as the clearest reproduction.
            replayHref: "https://beta.autonoma.app/app/acme/pull-requests/42/snapshots/snap_1/findings/csv-export",
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
            { verdict: "client_bug", bugIssues: [bugIssue({ clipKey: undefined })] },
            context,
            sign,
        );

        expect(payload.bugs[0]?.screenshotUrl).toBe("signed:s3://bucket/final.png");
        expect(payload.bugs[0]?.replayHref).toBeUndefined();
    });

    it("drops the replay link when no reproduction run was resolved, even with a clip", async () => {
        const payload = await buildAnalysisCommentPayload(
            { verdict: "client_bug", bugIssues: [bugIssue({ replay: undefined })] },
            context,
            sign,
        );

        expect(payload.bugs[0]?.replayHref).toBeUndefined();
        expect(payload.bugs[0]?.screenshotUrl).toBe("signed:s3://bucket/clip.gif");
    });

    it("hands off to a coding agent: a grounded brief plus prefilled agent deep-links", async () => {
        const payload = await buildAnalysisCommentPayload(
            { verdict: "client_bug", bugIssues: [bugIssue({ expectedBehavior: "The export should download a CSV." })] },
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
            "Run that reproduces it: https://beta.autonoma.app/app/acme/pull-requests/42/snapshots/snap_1/findings/csv-export",
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
        const payload = await buildAnalysisCommentPayload({ verdict: "passed", bugIssues: [] }, context, sign);

        expect(payload.handoff).toBeUndefined();
    });

    it("carries no suspected cause or evidence when the issue grounded none", async () => {
        const payload = await buildAnalysisCommentPayload(
            { verdict: "client_bug", bugIssues: [bugIssue({ suspectedCause: undefined })] },
            context,
            sign,
        );

        expect(payload.bugs[0]?.suspectedCause).toBeUndefined();
        expect(payload.bugs[0]?.evidence).toEqual([]);
    });

    it("summarizes the coverage plane on one line: delete split first, then per-category, delete excluded", async () => {
        const payload = await buildAnalysisCommentPayload(
            {
                verdict: "client_bug",
                bugIssues: [bugIssue()],
                coverage: {
                    byCategory: [
                        { category: "engine_artifact", count: 2 },
                        { category: "environment_failure", count: 1 },
                        { category: "delete", count: 3 },
                    ],
                    total: 6,
                    unestablishedProposed: 2,
                    obsoleteRemoved: 1,
                },
            },
            context,
            sign,
        );

        expect(payload.warnings).toEqual([
            "2 proposed tests could not be established · 1 obsolete test removed · 2 engine artifacts · 1 environment failure",
        ]);
    });

    it("is healthy with no cards, summary, or coverage line on a clean pass", async () => {
        const payload = await buildAnalysisCommentPayload({ verdict: "passed", bugIssues: [] }, context, sign);

        expect(payload.state).toBe("healthy");
        expect(payload.headline).toBe("Autonoma found no issues in this PR.");
        expect(payload.summary).toBeUndefined();
        expect(payload.bugs).toEqual([]);
        expect(payload.warnings).toEqual([]);
    });

    it("passes the app but still surfaces a coverage line when the plane is not empty", async () => {
        const payload = await buildAnalysisCommentPayload(
            {
                verdict: "passed",
                bugIssues: [],
                coverage: {
                    byCategory: [{ category: "scenario_issue", count: 1 }],
                    total: 1,
                    unestablishedProposed: 0,
                    obsoleteRemoved: 0,
                },
            },
            context,
            sign,
        );

        expect(payload.state).toBe("healthy");
        expect(payload.warnings).toEqual(["1 scenario issue"]);
    });

    it("omits the card media entirely when the issue has neither a clip nor a hero frame", async () => {
        const payload = await buildAnalysisCommentPayload(
            {
                verdict: "client_bug",
                bugIssues: [bugIssue({ screenshotKey: undefined, clipKey: undefined })],
            },
            context,
            sign,
        );

        expect(payload.bugs[0]?.screenshotUrl).toBeUndefined();
    });

    it("renders the summary and coverage line into the shared markdown", async () => {
        const payload = await buildAnalysisCommentPayload(
            {
                verdict: "passed",
                bugIssues: [],
                coverage: {
                    byCategory: [],
                    total: 0,
                    unestablishedProposed: 3,
                    obsoleteRemoved: 0,
                },
                summary: "No app issues; three proposed tests could not be established.",
            },
            context,
            sign,
        );
        const body = renderMarkdown(payload);

        expect(body).toContain("No app issues; three proposed tests could not be established.");
        expect(body).toContain("3 proposed tests could not be established");
    });
});
