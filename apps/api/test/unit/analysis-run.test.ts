import type { Finding } from "@autonoma/analysis";
import type { GenerationStatus } from "@autonoma/db";
import { describe, expect, it } from "vitest";
import { buildAnalysisRunView } from "../../src/routes/branches/analysis-run";

function finding(overrides: Partial<Finding> & { slug: string }): Finding {
    const { slug, ...rest } = overrides;
    return {
        findingId: `finding-${slug}`,
        testCase: { id: `tc-${slug}`, name: slug, slug },
        selfHealed: false,
        classifications: [],
        ...rest,
    };
}

function judged(category: string, headline: string): Finding["current"] {
    return { generationId: "gen", category, headline };
}

describe("buildAnalysisRunView", () => {
    it("derives each row's state: running, judged, and contained", () => {
        const findings: Finding[] = [
            finding({ slug: "running", origin: "pre_existing" }),
            finding({ slug: "judged", origin: "pre_existing", current: judged("client_bug", "Checkout breaks") }),
            finding({
                slug: "contained",
                origin: "proposed",
                failure: { kind: "investigator_crashed", message: "died" },
            }),
        ];
        const statuses = new Map<string, GenerationStatus>([
            ["tc-running", "running"],
            ["tc-judged", "success"],
        ]);

        const view = buildAnalysisRunView(findings, statuses);

        const running = view.findings.find((row) => row.testCase.slug === "running");
        expect(running?.verdict).toBeUndefined();
        expect(running?.contained).toBe(false);
        expect(running?.generationStatus).toBe("running");

        const judgedRow = view.findings.find((row) => row.testCase.slug === "judged");
        expect(judgedRow?.verdict).toEqual({ category: "client_bug", headline: "Checkout breaks" });
        expect(judgedRow?.generationStatus).toBe("success");

        const contained = view.findings.find((row) => row.testCase.slug === "contained");
        expect(contained?.contained).toBe(true);
        expect(contained?.verdict).toBeUndefined();
        // No generation for a crashed investigation - the status is simply absent.
        expect(contained?.generationStatus).toBeUndefined();
    });

    it("summarizes the selection by origin", () => {
        const findings: Finding[] = [
            finding({ slug: "a", origin: "pre_existing" }),
            finding({ slug: "b", origin: "pre_existing" }),
            finding({ slug: "c", origin: "proposed" }),
        ];

        const view = buildAnalysisRunView(findings, new Map());

        expect(view.selection).toEqual({ targetCount: 3, affectedCount: 2, proposedCount: 1 });
    });

    it("drops an unrecognized origin rather than counting it", () => {
        const findings: Finding[] = [finding({ slug: "legacy", origin: "something_old" })];

        const view = buildAnalysisRunView(findings, new Map());

        expect(view.findings[0]?.origin).toBeUndefined();
        expect(view.selection).toEqual({ targetCount: 1, affectedCount: 0, proposedCount: 0 });
    });
});
