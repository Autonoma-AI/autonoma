// Display metadata for an analysis finding's terminal AnalysisVerdict: a human label, the blacklight Badge
// variant, its presentation tier, its verdict plane, and whether it is actionable (counts against the PR).
// Verdicts arrive from the report as plain strings, so unknown values fall back gracefully.

import {
    type AnalysisFindingTier,
    type AnalysisVerdict,
    analysisFindingTier,
    analysisVerdictPlane,
    analysisVerdictSchema,
} from "@autonoma/types";
import type { FindingBadgeVariant } from "components/investigation/finding-category";

export type VerdictPlane = "app_health" | "coverage";

export interface AnalysisVerdictMeta {
    label: string;
    variant: FindingBadgeVariant;
    /** Which group a findings list renders this in, and the order it sorts by. */
    tier: AnalysisFindingTier;
    /** App-health verdicts drive the PR headline; coverage verdicts never count against it. */
    plane: VerdictPlane;
    /** True only for verdicts that count against the PR - the actionable list; everything else collapses. */
    actionable: boolean;
}

// UI label + Badge variant per verdict. ONLY the label and variant are chosen here: the tier, plane and actionable
// flag are derived from the `@autonoma/types` taxonomy SSOT (analysisFindingTier / analysisVerdictPlane), so no
// grouping or ordering decision can be re-invented in the UI and drift from the backend. Exhaustive over the
// AnalysisVerdict enum: adding a verdict is a compile error until styled here.
const VERDICT_STYLE: Record<AnalysisVerdict, { label: string; variant: FindingBadgeVariant }> = {
    client_bug: { label: "Client bug", variant: "critical" },
    passed: { label: "Passed", variant: "success" },
    engine_artifact: { label: "Engine artifact", variant: "high" },
    scenario_issue: { label: "Scenario issue", variant: "warn" },
    environment_failure: { label: "Environment failure", variant: "outline" },
    plan_mismatch: { label: "Plan mismatch", variant: "secondary" },
};

export function analysisVerdictMeta(category: string): AnalysisVerdictMeta {
    const parsed = analysisVerdictSchema.safeParse(category);
    const style = parsed.success
        ? VERDICT_STYLE[parsed.data]
        : { label: category.replace(/_/g, " "), variant: "outline" as const };
    const tier = analysisFindingTier(category);
    return {
        label: style.label,
        variant: style.variant,
        tier,
        plane: analysisVerdictPlane(category),
        actionable: tier === "bug",
    };
}
