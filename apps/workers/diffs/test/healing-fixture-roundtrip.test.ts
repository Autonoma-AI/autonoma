import type { ExistingTestInfo, FailureRecord, FlowInfo, FlowSummary, ScenarioInfo } from "@autonoma/diffs";
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
 * The on-disk healing fixture is the single capture/replay format for every
 * refinement turn. These tests pin the two transforms a fixture survives that
 * the typechecker cannot guarantee: the `FlowIndex` / `ScenarioIndex` instances
 * collapse to arrays and rebuild, and the optional fields (`existingTests`,
 * `analysisReasoning`, per-failure `reviewLink` / `lineage` / `steps`) carry
 * their values through - or default cleanly when an older fixture omits them.
 */
describe("healing fixture round-trip", () => {
    it("carries a fixture's generation failures and suite context through capture/replay", () => {
        const failures: FailureRecord[] = [
            {
                key: "gen-1",
                testCaseId: "tc-1",
                testCaseSlug: "checkout-flow",
                testCaseName: "Checkout flow",
                planId: "plan-1",
                planPrompt: "Add an item to the cart and check out",
                sourceId: "gen-1",
                sourceStatus: "failed",
                reviewReasoning: "The pay button moved behind a new modal.",
                lineage: [],
                reviewLink: { generationReviewId: "gr-1" },
                steps: [
                    {
                        order: 0,
                        interaction: "click",
                        params: { selector: "#pay" },
                        status: "failed",
                        error: "Element not found",
                        errorName: "ElementNotFoundError",
                        screenshotBeforeKey: "gen-1/step-0-before",
                        screenshotAfterKey: "gen-1/step-0-after",
                    },
                ],
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
                maxIterations: 3,
                snapshotId: "snap-1",
                applicationId: "app-1",
                organizationId: "org-1",
                priorActions: [],
                failures,
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

        // Failures keep their reviewLink + lineage.
        expect(agentInput.failures).toEqual(failures);
        // The suite + flow/scenario indices rebuild from their frozen array forms.
        expect(agentInput.existingTests).toEqual(existingTests);
        expect(agentInput.flowIndex.toArray()).toEqual(flows);
        expect(agentInput.planAuthoring.scenarios.toArray()).toEqual(scenarios);
        // analysisReasoning is default-backed, so its value must round-trip, not reset.
        expect(agentInput.analysisReasoning).toBe("Checkout was restructured around a promo-code field.");
        // The iteration cap round-trips so the eval gates the final turn as production does.
        expect(agentInput.maxIterations).toBe(3);
    });

    it("defaults the optional fields when an older fixture omits them", () => {
        // A case captured before these capabilities folded in carries no
        // `existingTests` / `flowIndex` / `analysisReasoning` and a failure with no
        // `lineage`. It must still load, with empty defaults.
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

        expect(agentInput.existingTests).toEqual([]);
        expect(agentInput.flowIndex.toArray()).toEqual([]);
        expect(agentInput.analysisReasoning).toBe("");
        expect(agentInput.failures[0]?.lineage).toEqual([]);
    });
});
