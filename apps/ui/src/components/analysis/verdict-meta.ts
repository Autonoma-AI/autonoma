// Display metadata for an analysis finding's terminal AnalysisVerdict: a human label, the blacklight Badge
// variant, its verdict plane, and whether it is actionable (counts against the PR). The two-plane
// actionable/coverage split falls out of this table. Verdicts arrive from the report as plain strings, so
// unknown values fall back gracefully.

import {
    type AnalysisVerdict,
    analysisFindingBucket,
    analysisVerdictPlane,
    analysisVerdictSchema,
} from "@autonoma/types";
import type { FindingBadgeVariant } from "components/investigation/finding-category";

export type VerdictPlane = "app_health" | "coverage";

export interface AnalysisVerdictMeta {
    label: string;
    variant: FindingBadgeVariant;
    /** App-health verdicts drive the PR headline; coverage verdicts never count against it. */
    plane: VerdictPlane;
    /** True only for verdicts that count against the PR - the actionable list; everything else collapses. */
    actionable: boolean;
}

// UI label + Badge variant per verdict. The plane/actionable split is NOT hand-listed here - it is derived from
// the `@autonoma/types` taxonomy SSOT (analysisVerdictPlane / analysisFindingBucket) so it can never drift from
// the backend. Exhaustive over the AnalysisVerdict enum: adding a verdict is a compile error until styled here.
const VERDICT_STYLE: Record<AnalysisVerdict, { label: string; variant: FindingBadgeVariant }> = {
    client_bug: { label: "Client bug", variant: "critical" },
    passed: { label: "Passed", variant: "success" },
    engine_artifact: { label: "Engine artifact", variant: "high" },
    scenario_issue: { label: "Scenario issue", variant: "warn" },
    environment_failure: { label: "Environment failure", variant: "outline" },
    delete: { label: "Removed", variant: "secondary" },
};

export function analysisVerdictMeta(category: string): AnalysisVerdictMeta {
    const parsed = analysisVerdictSchema.safeParse(category);
    const style = parsed.success
        ? VERDICT_STYLE[parsed.data]
        : { label: category.replace(/_/g, " "), variant: "outline" as const };
    return {
        label: style.label,
        variant: style.variant,
        plane: analysisVerdictPlane(category),
        actionable: analysisFindingBucket(category) === "bug",
    };
}

/**
 * Sort key for a verdict: actionable first (client bugs), then the coverage plane, then passed. Keeps real
 * signals ahead of the collapsed remainder so an expanded list surfaces coverage issues before green rows.
 */
export function verdictSortKey(category: string): number {
    const meta = analysisVerdictMeta(category);
    if (meta.actionable) return 0;
    return meta.plane === "coverage" ? 1 : 2;
}
