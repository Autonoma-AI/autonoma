import { describe, expect, it } from "vitest";
import type { BranchEdit, MainSuiteEntry } from "../../src";
import { openModelSession, reconcileMerge } from "../../src";

/**
 * A real-model evalset (gpt-5.5) for the merge-with-main reconciler. It checks the three decisions that matter:
 * carry a genuinely-new test, drop a proposed test main already covers, and merge a modification that conflicts
 * with a change someone else landed on main. Hits the live OpenAI API, so it only runs with RUN_EVALS=1
 * (skipped in CI and plain `pnpm test`). Run it with:
 *   RUN_EVALS=1 pnpm --filter @autonoma/investigation exec vitest run test/merge/reconcile-merge.eval.test.ts
 */
const RUN = process.env.RUN_EVALS === "1" && process.env.OPENAI_API_KEY != null && process.env.OPENAI_API_KEY !== "";

function model() {
    return openModelSession({ openaiApiKey: process.env.OPENAI_API_KEY ?? "" }).getModel({
        model: "classifier",
        tag: "eval-merge-reconcile",
    });
}

const MAIN_SUITE: MainSuiteEntry[] = [
    { slug: "checkout-flow", name: "Checkout", flow: "Commerce", description: "buys a single item end to end" },
    { slug: "login-flow", name: "Login", flow: "Auth", description: "signs a returning user in with email" },
];

describe.skipIf(!RUN)("eval: merge reconciler (gpt-5.5)", () => {
    it("keeps a genuinely new test and drops one main already covers", async () => {
        const edits: BranchEdit[] = [
            {
                kind: "new_test",
                ref: "guest-checkout",
                name: "Guest checkout",
                flow: "Commerce",
                description: "completes checkout without an account",
                proposedPlan:
                    "## Setup\nStart on the product page.\n## Steps\n1. click Add to cart\n2. click Checkout\n3. click Continue as guest\n4. type shipping details\n5. click Place order\n## Verification\n- assert the order confirmation is shown",
            },
            {
                kind: "new_test",
                ref: "sign-in",
                name: "Sign in",
                flow: "Auth",
                description: "signs a returning user in with email",
                proposedPlan:
                    "## Setup\nStart on the login page.\n## Steps\n1. type the email\n2. type the password\n3. click Sign in\n## Verification\n- assert the dashboard is shown",
            },
        ];

        const plan = await reconcileMerge({ edits, mainSuite: MAIN_SUITE, recipeEdits: [] }, { model: model() });

        const guest = plan.decisions.find((decision) => decision.ref === "guest-checkout");
        const signIn = plan.decisions.find((decision) => decision.ref === "sign-in");
        // The novel guest-checkout test is carried; the duplicate of login-flow is dropped.
        expect(guest?.action).toBe("apply");
        expect(signIn?.action).toBe("skip");
    });

    it("merges a modification that conflicts with a change already on main", async () => {
        const edits: BranchEdit[] = [
            {
                kind: "modification",
                ref: "checkout-flow",
                name: "Checkout",
                flow: "Commerce",
                description: "buys a single item end to end",
                basePlan:
                    "## Setup\nStart on the product page.\n## Steps\n1. click Add to cart\n2. click Checkout\n3. click Place order\n## Verification\n- assert the order confirmation is shown",
                // The branch adds a coupon step.
                proposedPlan:
                    "## Setup\nStart on the product page.\n## Steps\n1. click Add to cart\n2. click Checkout\n3. type SAVE10 into the coupon field\n4. click Apply\n5. click Place order\n## Verification\n- assert the order confirmation is shown",
                // Meanwhile main added a shipping step to the SAME test.
                mainCurrentPlan:
                    "## Setup\nStart on the product page.\n## Steps\n1. click Add to cart\n2. click Checkout\n3. type the shipping address\n4. click Place order\n## Verification\n- assert the order confirmation is shown",
            },
        ];

        const plan = await reconcileMerge({ edits, mainSuite: MAIN_SUITE, recipeEdits: [] }, { model: model() });

        const decision = plan.decisions.find((d) => d.ref === "checkout-flow");
        expect(decision?.action).toBe("apply");
        // A real reconcile preserves BOTH intents - the coupon step and main's shipping step.
        const merged = decision?.mergedPlan ?? "";
        expect(merged.toLowerCase()).toContain("coupon");
        expect(merged.toLowerCase()).toContain("shipping");
    });
});
