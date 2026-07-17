import { logger as rootLogger } from "@autonoma/logger";
import { Output, generateText } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { withRetry } from "./retry";

// One structured pass reads short finding headlines and clusters them - no tool loop, no code reads - so the
// call is cheap. It retries at most twice, keeping the worst case well inside the activity's timeout.
const DEDUP_TIMEOUT_MS = 3 * 60_000;
const MODEL_CALL_TRIES = 2;
const CLIENT_BUG = "client_bug";

/** A candidate finding the Reconciler dedups - the thin shape the Investigators emit (one per test). */
export interface AnalysisFinding {
    /** The test that surfaced this finding. Unique per candidate; what a cluster references. */
    slug: string;
    category: string;
    headline: string;
}

/**
 * A deduped finding: ONE underlying issue, carrying the union of every candidate (test) that surfaced it.
 * `coveredSlugs` (length >= 1) is the unioned evidence - length > 1 means several tests were merged into this
 * one finding. `members` keeps each source candidate so the union is inspectable. `category` is the most
 * severe of the members (a client bug anywhere in the group makes the whole group a client bug).
 */
export interface ReconciledAnalysisFinding {
    category: string;
    headline: string;
    coveredSlugs: string[];
    members: AnalysisFinding[];
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
test-data gap, the same broken shared flow or dependency).

# What is NOT the same issue - do NOT merge
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
 * slugs, claim one finding in two clusters, or propose a group of one - none of which we let through:
 * - every memberSlug must be a real candidate slug (unknown slugs dropped);
 * - a cluster needs >= 2 distinct surviving members (else it is not a merge);
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
        const members: AnalysisFinding[] = [];
        for (const slug of cluster.memberSlugs) {
            const finding = bySlug.get(slug);
            if (finding != null && !claimed.has(slug)) members.push(finding);
        }
        if (members.length < 2) continue;

        const anchor = members[0];
        if (anchor == null) continue;
        for (const member of members) claimed.add(member.slug);
        for (const member of members) {
            if (member.slug !== anchor.slug) absorbed.add(member.slug);
        }
        mergedByAnchor.set(anchor.slug, {
            category: mostSevereCategory(members),
            headline: cluster.headline.trim() === "" ? anchor.headline : cluster.headline,
            coveredSlugs: members.map((member) => member.slug),
            members,
        });
    }

    const out: ReconciledAnalysisFinding[] = [];
    for (const finding of findings) {
        if (absorbed.has(finding.slug)) continue;
        out.push(mergedByAnchor.get(finding.slug) ?? toSingleton(finding));
    }
    return out;
}

/** A standalone finding: itself as the sole member. */
function toSingleton(finding: AnalysisFinding): ReconciledAnalysisFinding {
    return { category: finding.category, headline: finding.headline, coveredSlugs: [finding.slug], members: [finding] };
}

/**
 * The category of a merged group. A client bug anywhere in the group makes the whole group a client bug (the
 * app-health plane wins); otherwise the group keeps its first member's category. The full severity ordering
 * arrives with the verdict-taxonomy slice.
 */
function mostSevereCategory(members: AnalysisFinding[]): string {
    if (members.some((member) => member.category === CLIENT_BUG)) return CLIENT_BUG;
    // members is always non-empty (a cluster has >= 2, a singleton exactly 1); fail safe to the non-bug plane.
    return members[0]?.category ?? "passed";
}
