// Display metadata for an investigation finding's verdict category: a human label, the blacklight Badge
// variant, and a sort priority (lower = more actionable, shown first). Categories come from the report as
// plain strings, so unknown values fall back gracefully.

export type FindingBadgeVariant = "critical" | "high" | "warn" | "secondary" | "outline" | "success";

export interface FindingCategoryMeta {
    label: string;
    variant: FindingBadgeVariant;
    /** Lower sorts higher. Passed (6) is collapsed; everything below it is "actionable". */
    priority: number;
}

const CATEGORY_META: Record<string, FindingCategoryMeta> = {
    client_bug: { label: "Client bug", variant: "critical", priority: 0 },
    engine_artifact: { label: "Engine artifact", variant: "high", priority: 1 },
    scenario_issue: { label: "Scenario issue", variant: "warn", priority: 2 },
    bad_test: { label: "Bad test", variant: "secondary", priority: 3 },
    outdated_test: { label: "Outdated test", variant: "secondary", priority: 3 },
    environment_failure: { label: "Environment failure", variant: "outline", priority: 4 },
    unknown_issue: { label: "Unknown issue", variant: "outline", priority: 5 },
    classification_error: { label: "Classification error", variant: "outline", priority: 5 },
    passed: { label: "Passed", variant: "success", priority: 6 },
};

export function findingCategoryMeta(category: string): FindingCategoryMeta {
    return (
        CATEGORY_META[category] ?? {
            label: category.replace(/_/g, " "),
            variant: "outline",
            priority: 5,
        }
    );
}
