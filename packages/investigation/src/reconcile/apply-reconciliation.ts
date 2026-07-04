import type { InvestigationFinding } from "@autonoma/types";
import type { ReconcilableFinding } from "./dependencies";
import type { ReconciliationResult } from "./schema";

/** Project the report's findings into the shape the reconciliation agent reasons over (drops run media). */
export function toReconcilableFindings(findings: InvestigationFinding[]): ReconcilableFinding[] {
    return findings.map((finding) => ({
        id: finding.id,
        slug: finding.slug,
        category: finding.category,
        confidence: finding.confidence,
        headline: finding.headline,
        rootCause: finding.rootCause,
        whatHappened: finding.whatHappened,
        observedAppIssues: finding.observedAppIssues,
        remediation: finding.remediation,
        evidence: finding.evidence.map((item) => ({
            source: item.source,
            detail: item.detail,
            file: item.file,
            lines: item.lines,
            snippet: item.snippet,
        })),
    }));
}

/** Union the members' evidence, de-duped by (source, file, lines, detail), preserving first-seen order. */
function mergeEvidence(members: InvestigationFinding[]): InvestigationFinding["evidence"] {
    const seen = new Set<string>();
    const out: InvestigationFinding["evidence"] = [];
    for (const member of members) {
        for (const item of member.evidence) {
            const key = `${item.source}|${item.file ?? ""}|${item.lines ?? ""}|${item.detail}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(item);
        }
    }
    return out;
}

/**
 * Apply the reconciliation agent's merges to the run's findings. Each merge collapses its members into ONE
 * finding anchored on the canonical (keeping its run media, category, and routing id) but carrying the agent's
 * combined headline + root cause, the UNION of every member's evidence, and `coveredSlugs` = the tests it now
 * represents. Absorbed (non-canonical) members are dropped. Standalone findings pass through unchanged. Order is
 * preserved: the merged finding sits where its canonical was. `toReconciliationResult` guarantees each finding
 * is in at most one merge, so canonicals and absorbed members never overlap.
 */
export function applyReconciliation(
    findings: InvestigationFinding[],
    result: ReconciliationResult,
): InvestigationFinding[] {
    if (result.merges.length === 0) return findings;

    const byId = new Map(findings.map((finding) => [finding.id, finding]));
    const mergedByCanonical = new Map<string, InvestigationFinding>();
    const absorbed = new Set<string>();

    for (const merge of result.merges) {
        const members = merge.memberIds
            .map((id) => byId.get(id))
            .filter((finding): finding is InvestigationFinding => finding != null);
        const canonical = byId.get(merge.canonicalId);
        if (canonical == null || members.length < 2) continue;

        mergedByCanonical.set(canonical.id, {
            ...canonical,
            headline: merge.headline,
            rootCause: merge.rootCause,
            remediation: merge.remediation ?? canonical.remediation,
            evidence: mergeEvidence(members),
            coveredSlugs: [...new Set(members.map((member) => member.slug))],
        });
        for (const member of members) {
            if (member.id !== canonical.id) absorbed.add(member.id);
        }
    }

    const out: InvestigationFinding[] = [];
    for (const finding of findings) {
        if (absorbed.has(finding.id)) continue;
        out.push(mergedByCanonical.get(finding.id) ?? finding);
    }
    return out;
}
