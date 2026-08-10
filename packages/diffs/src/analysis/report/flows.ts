import { logger as rootLogger } from "@autonoma/logger";
import { type AnalysisFlow, type AnalysisFlowMember, summarizeAnalysisFlow } from "@autonoma/types";

/** The synthetic flow every test the Reporter did not place lands in, so the itemization always totals the map. */
const SWEEP_FLOW_TITLE = "Other checks";

/**
 * A flow as the Reporter authors it: a name, a sentence, and the tests it covers. Every judgement about it - whether
 * it counts as verified, whose gaps it holds - is derived from those tests, never authored.
 */
export interface AuthoredFlow {
    title: string;
    detail: string;
    testSlugs: string[];
}

/**
 * What the partition had to correct. These are not errors to retry: nothing rejects a bad partition, so they are the
 * only measurement of whether the agent is doing this job well. A rising sweep count means the prompt is wrong.
 */
export interface FlowCorrections {
    /** Tests the Reporter never placed, swept into {@link SWEEP_FLOW_TITLE}. */
    sweptSlugs: string[];
    /** Tests cited by more than one flow; kept in the first that claimed them, so the flows stay a true partition. */
    duplicateSlugs: string[];
    /** Cited tests that are not in the branch's map at all, dropped rather than invented. */
    unknownSlugs: string[];
}

/** The itemization every surface renders, plus what it took to make it total the map. */
export interface FlowPartition extends FlowCorrections {
    flows: AnalysisFlow[];
}

/**
 * Turn the Reporter's authored flows into the itemization every surface renders, against the branch's last-known
 * verdict per test.
 *
 * The completeness obligation is enforced HERE, by construction, rather than by rejecting the agent's `finish`. A
 * partition violation does not lose information - an unplaced test keeps its real verdict and its real owner, it just
 * lands under a generic name - so failing the run over one would trade a whole PR comment for a nicer label. That is
 * the opposite of the bug-coverage guarantee, which does hard-block, because an uncovered bug would vanish entirely.
 *
 * Three corrections, in the order they are applied: an unknown slug is dropped (the agent cannot conjure a test), a
 * repeated slug stays with the first flow that claimed it (so the flows really do partition the map), and whatever is
 * left unclaimed is swept. A flow with nothing left after the first two is dropped rather than rendered empty, since
 * an empty flow states a confidence it has no evidence for.
 */
export function partitionFlows(
    authored: readonly AuthoredFlow[],
    members: readonly AnalysisFlowMember[],
): FlowPartition {
    // A root child rather than a passed-in Logger, for two reasons. The only caller is `ReporterAgentLoop`, whose
    // `logger` is the minimal agent-core one from `@autonoma/ai` and is not assignable to this package's `Logger` -
    // the same barrier `evidence.ts` beside this file hits. And nothing is lost by it: the observability context is
    // ambient (AsyncLocalStorage, read at emit), so a child made inside the activity's scope still carries the
    // snapshot and branch ids the activity bound.
    const logger = rootLogger.child({ name: "partitionFlows" });
    const bySlug = new Map(members.map((member) => [member.slug, member]));
    const claimed = new Set<string>();
    const unknownSlugs: string[] = [];
    const duplicateSlugs: string[] = [];
    const flows: AnalysisFlow[] = [];

    for (const flow of authored) {
        const owned: AnalysisFlowMember[] = [];
        for (const slug of flow.testSlugs) {
            const member = bySlug.get(slug);
            if (member == null) {
                unknownSlugs.push(slug);
                continue;
            }
            if (claimed.has(slug)) {
                duplicateSlugs.push(slug);
                continue;
            }
            claimed.add(slug);
            owned.push(member);
        }
        if (owned.length === 0) continue;
        flows.push(summarizeAnalysisFlow({ title: flow.title, detail: flow.detail }, owned));
    }

    const sweptMembers = members.filter((member) => !claimed.has(member.slug));
    if (sweptMembers.length > 0) {
        flows.push(
            summarizeAnalysisFlow({ title: SWEEP_FLOW_TITLE, detail: describeMembers(sweptMembers) }, sweptMembers),
        );
    }

    const sweptSlugs = sweptMembers.map((member) => member.slug);
    logger.info("Partitioned the branch's verdict map into flows", {
        extra: {
            authoredCount: authored.length,
            flowCount: flows.length,
            memberCount: members.length,
            sweptCount: sweptSlugs.length,
            duplicateCount: duplicateSlugs.length,
            unknownCount: unknownSlugs.length,
        },
    });

    return { flows, sweptSlugs, duplicateSlugs, unknownSlugs };
}

/**
 * The sweep flow's sentence, stated from the verdicts alone. The agent did not name these checks, so nothing may be
 * claimed about what they cover - only how they came out.
 */
function describeMembers(members: readonly AnalysisFlowMember[]): string {
    const flow = summarizeAnalysisFlow({ title: SWEEP_FLOW_TITLE, detail: "" }, members);
    const parts: string[] = [];
    if (flow.bugCount > 0) parts.push(`${flow.bugCount} found a bug`);
    if (flow.passedCount > 0) parts.push(`${flow.passedCount} confirmed the app`);
    if (flow.gapCount > 0) parts.push(`${flow.gapCount} could not complete`);
    const checks = `${members.length} ${members.length === 1 ? "check" : "checks"}`;
    return `${checks} that are not part of a named flow: ${parts.join(", ")}.`;
}
