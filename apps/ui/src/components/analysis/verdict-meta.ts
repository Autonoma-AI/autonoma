// Display metadata for an analysis finding's terminal AnalysisVerdict: a human label, the blacklight Badge
// variant, its verdict plane, and whether it is actionable (counts against the PR). The two-plane
// actionable/coverage split falls out of this table. Verdicts arrive from the report as plain strings, so
// unknown values fall back gracefully.

import { type AnalysisVerdict, analysisVerdictSchema } from "@autonoma/types";
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

// Exhaustive over the AnalysisVerdict enum (Record<AnalysisVerdict>): adding a verdict is a compile error until
// it is placed here, so the two-plane split can never silently drift from the taxonomy source of truth.
const VERDICT_META: Record<AnalysisVerdict, AnalysisVerdictMeta> = {
    client_bug: { label: "Client bug", variant: "critical", plane: "app_health", actionable: true },
    passed: { label: "Passed", variant: "success", plane: "app_health", actionable: false },
    engine_artifact: { label: "Engine artifact", variant: "high", plane: "coverage", actionable: false },
    scenario_issue: { label: "Scenario issue", variant: "warn", plane: "coverage", actionable: false },
    environment_failure: { label: "Environment failure", variant: "outline", plane: "coverage", actionable: false },
    delete: { label: "Removed", variant: "secondary", plane: "coverage", actionable: false },
};

export function analysisVerdictMeta(category: string): AnalysisVerdictMeta {
    const parsed = analysisVerdictSchema.safeParse(category);
    if (parsed.success) return VERDICT_META[parsed.data];
    return { label: category.replace(/_/g, " "), variant: "outline", plane: "coverage", actionable: false };
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
