import type {
    ExistingTestInfo,
    FailureRecord,
    FlowInfo,
    FlowSummary,
    HealingTestCandidate,
    ScenarioInfo,
} from "@autonoma/diffs";
import { FlowIndex, ScenarioIndex } from "@autonoma/diffs";
import { describe, expect, it } from "vitest";
import type { CodebaseCoords } from "../evals/framework";
import {
    type HealingCaseInput,
    healingCaseInputSchema,
    rehydrateHealingInput,
    serializeHealingInput,
} from "../evals/healing/healing-input";

const coords: CodebaseCoords = {
    owner: "acme",
    repo: "web",
    installationId: 42,
    baseSha: "base000",
    headSha: "head111",
};

/**
 * The on-disk healing fixture is now the single capture/replay format for every
 * refinement turn (the resolution-specific format was removed in #957). These
 * tests pin the two transforms a fixture survives that the typechecker cannot
 * guarantee: the `FlowIndex` / `ScenarioIndex` instances collapse to arrays and
 * rebuild, and the resolution-era optional fields (`candidates`, `existingTests`,
 * `analysisReasoning`, per-failure `reviewLink` / `lineage`) carry their values
 * through - or default cleanly when a pre-fold fixture omits them.
 */
describe("healing fixture round-trip", () => {
    it("carries a first-turn fixture's candidates and replay failures through capture/replay", () => {
        const failures: FailureRecord[] = [
            {
                key: "run-1",
                source: "replay",
                testCaseId: "tc-1",
                testCaseSlug: "checkout-flow",
                testCaseName: "Checkout flow",
                planId: "plan-1",
                planPrompt: "Add an item to the cart and check out",
                sourceId: "run-1",
                sourceStatus: "failed",
                reviewReasoning: "The pay button moved behind a new modal.",
                lineage: [],
                reviewLink: { runReviewId: "rr-1" },
            },
        ];

        const candidates: HealingTestCandidate[] = [
            {
                candidateId: "cand-a",
                name: "Apply a promo code",
                instruction: "Enter a valid promo code at checkout and verify the discount",
                reasoning: "The diff adds a promo-code field with no coverage",
            },
            {
                candidateId: "cand-b",
                name: "Empty cart checkout",
                instruction: "Attempt to check out with an empty cart",
                reasoning: "The diff guards the empty-cart path",
            },
        ];

        const existingTests: ExistingTestInfo[] = [
            {
                id: "tc-1",
                name: "Checkout flow",
                slug: "checkout-flow",
                prompt: "Add an item to the cart and check out",
            },
        ];

        const flows: FlowInfo[] = [{ id: "folder-1", name: "Checkout", testSlugs: ["checkout-flow"] }];
        const flowSummaries: FlowSummary[] = [{ id: "folder-1", name: "Checkout", testCount: 1 }];
        const scenarios: ScenarioInfo[] = [
            { id: "scn-1", name: "Authenticated shopper", description: "A signed-in user with a saved card" },
        ];

        const frozen = serializeHealingInput(
            coords,
            {
                iteration: 1,
                snapshotId: "snap-1",
                applicationId: "app-1",
                organizationId: "org-1",
                priorActions: [],
                failures,
                candidates,
                flowIndex: new FlowIndex(flows),
                existingTests,
                planAuthoring: {
                    scenarios: new ScenarioIndex(scenarios),
                    flows: flowSummaries,
                    testScopeGuidelines: "Do not test payment provider internals.",
                },
                change: { baseSha: "base000", headSha: "head111" },
                analysisReasoning: "Checkout was restructured around a promo-code field.",
            },
            scenarios,
        );

        // Survives the JSON disk trip capture writes / the eval reads back.
        const reparsed = healingCaseInputSchema.parse(JSON.parse(JSON.stringify(frozen)));
        const { agentInput } = rehydrateHealingInput(reparsed);

        // First-turn candidates survive (an optional field, so not type-guaranteed).
        expect(agentInput.candidates).toEqual(candidates);
        // Replay failures keep their discriminated reviewLink + lineage.
        expect(agentInput.failures).toEqual(failures);
        // The suite + flow/scenario indices rebuild from their frozen array forms.
        expect(agentInput.existingTests).toEqual(existingTests);
        expect(agentInput.flowIndex.toArray()).toEqual(flows);
        expect(agentInput.planAuthoring.scenarios.toArray()).toEqual(scenarios);
        // analysisReasoning is default-backed, so its value must round-trip, not reset.
        expect(agentInput.analysisReasoning).toBe("Checkout was restructured around a promo-code field.");
    });

    it("defaults the resolution-era fields when a pre-fold fixture omits them", () => {
        // A later-turn case captured before the resolution capabilities folded in
        // carries no `candidates` / `existingTests` / `flowIndex` / `analysisReasoning`
        // and a failure with no `lineage`. It must still load, with empty defaults.
        const legacy: unknown = {
            codebase: coords,
            iteration: 2,
            snapshotId: "snap-2",
            applicationId: "app-1",
            organizationId: "org-1",
            priorActions: [],
            failures: [
                {
                    key: "gen-9",
                    source: "generation",
                    testCaseId: "tc-9",
                    testCaseSlug: "login",
                    testCaseName: "Login",
                    planId: "plan-9",
                    planPrompt: "Log in with valid credentials",
                    sourceId: "gen-9",
                    sourceStatus: "failed",
                },
            ],
            planAuthoring: { scenarios: [], flows: [] },
            change: { baseSha: "base000", headSha: "head111" },
        };

        const parsed: HealingCaseInput = healingCaseInputSchema.parse(legacy);
        const { agentInput } = rehydrateHealingInput(parsed);

        expect(agentInput.candidates).toEqual([]);
        expect(agentInput.existingTests).toEqual([]);
        expect(agentInput.flowIndex.toArray()).toEqual([]);
        expect(agentInput.analysisReasoning).toBe("");
        expect(agentInput.failures[0]?.lineage).toEqual([]);
    });
});
