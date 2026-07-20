import { renderMarkdown } from "@autonoma/github/comment";
import { describe, expect, it } from "vitest";
import {
    type AnalysisCommentContext,
    type AnalysisCommentInput,
    buildAnalysisCommentPayload,
} from "../../src/activities/analysis/analysis-comment-payload";

const context: AnalysisCommentContext = {
    prNumber: 42,
    commitSha: "e5d627abcdef",
    prUrl: "https://beta.autonoma.app/app/acme/pull-requests/42/",
    reportBaseUrl: "https://beta.autonoma.app/app/acme/pull-requests/42/snapshots/snap_1/analysis",
    previewUrl: "https://preview.example.com",
    assetBaseUrl: "https://beta.autonoma.app/github-comment/",
};

const sign = async (key: string): Promise<string> => `signed:${key}`;

function clientBug(overrides: Partial<AnalysisCommentInput["clientBugs"][number]> = {}) {
    return {
        findingKey: "csv-export",
        headline: "CSV export crashes",
        whatHappened: "The export button threw a 500.",
        remediation: "Guard the null row.",
        evidence: [{ source: "diff", detail: "the change", file: "app/x.ts", lines: "1-2", snippet: "- a\n+ b" }],
        clipKey: "s3://bucket/clip.gif",
        ...overrides,
    };
}

describe("buildAnalysisCommentPayload", () => {
    it("is critical, cards each client bug, signs the clip, and deep-links to the analysis finding", async () => {
        const signed: string[] = [];
        const payload = await buildAnalysisCommentPayload(
            {
                verdict: "client_bug",
                clientBugs: [clientBug()],
                coverage: {
                    byCategory: [
                        { category: "engine_artifact", count: 2 },
                        { category: "delete", count: 3 },
                    ],
                    total: 5,
                    unestablishedProposed: 2,
                    obsoleteRemoved: 1,
                },
                narration: "The app misbehaved on one flow; two runs were engine flakes.",
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
            href: "https://beta.autonoma.app/app/acme/pull-requests/42/snapshots/snap_1/analysis/csv-export",
            markerState: "critical",
            replayHref: "https://beta.autonoma.app/app/acme/pull-requests/42/snapshots/snap_1/analysis/csv-export",
            screenshotUrl: "signed:s3://bucket/clip.gif",
            description: "The export button threw a 500.",
            remediation: "Guard the null row.",
        });
        expect(signed).toEqual(["s3://bucket/clip.gif"]);
    });

    it("summarizes the coverage plane on one line: delete split first, then per-category, delete excluded", async () => {
        const payload = await buildAnalysisCommentPayload(
            {
                verdict: "client_bug",
                clientBugs: [clientBug()],
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
        const payload = await buildAnalysisCommentPayload({ verdict: "passed", clientBugs: [] }, context, sign);

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
                clientBugs: [],
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

    it("falls back to the static screenshot and shows no replay when there is no clip", async () => {
        const payload = await buildAnalysisCommentPayload(
            {
                verdict: "client_bug",
                clientBugs: [clientBug({ clipKey: undefined, screenshotKey: "s3://bucket/final.png" })],
            },
            context,
            sign,
        );

        expect(payload.bugs[0]?.screenshotUrl).toBe("signed:s3://bucket/final.png");
        expect(payload.bugs[0]?.replayHref).toBeUndefined();
    });

    it("renders the narration and coverage line into the shared markdown", async () => {
        const payload = await buildAnalysisCommentPayload(
            {
                verdict: "passed",
                clientBugs: [],
                coverage: {
                    byCategory: [],
                    total: 0,
                    unestablishedProposed: 3,
                    obsoleteRemoved: 0,
                },
                narration: "No app issues; three proposed tests could not be established.",
            },
            context,
            sign,
        );
        const body = renderMarkdown(payload);

        expect(body).toContain("No app issues; three proposed tests could not be established.");
        expect(body).toContain("3 proposed tests could not be established");
    });
});
