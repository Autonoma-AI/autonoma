// Display metadata for an analysis issue's kind, severity, and lifecycle status: a human label + the blacklight
// Badge variant for each. The values are the typed `@autonoma/types` enums (the API validates the stored plain
// strings at the read boundary), so these Records are exhaustive - adding a value is a compile error until it is
// given copy here.

import type { AnalysisIssueKind, AnalysisIssueSeverity, AnalysisIssueStatus } from "@autonoma/types";
import type { FindingBadgeVariant } from "components/investigation/finding-category";

export interface IssueBadgeMeta {
    label: string;
    variant: FindingBadgeVariant;
}

const KIND_META: Record<AnalysisIssueKind, IssueBadgeMeta> = {
    bug: { label: "Bug", variant: "critical" },
    environment: { label: "Environment", variant: "high" },
    scenario: { label: "Scenario", variant: "warn" },
};

const SEVERITY_META: Record<AnalysisIssueSeverity, IssueBadgeMeta> = {
    critical: { label: "Critical", variant: "critical" },
    high: { label: "High", variant: "high" },
    medium: { label: "Medium", variant: "warn" },
    low: { label: "Low", variant: "secondary" },
};

const STATUS_META: Record<AnalysisIssueStatus, IssueBadgeMeta> = {
    open: { label: "Open", variant: "outline" },
    resolved: { label: "Resolved", variant: "success" },
};

export function analysisIssueKindMeta(kind: AnalysisIssueKind): IssueBadgeMeta {
    return KIND_META[kind];
}

export function analysisIssueSeverityMeta(severity: AnalysisIssueSeverity): IssueBadgeMeta {
    return SEVERITY_META[severity];
}

export function analysisIssueStatusMeta(status: AnalysisIssueStatus): IssueBadgeMeta {
    return STATUS_META[status];
}
