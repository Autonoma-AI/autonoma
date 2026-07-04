import { z } from "zod";

/**
 * One merge the agent proposes: a set of findings that describe the SAME underlying issue, collapsed into a
 * single enriched finding. Every optional field is NULLABLE-and-required (OpenAI strict structured output
 * rejects a property missing from `required`); `toReconciliationResult` normalizes null -> undefined and drops
 * any merge that does not survive validation.
 */
const MergeForModel = z.object({
    /** The finding ids that share one underlying cause (>= 2). Ids must come from the provided list. */
    memberIds: z.array(z.string()),
    /** Which member to keep as the base (its run + category anchor the merged finding). Must be a member. */
    canonicalId: z.string(),
    /** The combined, clearest headline for the merged issue. */
    headline: z.string(),
    /** The combined root cause - the fullest explanation, drawing on EVERY member (cite all the code they found). */
    rootCause: z.string(),
    /** The combined remediation (what to change to fix all of them at once). */
    remediation: z.string().nullable(),
    /** One short sentence on WHY these are the same issue - for the audit log, not shown as the finding body. */
    reason: z.string(),
});

export const ReconciliationForModel = z.object({
    merges: z.array(MergeForModel),
});

/** One accepted merge: the surviving members, the canonical base, and the agent's combined narrative. */
export interface FindingMerge {
    memberIds: string[];
    canonicalId: string;
    headline: string;
    rootCause: string;
    remediation?: string;
    reason: string;
}

export interface ReconciliationResult {
    merges: FindingMerge[];
}

/**
 * Normalize + VALIDATE the model output before it is trusted. The model can hallucinate ids, name a canonical
 * outside its own group, or claim one finding in two merges - none of which we let through:
 * - every memberId must be a real finding id (unknown ids dropped);
 * - a merge needs >= 2 distinct surviving members (else it is not a merge);
 * - the canonical must be one of the surviving members (else the first member is promoted);
 * - a finding may belong to at most ONE merge (a later merge that reuses an already-claimed id is dropped for
 *   those ids, and skipped entirely if it falls below 2 members) - so the result is a clean partition.
 */
export function toReconciliationResult(
    output: z.infer<typeof ReconciliationForModel>,
    validIds: ReadonlySet<string>,
): ReconciliationResult {
    const claimed = new Set<string>();
    const merges: FindingMerge[] = [];

    for (const merge of output.merges) {
        const members: string[] = [];
        for (const id of merge.memberIds) {
            if (validIds.has(id) && !claimed.has(id) && !members.includes(id)) members.push(id);
        }
        if (members.length < 2) continue;

        const canonicalId = members.includes(merge.canonicalId) ? merge.canonicalId : members[0];
        if (canonicalId == null) continue;

        for (const id of members) claimed.add(id);
        merges.push({
            memberIds: members,
            canonicalId,
            headline: merge.headline,
            rootCause: merge.rootCause,
            remediation: merge.remediation ?? undefined,
            reason: merge.reason,
        });
    }

    return { merges };
}
