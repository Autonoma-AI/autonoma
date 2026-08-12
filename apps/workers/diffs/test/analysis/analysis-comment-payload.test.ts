import { renderMarkdown } from "@autonoma/github/comment";
import type { AnalysisVerdictCounts, AnalysisVerdictState, AnalysisVerdictSummary } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import {
    type AnalysisCommentContext,
    type AnalysisCommentInput,
    buildAnalysisCommentPayload,
} from "../../src/activities/analysis/analysis-comment-payload";

/** Stated, not derived: a test that recomputed the verdict would pass even if the builder disagreed with it. */
function verdict(state: AnalysisVerdictState, counts: Partial<AnalysisVerdictCounts> = {}): AnalysisVerdictSummary {
    return {
        state,
        bugCount: counts.bugCount ?? 0,
        coverageGapCount: counts.coverageGapCount ?? 0,
        investigatedCount: counts.investigatedCount ?? 0,
    };
}

const oneBug = (): AnalysisVerdictSummary => verdict("bug_found", { bugCount: 1, investigatedCount: 3 });
const allPassed = (): AnalysisVerdictSummary => verdict("healthy", { investigatedCount: 3 });

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

function flow(
    title: string,
    overrides: Partial<AnalysisCommentInput["flows"] extends (infer F)[] | undefined ? F : never> = {},
) {
    return {
        title,
        detail: `${title} detail`,
        status: "verified" as const,
        owner: "none" as const,
        passedCount: 1,
        gapCount: 0,
        bugCount: 0,
        checkedThisRunCount: 1,
        testSlugs: [title.toLowerCase()],
        ...overrides,
    };
}

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
                verdict: verdict("bug_found", { bugCount: 1, coverageGapCount: 3, investigatedCount: 6 }),
                bugIssues: [bugIssue()],
                coverage: {
                    byCategory: [
                        { category: "engine_artifact", count: 2 },
                        { category: "plan_mismatch", count: 3 },
                    ],
                    total: 5,
                },
                title: "Checkout crashes on export",
                headline: "The app misbehaved on one flow; two runs were engine flakes.",
            },
            context,
            async (key) => {
                signed.push(key);
                return `signed:${key}`;
            },
        );

        expect(payload.state).toBe("critical");
        expect(payload.kind).toBe("analysis");
        // A bug is the one outcome we state ourselves, with a count - the authored title is overridden for it.
        expect(payload.title).toBe("Autonoma found 1 bug in this PR");
        expect(payload.headline).toBe("The app misbehaved on one flow; two runs were engine flakes.");
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
            { verdict: oneBug(), bugIssues: [bugIssue({ clipKey: undefined })] },
            context,
            sign,
        );

        expect(payload.bugs[0]?.screenshotUrl).toBe("signed:s3://bucket/final.png");
        expect(payload.bugs[0]?.replayHref).toBeUndefined();
    });

    it("drops the replay link when no reproduction run was resolved, even with a clip", async () => {
        const payload = await buildAnalysisCommentPayload(
            { verdict: oneBug(), bugIssues: [bugIssue({ replay: undefined })] },
            context,
            sign,
        );

        expect(payload.bugs[0]?.replayHref).toBeUndefined();
        expect(payload.bugs[0]?.screenshotUrl).toBe("signed:s3://bucket/clip.gif");
    });

    it("hands off to a coding agent: a grounded brief plus prefilled agent deep-links", async () => {
        const payload = await buildAnalysisCommentPayload(
            {
                verdict: oneBug(),
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
        const payload = await buildAnalysisCommentPayload({ verdict: allPassed(), bugIssues: [] }, context, sign);

        expect(payload.handoff).toBeUndefined();
    });

    it("carries no suspected cause or evidence when the issue grounded none", async () => {
        const payload = await buildAnalysisCommentPayload(
            { verdict: oneBug(), bugIssues: [bugIssue({ suspectedCause: undefined })] },
            context,
            sign,
        );

        expect(payload.bugs[0]?.suspectedCause).toBeUndefined();
        expect(payload.bugs[0]?.evidence).toEqual([]);
    });

    it("itemizes the flows into wins, the reader's gaps, and ours", async () => {
        const payload = await buildAnalysisCommentPayload(
            {
                verdict: verdict("not_confirmed", { coverageGapCount: 5, investigatedCount: 9 }),
                bugIssues: [],
                flows: [
                    flow("Guest checkout"),
                    flow("Coupon codes", {
                        status: "unverified",
                        owner: "client",
                        passedCount: 0,
                        gapCount: 2,
                        testSlugs: ["coupon-a", "coupon-b"],
                    }),
                    flow("Invoices", {
                        status: "partial",
                        owner: "autonoma",
                        passedCount: 3,
                        gapCount: 1,
                        testSlugs: ["inv-a", "inv-b", "inv-c", "inv-d"],
                    }),
                ],
                coverageIssues: [{ id: "issue_coupon_scenario", title: "Checkout scenario seeds no coupon codes" }],
            },
            context,
            sign,
        );

        // The wins have a block of their own. The body used to carry only losses, so a run that verified most of a
        // PR read as a failure - which is the whole defect the itemization fixes.
        const [verified, yours, ours] = payload.flowGroups;
        expect(verified?.heading).toBe("✅ What we verified");
        expect(verified?.flows).toEqual([{ title: "Guest checkout", detail: "Guest checkout detail" }]);

        expect(yours?.heading).toBe("⚠️ Couldn't check - yours to fix");
        expect(yours?.tone).toBe("attention");
        expect(yours?.flows.map((f) => f.title)).toEqual(["Coupon codes"]);
        expect(yours?.lines[0]).toContain("block every future run on this branch");
        // What to fix comes from the issue the Reporter filed, deep-linked to its detail page.
        expect(yours?.links).toEqual([
            {
                label: "Checkout scenario seeds no coupon codes",
                href: "https://beta.autonoma.app/app/acme/pull-requests/42/issues/issue_coupon_scenario",
            },
        ]);

        expect(ours?.heading).toBe("Couldn't check - on us");
        expect(ours?.tone).toBe("quiet");
        // A partial flow says how much of it held up, so it is never read as a flat failure.
        expect(ours?.flows[0]).toEqual({
            title: "Invoices",
            detail: "Invoices detail",
            meta: "3 of 4 checks passed",
        });
    });

    it("caps a group and links the rest, rather than burying the comment under a long branch", async () => {
        const payload = await buildAnalysisCommentPayload(
            {
                verdict: verdict("not_confirmed", { coverageGapCount: 2, investigatedCount: 8 }),
                bugIssues: [],
                flows: Array.from({ length: 8 }, (_, index) => flow(`Flow ${index}`)),
            },
            context,
            sign,
        );

        expect(payload.flowGroups[0]?.flows).toHaveLength(6);
        expect(payload.flowGroups[0]?.overflow).toEqual({
            count: 2,
            href: "https://beta.autonoma.app/app/acme/pull-requests/42/",
        });
    });

    it("marks a flow nothing re-ran at this commit as carried, so a cumulative list is not read as all-fresh", async () => {
        const payload = await buildAnalysisCommentPayload(
            { verdict: verdict("healthy"), bugIssues: [], flows: [flow("Billing", { checkedThisRunCount: 0 })] },
            context,
            sign,
        );

        expect(payload.flowGroups[0]?.flows[0]?.meta).toBe("carried from an earlier commit");
    });

    it("keeps the reader's issue links when the only client-owned gap sits in a flow that also holds a bug", async () => {
        // A flow mixing a client_bug test with a scenario_issue test is skipped as `broken` (its bug is a card), so
        // keying the block on the flow list alone would drop the one actionable thing in the comment.
        const payload = await buildAnalysisCommentPayload(
            {
                verdict: verdict("not_confirmed", { coverageGapCount: 1, investigatedCount: 2 }),
                bugIssues: [bugIssue()],
                flows: [flow("Checkout", { status: "broken", owner: "client", bugCount: 1, passedCount: 0 })],
                coverageIssues: [{ id: "issue_coupon_scenario", title: "Checkout scenario seeds no coupon codes" }],
            },
            context,
            sign,
        );

        const yours = payload.flowGroups.find((group) => group.heading.includes("yours to fix"));
        expect(yours?.links).toEqual([
            {
                label: "Checkout scenario seeds no coupon codes",
                href: "https://beta.autonoma.app/app/acme/pull-requests/42/issues/issue_coupon_scenario",
            },
        ]);
    });

    it("leaves a broken flow out of the itemization, since its bug already has a card", async () => {
        const payload = await buildAnalysisCommentPayload(
            {
                verdict: verdict("not_confirmed", { coverageGapCount: 1, investigatedCount: 2 }),
                bugIssues: [bugIssue()],
                flows: [flow("Checkout", { status: "broken", bugCount: 1, passedCount: 0 }), flow("Search")],
            },
            context,
            sign,
        );

        expect(payload.flowGroups.flatMap((group) => group.flows.map((f) => f.title))).toEqual(["Search"]);
    });

    it("reports removed invalid tests as one quiet line, in neither owner's block", async () => {
        const payload = await buildAnalysisCommentPayload(
            {
                verdict: verdict("not_confirmed", { coverageGapCount: 2, investigatedCount: 4 }),
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
        const payload = await buildAnalysisCommentPayload({ verdict: allPassed(), bugIssues: [] }, context, sign);

        expect(payload.state).toBe("healthy");
        // Nothing was authored and there is no itemization, so the title falls back to the copy this run's own COUNTS
        // earn. It must not read "no tests needed" - three tests ran, and every pre-flows report reaches this path.
        expect(payload.title).toBe("Autonoma verified this change");
        expect(payload.headline).toBe("Autonoma verified this change - the app held up.");
        expect(payload.summary).toBeUndefined();
        expect(payload.bugs).toEqual([]);
        expect(payload.notes).toEqual([]);
        expect(payload.flowGroups).toEqual([]);
        expect(payload.warnings).toEqual([]);
    });

    it("is NOT CONFIRMED when the app passed but a coverage gap left the change unverified", async () => {
        const payload = await buildAnalysisCommentPayload(
            {
                verdict: verdict("not_confirmed", { coverageGapCount: 1, investigatedCount: 4 }),
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
        // The colour is still computed from counts - it drives the merge gate and the rail - but it no longer
        // renders as a badge word above the headline.
        expect(payload.state).toBe("warning");
        expect(payload.stateLabel).toBeUndefined();
        expect(payload.headline).toBe("Autonoma couldn't confirm this change - 1 check didn't complete.");
    });

    it("is a green NO TESTS NEEDED when the run decided the change needed no test", async () => {
        const payload = await buildAnalysisCommentPayload(
            {
                verdict: verdict("no_tests_needed"),
                bugIssues: [],
                headline:
                    "The change is a parser refactor already covered by unit tests, so no browser test was added.",
            },
            context,
            sign,
        );

        // GitHub offers a tick, a grey circle or a red cross - there is no calm grey, so anything but green reads as
        // an unresolved problem. The state label and headline carry what kind of green this is.
        expect(payload.state).toBe("healthy");
        expect(payload.title).toBe("No tests needed for this change");

        const markdown = renderMarkdown(payload);
        // Only a bug carries a marker now: a run that needed no tests is not a problem to flag.
        expect(markdown).toContain("## No tests needed for this change");
        expect(markdown).not.toContain("⚪");
        expect(markdown).not.toContain("🟢");
        expect(markdown).not.toContain("couldn't fully test this PR");
        // The reason is the Reporter's to give; the deterministic copy never generalizes to "this doesn't touch the UI".
        expect(markdown).toContain("already covered by unit tests");
    });

    it("omits the card media entirely when the issue has neither a clip nor a hero frame", async () => {
        const payload = await buildAnalysisCommentPayload(
            {
                verdict: oneBug(),
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
                verdict: oneBug(),
                bugIssues: [bugIssue()],
                headline: "The app misbehaved.",
                mergeGateBlocking: true,
            },
            context,
            sign,
        );
        const body = renderMarkdown(payload);

        expect(payload.headline).toBe("The app misbehaved.");
        expect(payload.summary).toContain("/autonoma-skip <reason>");
        expect(body).toContain("This check blocks merging");
        expect(body).toContain("`/autonoma-skip <reason>`");
    });

    it("shows the skip callout as the whole summary when the gate blocks but there is no summary", async () => {
        const payload = await buildAnalysisCommentPayload(
            { verdict: oneBug(), bugIssues: [bugIssue()], mergeGateBlocking: true },
            context,
            sign,
        );

        expect(payload.summary).toContain("/autonoma-skip <reason>");
    });

    it("omits the skip callout when the gate is not blocking (default)", async () => {
        const payload = await buildAnalysisCommentPayload(
            { verdict: oneBug(), bugIssues: [bugIssue()], headline: "The app misbehaved." },
            context,
            sign,
        );

        expect(payload.summary).toBeUndefined();
    });

    it("renders the itemization into the shared markdown, quieting only what is ours", async () => {
        const payload = await buildAnalysisCommentPayload(
            {
                verdict: verdict("not_confirmed", { coverageGapCount: 4, investigatedCount: 5 }),
                bugIssues: [],
                title: "Orders verified; invoices couldn't be seeded",
                headline: "One flow never ran for want of seeded data; three tests could not be stabilized.",
                flows: [
                    flow("Orders"),
                    flow("Invoices", { status: "unverified", owner: "client", passedCount: 0, gapCount: 1 }),
                    flow("Reports", { status: "unverified", owner: "autonoma", passedCount: 0, gapCount: 3 }),
                ],
                coverageIssues: [{ id: "issue_seed", title: "Orders scenario seeds no paid invoice" }],
            },
            context,
            sign,
        );
        const body = renderMarkdown(payload);

        // The Reporter's title is the heading, with no marker: only a bug is raised as an alarm.
        expect(body).toContain("## Orders verified; invoices couldn't be seeded");
        expect(body).not.toContain("🟡");
        // ...and no badge word compressing the headline back into the binary it replaced.
        expect(body).not.toContain("**NOT CONFIRMED**");
        expect(body).toContain("One flow never ran for want of seeded data; three tests could not be stabilized.");

        // The wins read at the same weight as everything else, as a real bullet list.
        expect(body).toContain("**✅ What we verified**");
        expect(body).toContain("- **Orders** - Orders detail");
        expect(body).toContain("**⚠️ Couldn't check - yours to fix**");
        expect(body).toContain(
            "[Orders scenario seeds no paid invoice](<https://beta.autonoma.app/app/acme/pull-requests/42/issues/issue_seed>)",
        );
        // ...while what is ours is blockquoted, so it is visible without being asked of the reader.
        expect(body).toContain("> **Couldn't check - on us**");
        expect(body).toContain("> Nothing here is yours to fix.");
    });

    it("points the visible preview CTA at the front door and keeps the raw URL for machines", async () => {
        const payload = await buildAnalysisCommentPayload(
            { verdict: oneBug(), bugIssues: [bugIssue()] },
            context,
            sign,
        );

        const seePreview = payload.ctas.find((cta) => cta.label === "See preview");
        expect(seePreview?.href).toBe(
            `https://beta.autonoma.app/v1/previewkit/open?to=${encodeURIComponent(context.previewUrl!)}`,
        );
        expect(payload.bugs[0]?.previewHref).toBe(seePreview?.href);
        // No services list on this comment, so the hidden block is the only raw URL an agent gets.
        expect(payload.previewUrls).toEqual([context.previewUrl]);
    });
});
