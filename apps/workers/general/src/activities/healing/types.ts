import type {
    HealingEvidenceItem,
    HealingReviewLink,
    HealingSeverity,
    IssueReport,
    SuspectedCause,
} from "@autonoma/workflow/activities";

export interface ApplyUpdatePlanInput {
    refinementActionId?: string;
    snapshotId: string;
    organizationId: string;
    testCaseId: string;
    newPrompt: string;
}

export interface ApplyReportBugInput {
    refinementActionId?: string;
    snapshotId: string;
    organizationId: string;
    testCaseId: string;
    title: string;
    description: string;
    severity: HealingSeverity;
    evidence: HealingEvidenceItem[];
    /**
     * The healing-authored, evidence-grounded customer-facing report, persisted on
     * the occurrence's `Issue.report`. Optional: an action that carried no report
     * leaves the occurrence without one.
     */
    report?: IssueReport;
    /**
     * The grounded code-level cause the healing agent re-derived independently.
     * Folded into the persisted `report.suspectedCause` at apply time (it has no
     * home without a report). Optional so actions that carried no cause still apply.
     */
    suspectedCause?: SuspectedCause;
    matchedBugId?: string;
    reviewLink: HealingReviewLink;
}

export interface ApplyReportEngineLimitationInput {
    refinementActionId?: string;
    snapshotId: string;
    organizationId: string;
    testCaseId: string;
    title: string;
    description: string;
    severity: HealingSeverity;
    evidence: HealingEvidenceItem[];
    reviewLink: HealingReviewLink;
}

export interface ApplyReportUnknownIssueInput {
    refinementActionId?: string;
    snapshotId: string;
    organizationId: string;
    testCaseId: string;
    title: string;
    description: string;
    severity: HealingSeverity;
    evidence: HealingEvidenceItem[];
    reviewLink: HealingReviewLink;
}

export interface ApplyReportScenarioUnsupportedInput {
    refinementActionId?: string;
    snapshotId: string;
    organizationId: string;
    testCaseId: string;
    title: string;
    description: string;
    severity: HealingSeverity;
    evidence: HealingEvidenceItem[];
    reviewLink: HealingReviewLink;
}

export interface ApplyRemoveTestInput {
    refinementActionId?: string;
    snapshotId: string;
    testCaseId: string;
}
