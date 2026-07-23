import { logger as rootLogger } from "@autonoma/logger";
import type { AnalysisFindingReport, AnalysisTestOrigin, AnalysisVerdict } from "@autonoma/types";
import { Output, generateText } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { withRetry } from "./retry";

// One structured pass reads short finding headlines and clusters them - no tool loop, no code reads - so the
// call is cheap. It retries at most twice, keeping the worst case well inside the activity's timeout.
const DEDUP_TIMEOUT_MS = 3 * 60_000;
const MODEL_CALL_TRIES = 2;

/** A candidate finding the Reconciler dedups - the shape the Investigators emit (one per test). */
export interface AnalysisFinding {
    /** The test that surfaced this finding. Unique per candidate; what a cluster references. */
    slug: string;
    category: AnalysisVerdict;
    headline: string;
    /** Whether the Investigator rewrote this test's plan before reaching this verdict (the fidelity signal). */
    planEdited: boolean;
    /** Whether the test pre-existed (affected) or was authored this run (proposed) - the data tag for `delete`. */
    origin: AnalysisTestOrigin;
    /** The classifier's full rich output for this test (narrative, evidence, run-trace frames, media keys) -
     * persisted onto the finding row. Absent for a contained fault/crash that reached no classifier verdict. */
    report?: AnalysisFindingReport;
}

/**
 * A deduped finding: ONE underlying issue, carrying the union of every candidate (test) that surfaced it.
 * `coveredSlugs` (length >= 1) is the unioned evidence - length > 1 means several tests were merged into this
 * one finding. `members` keeps each source candidate (with its own `planEdited`) so the union is inspectable.
 * `category` is the members' SHARED category - only same-category findings may merge, so a group can never be
 * escalated by a single divergent member.
 */
export interface ReconciledAnalysisFinding {
    category: AnalysisVerdict;
    headline: string;
    coveredSlugs: string[];
    members: AnalysisFinding[];
    /** The rich evidence to display + persist for this finding: the first member with a full classifier report
     * (members share one category, so any member's report speaks for the verdict). Absent when no member
     * reached a classifier verdict. */
    report?: AnalysisFindingReport;
}

export interface DedupAnalysisFindingsDeps {
    /** The candidate findings from the whole fan-out - passed at once so clustering is holistic, not pairwise. */
    findings: AnalysisFinding[];
    model: LanguageModel;
}

/**
 * Holistically deduplicate the run's candidate findings: several tests can surface the SAME underlying issue
 * (one code defect, one broken shared flow), each emitting its own candidate. One structured pass reads the
 * WHOLE set at once - so the model reasons about the global clustering rather than making isolated pairwise
 * calls - and returns the groups that share a cause. Each group collapses into one finding that unions its
 * members' evidence (`coveredSlugs` + `members`). Analysis only - it never writes; the caller persists.
 *
 * With fewer than two findings there is nothing to reconcile. Never throws: a model failure is contained and
 * returns every finding un-merged (identity), so a dedup problem can never sink the Reconciler's verdict.
 */
export async function dedupeAnalysisFindings(deps: DedupAnalysisFindingsDeps): Promise<ReconciledAnalysisFinding[]> {
    const { findings, model } = deps;
    const logger = rootLogger.child({ name: "dedupeAnalysisFindings", extra: { findings: findings.length } });

    if (findings.length < 2) {
        logger.info("Fewer than two findings; nothing to reconcile");
        return findings.map(toSingleton);
    }

    logger.info("Deduplicating candidate findings");
    try {
        const decision = await withRetry(
            () =>
                generateText({
                    model,
                    system: DEDUP_SYSTEM_PROMPT,
                    output: Output.object({ schema: DedupForModel }),
                    prompt: buildDedupPrompt(findings),
                    abortSignal: AbortSignal.timeout(DEDUP_TIMEOUT_MS),
                }),
            { label: "analysis-reconcile-dedup", tries: MODEL_CALL_TRIES },
        );

        const reconciled = toReconciledFindings(findings, decision.output.clusters);
        logger.info("Deduplication decided", {
            extra: {
                findings: reconciled.length,
                merged: reconciled.filter((finding) => finding.coveredSlugs.length > 1).length,
            },
        });
        return reconciled;
    } catch (error) {
        logger.warn("Deduplication failed; reporting findings un-merged", { err: error });
        return findings.map(toSingleton);
    }
}

/**
 * One cluster the model proposes: a set of candidates that share ONE underlying cause, collapsed into a single
 * finding. `reason` is for the audit log only (never surfaced as the finding body). `toReconciledFindings`
 * validates every cluster before it is trusted - a hallucinated slug, a group below two members, or a slug
 * claimed by two clusters is dropped.
 */
const ClusterForModel = z.object({
    /** The slugs that share one underlying cause (>= 2). Every slug must come from the provided set. */
    memberSlugs: z.array(z.string()),
    /** The single clearest headline for the shared issue. */
    headline: z.string(),
    /** One short sentence on WHY these are the same issue. */
    reason: z.string(),
});

const DedupForModel = z.object({
    clusters: z.array(ClusterForModel),
});

const DEDUP_SYSTEM_PROMPT = `You reconcile the findings from ONE run of an automated end-to-end test suite.

The suite ran many DIFFERENT tests against the same build. When something is wrong - a code defect, a broken
shared flow, a missing or mis-seeded piece of test data - it often makes SEVERAL tests fail, and each failing
test produced its OWN finding. Those findings describe the SAME underlying issue from different angles. Your job
is to find those groups and merge each into a single finding, so the report shows one issue once instead of the
same issue three times.

You are given the WHOLE set of findings at once. Reason over all of them together - decide the global grouping,
not a series of isolated pairwise comparisons.

# What counts as the same issue
Two findings are the same issue ONLY when they have the SAME underlying CAUSE (the same code defect, the same
test-data gap, the same broken shared flow or dependency). The cause is the specific mechanism named in the
finding - not the feature area, not the page, not the symptom's shape.

# What is NOT the same issue - do NOT merge
- Findings with DIFFERENT categories. A different verdict is a different causal conclusion, so it is never the
  same issue - a client_bug may only merge with another client_bug, an engine_artifact with an engine_artifact,
  and so on. (Mixed-category clusters are rejected by validation regardless.)
- Same feature area or same page, but different causes (two unrelated bugs on the same screen are two findings).
- Same category label alone (two findings sharing a category are NOT automatically the same).
- Similar-sounding headlines. Headlines are terse and can mislead - only merge when the shared cause is clear.
Default to NOT merging. Most findings are standalone. A wrong merge hides a real, distinct problem - that is
worse than leaving a duplicate.

# Writing a cluster
- memberSlugs: every test slug in the group (2 or more), taken from the provided set.
- headline: the clearest single headline for the shared issue.
- reason: one sentence on why these are the same issue.

Return ONLY the clusters you are confident about. If no findings share a cause, return an empty list.`;

/** The user prompt: the finding index (slug, category, headline) - everything the model reasons over. */
function buildDedupPrompt(findings: AnalysisFinding[]): string {
    const index = findings.map((finding) => `- ${finding.slug} [${finding.category}]: ${finding.headline}`).join("\n");
    return [
        `There are ${findings.length} findings in this run. Here is the index (slug, category, headline):`,
        "",
        index,
        "",
        "Group the ones that share the SAME underlying cause, then return the clusters. Be conservative: when in",
        "doubt, leave a finding standalone.",
    ].join("\n");
}

/**
 * Normalize + VALIDATE the model's clusters, then materialize the deduped finding set. The model can hallucinate
 * slugs, claim one finding in two clusters, mix categories, or propose a group of one - none of which we let
 * through:
 * - every memberSlug must be a real candidate slug (unknown slugs dropped);
 * - a cluster may only merge SAME-CATEGORY findings: a mixed cluster is SPLIT by category, and each same-category
 *   sub-group stands (or falls) on its own - so one divergent member (e.g. a lone flaky client_bug among many
 *   non-bug findings) can never be absorbed into, nor escalate, the rest;
 * - a (sub-)cluster needs >= 2 distinct surviving members (else it is not a merge);
 * - a finding may belong to at most ONE cluster (a later cluster reusing a claimed slug loses it) - a clean
 *   partition.
 * Findings in no cluster pass through as singletons. Order is preserved: a merged finding sits where its first
 * member appeared.
 */
function toReconciledFindings(
    findings: AnalysisFinding[],
    clusters: z.infer<typeof DedupForModel>["clusters"],
): ReconciledAnalysisFinding[] {
    const bySlug = new Map(findings.map((finding) => [finding.slug, finding]));
    const claimed = new Set<string>();
    const mergedByAnchor = new Map<string, ReconciledAnalysisFinding>();
    const absorbed = new Set<string>();

    for (const cluster of clusters) {
        const resolved: AnalysisFinding[] = [];
        for (const slug of cluster.memberSlugs) {
            const finding = bySlug.get(slug);
            if (finding != null && !claimed.has(slug)) resolved.push(finding);
        }

        for (const members of partitionByCategory(resolved)) {
            if (members.length < 2) continue;
            const anchor = members[0];
            if (anchor == null) continue;
            for (const member of members) claimed.add(member.slug);
            for (const member of members) {
                if (member.slug !== anchor.slug) absorbed.add(member.slug);
            }
            // The model's headline described the (possibly mixed) cluster as a whole; it only speaks for a
            // sub-group that kept every resolved member. A split sub-group keeps its anchor's own headline.
            const clusterIntact = members.length === resolved.length;
            const headline = clusterIntact && cluster.headline.trim() !== "" ? cluster.headline : anchor.headline;
            mergedByAnchor.set(anchor.slug, {
                category: anchor.category,
                headline,
                coveredSlugs: members.map((member) => member.slug),
                members,
                report: representativeReport(members),
            });
        }
    }

    const out: ReconciledAnalysisFinding[] = [];
    for (const finding of findings) {
        if (absorbed.has(finding.slug)) continue;
        out.push(mergedByAnchor.get(finding.slug) ?? toSingleton(finding));
    }
    return out;
}

/** Split a resolved cluster into same-category sub-groups, preserving member order within each group. */
function partitionByCategory(members: AnalysisFinding[]): AnalysisFinding[][] {
    const groups = new Map<AnalysisVerdict, AnalysisFinding[]>();
    for (const member of members) {
        const group = groups.get(member.category);
        if (group != null) group.push(member);
        else groups.set(member.category, [member]);
    }
    return [...groups.values()];
}

/** A standalone finding: itself as the sole member, carrying its own report. */
function toSingleton(finding: AnalysisFinding): ReconciledAnalysisFinding {
    return {
        category: finding.category,
        headline: finding.headline,
        coveredSlugs: [finding.slug],
        members: [finding],
        report: finding.report,
    };
}

/**
 * The report to display for a merged group: the first member with a full classifier report (members share one
 * category by construction, so any member's report speaks for the group's verdict). Undefined when no member
 * reached a classifier verdict.
 */
function representativeReport(members: AnalysisFinding[]): AnalysisFindingReport | undefined {
    return members.find((member) => member.report != null)?.report;
}
