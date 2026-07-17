import type { AnalysisTestOrigin, AnalysisVerdict } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import type { AnalysisFinding, ReconciledAnalysisFinding } from "../../src/analysis/dedup";
import { summarizeVerdictPlanes } from "../../src/analysis/verdict-planes";

function member(slug: string, category: AnalysisVerdict, origin: AnalysisTestOrigin = "pre_existing"): AnalysisFinding {
    return { slug, category, headline: `${slug} headline`, planEdited: false, origin };
}

/** A standalone finding wrapping a single member. */
function singleton(m: AnalysisFinding): ReconciledAnalysisFinding {
    return { category: m.category, headline: m.headline, coveredSlugs: [m.slug], members: [m] };
}

describe("summarizeVerdictPlanes", () => {
    it("stays on the passed plane and summarizes coverage findings + the delete-origin split", () => {
        const summary = summarizeVerdictPlanes([
            singleton(member("flake", "engine_artifact")),
            singleton(member("seed", "scenario_issue")),
            singleton(member("gone-new", "delete", "proposed")),
            singleton(member("gone-old", "delete", "pre_existing")),
            singleton(member("gone-new-2", "delete", "proposed")),
        ]);

        expect(summary.verdict).toBe("passed");
        expect(summary.coverage.total).toBe(5);
        expect(summary.coverage.byCategory).toEqual([
            { category: "engine_artifact", count: 1 },
            { category: "scenario_issue", count: 1 },
            { category: "delete", count: 3 },
        ]);
        expect(summary.coverage.unestablishedProposed).toBe(2);
        expect(summary.coverage.obsoleteRemoved).toBe(1);
    });

    it("flips to client_bug when any finding is one, and never counts client_bug on the coverage plane", () => {
        const summary = summarizeVerdictPlanes([
            singleton(member("login", "client_bug")),
            singleton(member("flake", "engine_artifact")),
        ]);

        expect(summary.verdict).toBe("client_bug");
        expect(summary.coverage.byCategory).toEqual([{ category: "engine_artifact", count: 1 }]);
        expect(summary.coverage.total).toBe(1);
    });

    it("counts delete tests at the member level even when merged under a more severe finding", () => {
        // A merged cluster whose headline category is client_bug still contains a proposed delete member; the
        // delete split reads the members, so the unestablished-proposed test is not lost under the merge.
        const merged: ReconciledAnalysisFinding = {
            category: "client_bug",
            headline: "shared cause",
            coveredSlugs: ["login", "gone-new"],
            members: [member("login", "client_bug"), member("gone-new", "delete", "proposed")],
        };

        const summary = summarizeVerdictPlanes([merged]);

        expect(summary.verdict).toBe("client_bug");
        // The delete member is hidden under a client_bug finding, so it is not a distinct coverage finding...
        expect(summary.coverage.byCategory).toEqual([]);
        expect(summary.coverage.total).toBe(0);
        // ...but the test that could not be established is still counted from the members.
        expect(summary.coverage.unestablishedProposed).toBe(1);
    });

    it("treats an empty finding set as passed with an empty coverage summary", () => {
        const summary = summarizeVerdictPlanes([]);
        expect(summary.verdict).toBe("passed");
        expect(summary.coverage).toEqual({ byCategory: [], total: 0, unestablishedProposed: 0, obsoleteRemoved: 0 });
    });
});
