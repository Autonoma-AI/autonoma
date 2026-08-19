import type { LanguageModel } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { track } from "../../core/analytics";
import { captureLog } from "../../core/logs";
import { type BudgetPlan, planFlowIds } from "./budget";
import { judgeDuplicates } from "./duplicate-judge";

/** Budget key for pages no flow claims - see `affordable`. */
const UNCLAIMED = "__unclaimed__";

/**
 * What every test in the run has claimed to cover, and the gate a new test
 * passes before anyone pays to write it.
 *
 * A node is an entry point, not a test - two nodes can each decide the shared
 * modal beneath them deserves covering, and in a real run they did: one model
 * wrote "Transfer money from Savings to Checking" under the internal-transfer
 * node and "Transfer money from Checking to Savings" under the external one.
 * Writing a test is many calls and a long structured payload; claiming one is a
 * sentence. Checking first turns a duplicate from wasted generation into a
 * rejected proposal and a note about what already covers it.
 *
 * It is also the coordination point parallel generation needs: with several
 * agents walking different pages, this is the only thing that knows what the run
 * as a whole has already promised to cover.
 */

/** A claim that has been accepted, and now owns its slice of behaviour. */
export interface TestClaim {
    nodeId: string;
    /** One sentence: what this test will prove. Compared against other claims. */
    description: string;
}

export interface ProposalVerdict {
    description: string;
    accepted: boolean;
    /** Why it was rejected, and what already covers it, so the agent can re-angle. */
    reason?: string;
    duplicateOf?: string;
}

export class TestRegistry {
    private readonly claims: TestClaim[] = [];
    /** Serialises judging so two concurrent proposals cannot both pass on the same gap. */
    private tail: Promise<unknown> = Promise.resolve();
    /** Tests already claimed against each flow's allowance. */
    private readonly spent = new Map<string, number>();
    /**
     * Pages that have already drawn their one smoke test. The floor is per page,
     * not per node - a page and every feature beneath it share the page key - so a
     * page gets its guaranteed test exactly once and its sub-features then compete
     * for discretionary budget like anything else.
     */
    private readonly smokedPages = new Set<string>();
    /**
     * The closed set of flow ids a proposal may declare. Empty when the run has no
     * ranking, which `invalidFlowReason` reads as "do not enforce" so degraded runs
     * are untouched.
     */
    private readonly validFlowIds: ReadonlySet<string>;

    constructor(
        private readonly model: LanguageModel,
        private readonly budget?: BudgetPlan,
        /**
         * Which page a node belongs to, so the smoke floor is counted per page
         * rather than per node. Absent (or returning undefined) falls back to the
         * node id, which the no-ranking runs and the unit tests rely on.
         */
        private readonly pageForNode?: (nodeId: string) => string | undefined,
        /**
         * A human-readable page label (route path or name) for a node, handed to the
         * duplicate judge so it compares tests within their page context. Without it,
         * two generically-phrased tests on different pages - a validation error on
         * /auth and one on /workspace - read as the same sentence and get merged.
         * Absent (or returning undefined) falls back to the node id, mirroring
         * `pageForNode`, so no-ranking runs and the unit tests are unaffected.
         */
        private readonly pageLabelForNode?: (nodeId: string) => string | undefined,
    ) {
        this.validFlowIds = budget != null ? planFlowIds(budget) : new Set();
    }

    /**
     * The page a node's tests belong to, as the judge should see it. Falls back to
     * the node id when no label is available, so the judge always has *some* scope
     * rather than a bare sentence.
     */
    private pageLabel(nodeId: string): string {
        return this.pageLabelForNode?.(nodeId) ?? nodeId;
    }

    /**
     * Whether this proposal can be paid for, and if so whether it is the page's
     * free smoke test rather than a discretionary one.
     *
     * Checked at proposal time rather than after writing, which is the entire point
     * of proposing: a sentence costs one judgement, a written test costs a long
     * structured payload and a review pass. Refusing here turns overspend into a
     * redirect instead of waste.
     *
     * The first test of any page is always affordable - it is the smoke floor,
     * which `planBudget` reserved by subtracting one test per page from the
     * discretionary pool. Enforcing it here is what the floor was missing: without
     * it, a page whose flow (or the shared unclaimed pool) was already spent had
     * its very first test rejected as over-budget and ended the run untested, which
     * is exactly how settings pages dropped to zero coverage. A floor test is not
     * charged to any pool, so discretionary budget is spent only on the second test
     * onward and the anti-settings distribution is untouched.
     */
    private affordable(
        flowId: string | undefined,
        nodeId: string,
    ): { ok: true; floor: boolean } | { ok: false; reason: string } {
        if (this.budget == null) return { ok: true, floor: false };

        const pageKey = this.pageForNode?.(nodeId) ?? nodeId;
        if (!this.smokedPages.has(pageKey)) {
            this.smokedPages.add(pageKey);
            return { ok: true, floor: true };
        }

        // A page no flow claims is unknown, not unlimited. Treating it as exempt
        // inverted the whole scheme on a real app: only 15-31% of pages matched a
        // flow's entry points, so the 70% OUTSIDE the ranking were the only ones
        // that could spend without limit - and settings, the thing tiering exists
        // to hold back, is exactly what lives out there.
        if (flowId == null) {
            const used = this.spent.get(UNCLAIMED) ?? 0;
            if (used < this.budget.unclaimedAllowance) {
                this.spent.set(UNCLAIMED, used + 1);
                return { ok: true, floor: false };
            }
            return {
                ok: false,
                reason:
                    `This page already has its smoke test, it is not part of any ranked flow, and the shared ` +
                    `allowance for such pages (${this.budget.unclaimedAllowance}) is spent. Move on to the next node.`,
            };
        }

        const allowance = this.budget.byFlow.get(flowId);
        if (allowance == null) return { ok: true, floor: false };

        const used = this.spent.get(flowId) ?? 0;
        if (used < allowance.allowance) return { ok: true, floor: false };
        return {
            ok: false,
            reason:
                `This page already has its smoke test, and "${allowance.name}" has used its full budget of ` +
                `${allowance.allowance} tests (tier ${allowance.tier}). Do not write more here - the remaining ` +
                `budget belongs to flows that carry more of the product.`,
        };
    }

    private charge(flowId: string | undefined): void {
        // The unclaimed bucket is charged inside `affordable`, where its allowance
        // is checked; charging again here would halve it.
        if (flowId == null) return;
        this.spent.set(flowId, (this.spent.get(flowId) ?? 0) + 1);
    }

    /** What each flow has spent, for reporting how the suite was actually allocated. */
    public get spending(): ReadonlyMap<string, number> {
        return this.spent;
    }

    public get claimed(): readonly TestClaim[] {
        return this.claims;
    }

    /**
     * Why a model-declared flow id is not usable, or `undefined` if it is fine.
     *
     * The cheap end of the same closed-set rule the write_test schema enforces:
     * rejecting a paraphrased flow id ("Card Management - Issuance") as a
     * one-sentence claim costs one judgement, where letting it through costs a full
     * structured write and a review pass. Permissive on two axes so it can only ever
     * catch a genuinely wrong id, never block a real one: an empty set (no ranking)
     * and an undeclared flow both fall through - the latter to the write_test schema,
     * which is the guarantee this only front-runs.
     */
    private invalidFlowReason(declaredFlow: string | undefined): string | undefined {
        if (this.validFlowIds.size === 0) return undefined;
        if (declaredFlow == null || this.validFlowIds.has(declaredFlow)) return undefined;
        const idList = [...this.validFlowIds].join(", ");
        return (
            `"${declaredFlow}" is not one of this run's flow ids. Re-propose with exactly one of these, ` +
            `copied verbatim: ${idList}.`
        );
    }

    /**
     * Judge a node's planned tests against everything already claimed, accepting
     * the ones that cover new behaviour.
     *
     * Proposals are judged in one call per node rather than one per test: the
     * question "which of these five overlap with anything already covered" is
     * cheaper and better posed than five separate ones, and it lets the judge see
     * overlaps within the batch too.
     *
     * Serialised against other proposals. Two agents proposing the same test at
     * the same moment would otherwise both read a registry that lacked it and
     * both be accepted - the exact race that makes parallel generation duplicate.
     */
    public async propose(
        nodeId: string,
        descriptions: string[],
        flowId?: string,
        declaredFlow?: string,
    ): Promise<ProposalVerdict[]> {
        const run = this.tail.then(() => this.judge(nodeId, descriptions, flowId, declaredFlow));
        // Keep the chain alive even if this proposal throws, or every later
        // proposal inherits the rejection and the run silently stops claiming.
        this.tail = run.catch(() => undefined);
        return await run;
    }

    private async judge(
        nodeId: string,
        descriptions: string[],
        flowId?: string,
        declaredFlow?: string,
    ): Promise<ProposalVerdict[]> {
        // A wrong flow id sinks the whole batch, and does so before the judge call:
        // the tests share one flow, so there is nothing to judge until it is fixed.
        const flowReason = this.invalidFlowReason(declaredFlow);
        if (flowReason != null) {
            track("cli_test_claim_invalid_flow", { node_id: nodeId });
            captureLog("info", `Test proposal rejected: flow id is not in the closed set`, {
                source: "test-registry",
                node_id: nodeId,
                declared_flow: declaredFlow,
            });
            return descriptions.map((description) => ({ description, accepted: false, reason: flowReason }));
        }

        // Both sides carry their page so the judge compares within page context;
        // every test a single node proposes shares that node's page.
        const proposedPage = this.pageLabel(nodeId);
        const verdicts = await judgeDuplicates({
            model: this.model,
            existing: this.claims.map((c) => ({ page: this.pageLabel(c.nodeId), description: c.description })),
            proposed: descriptions.map((description) => ({ page: proposedPage, description })),
        });

        const results: ProposalVerdict[] = [];
        for (const description of descriptions) {
            const verdict = verdicts.get(description);
            const duplicateOf = verdict?.duplicateOf;

            if (duplicateOf == null) {
                // Budget is checked per proposal, not per batch, so a node asking for
                // five tests with two left gets two rather than all or nothing.
                const affordable = this.affordable(flowId, nodeId);
                if (!affordable.ok) {
                    track("cli_test_claim_over_budget", { node_id: nodeId });
                    captureLog("info", `Test proposal rejected as over budget`, {
                        source: "test-registry",
                        node_id: nodeId,
                        proposed: description,
                        proposed_page: proposedPage,
                        accepted: false,
                    });
                    results.push({ description, accepted: false, reason: affordable.reason });
                    continue;
                }
                this.claims.push({ nodeId, description });
                // The smoke floor is reserved outside the discretionary pool, so a
                // floor test must not draw it down - only the second test onward does.
                if (!affordable.floor) this.charge(flowId);
                // Acceptance is the high-volume happy path, so it earns an analytics
                // event (from which an acceptance rate is computable) rather than a
                // per-item log line - only the lossy rejection/over-budget cases do.
                track("cli_test_claim_accepted", { node_id: nodeId });
                results.push({ description, accepted: true });
                continue;
            }

            // Every rejection is recorded, with both pages, so a duplicate judge
            // that is too eager - trading visible duplication for invisible gaps -
            // can be spotted by aggregating these lines rather than only in a run
            // nobody re-reads. The matched claim gives the existing side its page.
            const matched = this.claims.find((c) => c.description === duplicateOf);
            track("cli_test_claim_rejected", { node_id: nodeId });
            captureLog("info", `Test proposal rejected as already covered`, {
                source: "test-registry",
                node_id: nodeId,
                proposed: description,
                proposed_page: proposedPage,
                duplicate_of: duplicateOf,
                duplicate_of_page: matched != null ? this.pageLabel(matched.nodeId) : undefined,
                accepted: false,
            });
            results.push({
                description,
                accepted: false,
                duplicateOf,
                reason:
                    `Already covered by: "${duplicateOf}". Write a test for behaviour that is not covered yet, ` +
                    `or skip this one - do not restate it in different words.`,
            });
        }
        return results;
    }
}

/**
 * The tool an agent calls before writing. Returns a verdict per proposal so a
 * rejected one comes back with what already covers it, and the agent can pick a
 * different angle instead of spending a full write to be told later.
 */
export function buildProposeTestsTool(registry: TestRegistry, flowForNode?: (nodeId: string) => string | undefined) {
    return tool({
        description:
            "Claim the tests you plan to write for the current node, BEFORE writing them. " +
            "Give one sentence per test saying what it will prove. Returns which are accepted; " +
            "a rejected one is already covered elsewhere in the suite - do not write it.",
        inputSchema: z.object({
            nodeId: z.string().describe("The id next_node returned for this node, verbatim."),
            flow: z
                .string()
                .optional()
                .describe(
                    "The flow id (copied verbatim from the flows you were given) that every test in this " +
                        "proposal belongs to. Pass it so a wrong id is caught here, before you spend a full write on it.",
                ),
            descriptions: z
                .array(z.string().min(10))
                .min(1)
                .describe(
                    "One sentence per planned test, describing the BEHAVIOUR it proves - not the steps. " +
                        "Propose every test you intend to write for this node in one call.",
                ),
        }),
        execute: async (input) => {
            const verdicts = await registry.propose(
                input.nodeId,
                input.descriptions,
                flowForNode?.(input.nodeId),
                input.flow,
            );
            const accepted = verdicts.filter((v) => v.accepted).map((v) => v.description);
            const rejected = verdicts.filter((v) => !v.accepted);
            return {
                accepted,
                rejected: rejected.map((v) => ({ description: v.description, reason: v.reason })),
                message:
                    rejected.length === 0
                        ? `All ${accepted.length} proposals accepted - write them.`
                        : `${accepted.length} accepted, ${rejected.length} already covered. Write only the accepted ones.`,
            };
        },
    });
}
