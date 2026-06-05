import type { StorageProvider } from "@autonoma/storage";
import { runAnalysisSchema } from "@autonoma/types";
import { signEvidenceUrls } from "../sign-evidence-urls";
import type { BugIssueRow } from "./bugs.service";

type EvidenceItem = { type: string; description: string; s3Key?: string };

export async function signIssuesEvidence(issues: BugIssueRow[], storageProvider: StorageProvider) {
    return Promise.all(
        issues.map(async (issue) => {
            const parsedAnalysis = runAnalysisSchema.safeParse(
                issue.generationReview?.analysis ?? issue.runReview?.analysis,
            );
            const evidenceItems: EvidenceItem[] = parsedAnalysis.success ? parsedAnalysis.data.evidence : [];
            const evidence = await signEvidenceUrls(evidenceItems, storageProvider);
            const source: "generation" | "run" = issue.generationReview != null ? "generation" : "run";

            return {
                id: issue.id,
                title: issue.title,
                severity: issue.severity,
                createdAt: issue.createdAt,
                source,
                sourceId: issue.generationReview?.generation.id ?? issue.runReview?.run.id,
                sourceStatus: issue.generationReview?.generation.status ?? issue.runReview?.run.status,
                evidence,
            };
        }),
    );
}
