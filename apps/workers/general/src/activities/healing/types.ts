import type { HealingEvidenceItem, HealingReviewLink, HealingSeverity } from "@autonoma/workflow/activities";

export interface ApplyUpdatePlanInput {
    refinementActionId?: string;
    snapshotId: string;
    organizationId: string;
    testCaseId: string;
    newPrompt: string;
}

export interface ApplyAddTestInput {
    refinementActionId?: string;
    snapshotId: string;
    organizationId: string;
    folderId: string;
    name: string;
    instruction: string;
    scenarioId?: string;
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

export interface ApplyRemoveTestInput {
    refinementActionId?: string;
    snapshotId: string;
    testCaseId: string;
}
