import { describe, expect, it } from "vitest";
import { flowCompletenessRubric } from "../../src/agents/05-test-generator/rubrics";
import {
    echoesStepGuidance,
    STEP_DESCRIPTION_GUIDANCE,
    STEP_LOCATION_GUIDANCE,
} from "../../src/agents/05-test-generator/step-guidance";
import {
    buildTestSpecSchema,
    renderTestMarkdown,
    type TestSpec,
    type TestStep,
    testSpecSchema,
} from "../../src/agents/05-test-generator/test-spec";
import { validateTestContent } from "../../src/agents/05-test-generator/validation";

const VALID: TestSpec = {
    title: "Send money to an external business",
    description: "Verify sending money to an external business deducts it from checking.",
    intent: "Sending $500 to an external business should reduce the checking balance by exactly that amount and record the transaction.",
    criticality: "critical",
    scenario: "standard",
    flow: "Funds Management",
    verification:
        "On the dashboard Overview tab, assert the Checking Account balance and the recipient in Recent Transactions",
    setup: "The user is on the Dashboard page with the Overview tab active.",
    steps: [
        { verb: "click", description: 'the "Send" button', location: "in the Checking Account card" },
        { verb: "type", description: '"Acme Corp" into the Recipient Name field', location: "in the modal" },
        { verb: "click", description: 'the "Send Money" button', location: "in the modal footer" },
        { verb: "assert", description: 'text "Transfer Successful"', location: "in the toast notification" },
    ],
    verificationSteps: [{ verb: "assert", description: 'text "$11,950.50"', location: "in the Checking Account card" }],
    expectedResult: "The checking balance drops by $500 and Acme Corp appears in Recent Transactions.",
};

/**
 * The spec with a different step list. Typed `unknown` on purpose: several cases
 * assert that the SCHEMA rejects a shape, and a typed helper would make those
 * unwritable - the compile error would stand in for the runtime guarantee that
 * actually protects us, since the model's output is never compile-checked.
 */
function withSteps(steps: unknown): unknown {
    return { ...VALID, steps };
}

describe("testSpecSchema", () => {
    it("accepts a well-formed spec", () => {
        expect(testSpecSchema.safeParse(VALID).success).toBe(true);
    });

    it("rejects an assert step with no location", () => {
        const result = testSpecSchema.safeParse(
            withSteps([...VALID.steps.slice(0, 3), { verb: "assert", description: 'text "Transfer Successful"' }]),
        );

        expect(result.success).toBe(false);
        expect(JSON.stringify(result.error?.issues)).toContain("location");
    });

    it("requires a location on click and type too, not just assert", () => {
        // A label is routinely reused - a header button and the modal button it
        // opens - so naming the element is not enough to identify it.
        for (const step of [
            { verb: "click", description: 'the "Add Funds" button' },
            { verb: "type", description: '"500" into the Amount field' },
        ]) {
            const result = testSpecSchema.safeParse(
                withSteps([step, { verb: "click", description: 'the "Save" button', location: "in the modal" }]),
            );
            expect(result.success, JSON.stringify(step)).toBe(false);
        }
    });

    it("does not require a location on verbs that act on the page", () => {
        const result = testSpecSchema.safeParse(
            withSteps([
                { verb: "click", description: 'the "Send" button', location: "in the Checking Account card" },
                { verb: "type", description: '"Acme Corp" into the Recipient field', location: "in the modal" },
                { verb: "scroll", description: "to the bottom of the transactions list" },
                { verb: "refresh", description: "the page" },
                { verb: "assert", description: 'text "Done"', location: "in the modal" },
            ]),
        );

        expect(result.success).toBe(true);
    });

    it("rejects placeholders, which nothing can resolve at run time", () => {
        for (const description of [
            'type: "{{user_email}}" into Email',
            "type: {email} into Email",
            "assert: Dynamic: an id",
        ]) {
            const result = testSpecSchema.safeParse(
                withSteps([
                    { verb: "type", description },
                    { verb: "click", description: 'the "Save" button' },
                ]),
            );
            expect(result.success, description).toBe(false);
        }
    });

    it("rejects a placeholder hidden in the location, which renders onto the same line", () => {
        const result = testSpecSchema.safeParse(
            withSteps([
                { verb: "click", description: 'the "Save" button', location: "in the {{modalName}} modal" },
                { verb: "type", description: '"Acme" into the Name field', location: "in the modal" },
            ]),
        );

        expect(result.success).toBe(false);
    });

    // The real residual, verbatim from the NetBird run: the placeholder gate scanned
    // steps but not the setup line, so five tests shipped a run-unique id in their
    // Setup navigation. The runner resolves no tokens in prose, so each navigates to a
    // literal broken URL at run time - the original bug's family, in the field the
    // step gate never covered.
    it("rejects a run-unique token in the setup, the field the step gate never scanned", () => {
        for (const setup of [
            "Navigate to the Peer details page for the peer with hostname 'server-prod-1' (ID 'peer-{{testRunShortId}}-2').",
            "Navigate to the SSH page for 'server-prod-1' (peer-{{testRunShortId}}-2) by appending query parameters peerId=peer-{{testRunShortId}}-2, username=admin, and port=22 to the /peer/ssh route.",
            "Navigate to the User Details page for 'Charlie User' (id: 'usr-{{testRunShortId}}-user') by going to '/team/user?id=usr-{{testRunShortId}}-user'.",
            "Navigate to the User Details page for 'Deploy Service' (id: 'usr-{{testRunShortId}}-service') by going to '/team/user?id=usr-{{testRunShortId}}-service&service_user=true'.",
            "Navigate to the invite page using the token for Dave Developer (inv-{{testRunShortId}}-1).",
        ]) {
            const result = testSpecSchema.safeParse({ ...VALID, setup });
            expect(result.success, setup).toBe(false);
            expect(JSON.stringify(result.error?.issues), setup).toContain("setup");
        }
    });

    it("rejects an unresolvable token in any shipped prose field, not just steps", () => {
        const cases: { patch: Partial<TestSpec>; field: string }[] = [
            { patch: { title: "Rename peer usr-{{testRunShortId}}-user" }, field: "title" },
            {
                patch: { description: "Verify the {{testRunShortId}} account can rename a peer." },
                field: "description",
            },
            {
                patch: {
                    intent: "Renaming the peer for account acc-{{testRunShortId}} should persist the new name across a page reload and record it.",
                },
                field: "intent",
            },
            {
                patch: {
                    verification:
                        "On the Peers page, assert the row for id peer-{{testRunShortId}}-2 shows the new name after a refresh.",
                },
                field: "verification",
            },
            {
                patch: { expectedResult: "The peer usr-{{testRunShortId}}-user is renamed and the change persists." },
                field: "expectedResult",
            },
        ];

        for (const { patch, field } of cases) {
            const result = testSpecSchema.safeParse({ ...VALID, ...patch });
            expect(result.success, field).toBe(false);
            expect(JSON.stringify(result.error?.issues), field).toContain(field);
        }
    });

    it("accepts a setup that navigates by a stable on-screen name instead of a token-bearing id", () => {
        // The corrected shape of the five rejected setups above.
        const result = testSpecSchema.safeParse({
            ...VALID,
            setup: "The user is on the User Details page for 'Charlie User', reached from the Team > Users table.",
        });

        expect(result.success).toBe(true);
    });

    // False-positive guard: "e.g." is a step-only concreteness rule. Descriptive
    // prose may use it, and gating it here would revive the 680-retry misfire the
    // step comment warns about.
    it('does not reject a legitimate "e.g." in a descriptive prose field', () => {
        for (const patch of [
            {
                intent: "Filtering the peers list by an OS, e.g. Linux, should narrow the table to only matching rows and update the count.",
            },
            {
                verification:
                    "On the Peers page, assert the count reflects the filter, e.g. it shows fewer rows than before.",
            },
        ]) {
            expect(testSpecSchema.safeParse({ ...VALID, ...patch }).success, JSON.stringify(patch)).toBe(true);
        }
    });

    it('still rejects "e.g." in a step, the concreteness rule that stays step-scoped', () => {
        const result = testSpecSchema.safeParse(
            withSteps([
                { verb: "type", description: 'a plan name, e.g. "Pro"', location: "in the field" },
                { verb: "click", description: 'the "Save" button', location: "in the modal" },
            ]),
        );

        expect(result.success).toBe(false);
    });

    // The real bug, verbatim: the model copied the location guidance into the
    // description of every step of five journey files, past every existing refine.
    it("rejects a step whose description quotes the field guidance", () => {
        const result = testSpecSchema.safeParse(
            withSteps([
                {
                    verb: "click",
                    description: 'text "Financial Analyst" and acting on the wrong one fails confusingly',
                    location: "on the agent card",
                },
                { verb: "click", description: 'the "Save" button', location: "in the modal" },
            ]),
        );

        expect(result.success).toBe(false);
    });

    // Cross-field: the location quoting the description field's guidance. Both
    // fields are checked against all step guidance, since the real leak crossed.
    it("rejects guidance quoted into the location too, which renders onto the same line", () => {
        const result = testSpecSchema.safeParse(
            withSteps([
                {
                    verb: "assert",
                    description: 'text "Saved"',
                    location: "in the toast; the verb is prepended automatically, so do not start this with the verb",
                },
                { verb: "click", description: 'the "Save" button', location: "in the modal" },
            ]),
        );

        expect(result.success).toBe(false);
    });

    // False-positive guard: a long specific location and a parenthetical
    // description are normal test text, not quoted guidance.
    it("accepts a long location and a parenthetical description", () => {
        const result = testSpecSchema.safeParse(
            withSteps([
                {
                    verb: "click",
                    description: 'the "Buy" button (the primary call-to-action, not the wishlist heart icon)',
                    location: "on the product card in the search results grid below the promotional banner",
                },
                { verb: "assert", description: 'text "Added to cart"', location: "in the mini-cart flyout" },
            ]),
        );

        expect(result.success).toBe(true);
    });

    it("rejects a verb that does not exist", () => {
        const result = testSpecSchema.safeParse(
            withSteps([
                { verb: "wait", description: "2 seconds" },
                { verb: "click", description: 'the "Save" button' },
            ]),
        );

        expect(result.success).toBe(false);
    });

    it("accepts a single-interaction test (the interaction count is not a schema gate)", () => {
        // The old schema rejected anything under two interactions, which killed the
        // canonical single-drag test (drag, refresh, assert persisted) and the
        // filter-done-right test (one type, assert the list narrowed) while letting
        // shallow two-click toggles through. Depth is judged by the review rubric,
        // not counted here: a single real action verified at a source of truth is a
        // valid test the schema must accept.
        const singleDrag = testSpecSchema.safeParse(
            withSteps([
                { verb: "assert", description: 'the "Ship it" card', location: "in the To Do column" },
                { verb: "drag", description: 'the "Ship it" card to the Done column', location: "on the board" },
                { verb: "refresh", description: "the page" },
                { verb: "assert", description: 'the "Ship it" card', location: "in the Done column" },
            ]),
        );
        expect(singleDrag.success).toBe(true);
    });

    it("accepts any setup that says where the user is, including a login page", () => {
        // Whether a setup authenticates is a question about meaning, so the review
        // rubrics answer it. The schema deliberately does not: a pattern that tried
        // rejected "the user is on the login page" and cost a run 680 retries.
        // The login node's own tests start on that page and must be able to say so.
        // Rejecting the noun made one model retry the same setup 680 times and
        // finish the run with zero tests.
        for (const setup of [
            "The user is on the Dashboard page with the Overview tab active.",
            "The user is on the login page at /login.",
            "The user is on the sign-in screen.",
            "The user is on the Settings page; the login form is not shown.",
            "The user is already authenticated and on the Overview tab.",
        ]) {
            expect(testSpecSchema.safeParse({ ...VALID, setup }).success, setup).toBe(true);
        }
    });

    it("accepts optional notes", () => {
        const result = testSpecSchema.safeParse({ ...VALID, notes: "Could not determine the toggle's default state." });

        expect(result.success).toBe(true);
    });

    // The persistence guidance (reload-and-re-assert after a persisted-record
    // mutation) lives in these field descriptions, so the model reads it when it
    // fills verification/verificationSteps. A description that silently loses the
    // reload instruction reopens the optimistic-update blind spot, so guard it.
    it("tells the model to reload and re-assert for persisted-record mutations", () => {
        for (const description of [
            testSpecSchema.shape.verification.description,
            testSpecSchema.shape.verificationSteps.description,
        ]) {
            expect(description).toMatch(/refresh|reload/i);
            expect(description).toMatch(/persist/i);
        }
    });

    // Regression for the real-time loophole: a canonical create-in-list slipped past
    // the reviewer because the list updated via a subscription, and the reviewer read
    // that as the ephemeral/real-time exemption. Real-time rendering is not proof of a
    // backend write, so the rubric must keep saying so explicitly - if this guidance is
    // dropped, "looks saved but wasn't" creates go unflagged again. The rule is
    // abstract on purpose (no framework or component names).
    it("keeps the rubric stating real-time / optimistic updates are not proof of persistence", () => {
        const prompt = flowCompletenessRubric.systemPrompt;

        expect(prompt).toMatch(/real-time|realtime|optimistic/i);
        expect(prompt).toMatch(/not proof of persistence|not proof the write persisted|does not waive/i);
    });

    // Regression for the sign-out over-fire: the strengthened persistence rule began
    // treating session revocation as a persisted-record mutation and demanding a
    // reload. Auth/session state is not a data record - its confirmation is the
    // auth-state screen or the protected-route redirect - so the rubric must keep
    // exempting it, or sign-out tests fail for lacking a reload they never needed.
    it("keeps the rubric exempting auth/session state (sign-out) from the reload rule", () => {
        const prompt = flowCompletenessRubric.systemPrompt;

        expect(prompt).toMatch(/sign-out|session revocation/i);
        expect(prompt).toMatch(/data record/i);
    });

    // A CRUD test whose verification steps reload and re-assert must still parse -
    // the reload is expressed with the existing `refresh` verb, no new shape.
    it("accepts a create verified by a refresh followed by a re-assert", () => {
        const result = testSpecSchema.safeParse({
            ...VALID,
            verificationSteps: [
                { verb: "refresh", description: "the page" },
                { verb: "assert", description: 'the "Acme Corp" row', location: "in the recipients table" },
            ],
        });

        expect(result.success).toBe(true);
    });
});

describe("renderTestMarkdown", () => {
    it("produces markdown the on-disk validator accepts", () => {
        expect(validateTestContent(renderTestMarkdown(VALID))).toEqual({ valid: true, errors: [] });
    });

    it("appends each step's location to its line", () => {
        expect(renderTestMarkdown(VALID)).toContain('4. assert: text "Transfer Successful" in the toast notification');
    });

    it("is deterministic - the same spec always renders byte-identically", () => {
        expect(renderTestMarkdown(VALID)).toBe(renderTestMarkdown(VALID));
    });

    it("never leaks notes into the shipped file", () => {
        const rendered = renderTestMarkdown({ ...VALID, notes: "SECRET-INTERNAL-CAVEAT" });

        expect(rendered).not.toContain("SECRET-INTERNAL-CAVEAT");
        expect(rendered).not.toContain("notes");
    });

    it("omits the Verification section when there are no verification steps", () => {
        expect(renderTestMarkdown({ ...VALID, verificationSteps: [] })).not.toContain("**Verification**");
    });

    // The verb is rendered once as the marker. When the model also puts the verb
    // inside `description` ("assert: X", "click the button"), the naive render
    // repeated it - `1. assert: assert: ...` - which is malformed against the
    // `N. verb: target` contract the downstream platform parses. A real-app eval
    // found this in 40-77% of generated files across three runs.
    it("strips a leading copy of the step's own verb so the marker is never doubled", () => {
        const cases: { step: TestStep; expectedLine: string }[] = [
            {
                step: { verb: "assert", description: 'assert: text "Saved"', location: "in the toast" },
                expectedLine: '1. assert: text "Saved" in the toast',
            },
            {
                step: { verb: "assert", description: 'assert text "Saved"', location: "in the toast" },
                expectedLine: '1. assert: text "Saved" in the toast',
            },
            {
                step: { verb: "click", description: "click the button", location: "in the modal footer" },
                expectedLine: "1. click: the button in the modal footer",
            },
            {
                step: { verb: "type", description: 'type: "Acme" into Name', location: "in the modal" },
                expectedLine: '1. type: "Acme" into Name in the modal',
            },
        ];

        for (const { step, expectedLine } of cases) {
            const rendered = renderTestMarkdown({ ...VALID, steps: [step], verificationSteps: [] });
            expect(rendered, JSON.stringify(step)).toContain(expectedLine);
            expect(rendered, JSON.stringify(step)).not.toMatch(
                /\d+\.\s+(?:assert|click|type):\s+(?:assert|click|type):/,
            );
        }
    });

    it("leaves a description that only happens to contain or resemble a verb untouched", () => {
        const cases: { step: TestStep; expectedLine: string }[] = [
            {
                // "Refresh" is a legitimate word inside an assert, not this step's verb.
                step: { verb: "assert", description: "the Refresh button is visible", location: "in the header" },
                expectedLine: "1. assert: the Refresh button is visible in the header",
            },
            {
                // "typescript" starts with "type" but is not the verb - word boundary protects it.
                step: { verb: "type", description: '"typescript" into the search box', location: "in the toolbar" },
                expectedLine: '1. type: "typescript" into the search box in the toolbar',
            },
        ];

        for (const { step, expectedLine } of cases) {
            const rendered = renderTestMarkdown({ ...VALID, steps: [step], verificationSteps: [] });
            expect(rendered, JSON.stringify(step)).toContain(expectedLine);
        }
    });
});

describe("validateTestContent", () => {
    // Regression for the steps-marker slice: when "**Steps**" is absent, indexOf
    // returns -1, and the old `|| 0` sliced the body to its last character and
    // scanned nothing - so a "Dynamic:" placeholder slipped through unflagged.
    it('flags a "Dynamic:" placeholder even when the "**Steps**" header is absent', () => {
        const content = [
            "---",
            "verification: On the Overview tab, assert the balance changed at the source of truth",
            "---",
            "**Intent**: The balance should update.",
            "1. type: Dynamic: a generated id into the Name field",
        ].join("\n");

        expect(validateTestContent(content).errors).toContain('Contains "Dynamic:" placeholder in steps');
    });

    // Backstop for the render strip: even if a doubled marker were somehow written
    // to disk, the on-disk validator must reject it rather than let it ship to the
    // downstream parser.
    it("rejects a step line whose verb marker is doubled", () => {
        const content = [
            "---",
            "verification: On the Overview tab, assert the balance changed at the source of truth",
            "---",
            "**Intent**: The heading should appear.",
            "**Steps**:",
            '1. assert: assert: text "Saved" is visible in the toast',
        ].join("\n");

        const result = validateTestContent(content);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes("Doubled verb marker"))).toBe(true);
    });

    it("does not flag a normal single-marker step line", () => {
        const content = [
            "---",
            "verification: On the Overview tab, assert the balance changed at the source of truth",
            "---",
            "**Intent**: The heading should appear.",
            "**Steps**:",
            '1. assert: text "Saved" is visible in the toast',
        ].join("\n");

        expect(validateTestContent(content).errors).not.toContainEqual(expect.stringContaining("Doubled verb marker"));
    });

    // Independent of the schema: if a step that quotes the field guidance reaches
    // disk, this final sweep must catch it. It read one such file as valid once.
    it("rejects on-disk content whose step quotes the field guidance", () => {
        const content = [
            "---",
            "verification: On the Overview tab, assert the balance changed at the source of truth",
            "---",
            "**Intent**: The report should open.",
            "**Steps**:",
            '1. click: text "Financial Analyst" and acting on the wrong one fails confusingly on the agent card',
        ].join("\n");

        const result = validateTestContent(content);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes("quotes the field guidance"))).toBe(true);
    });

    it("does not flag a normal test rendered from a valid spec", () => {
        expect(validateTestContent(renderTestMarkdown(VALID)).errors).not.toContainEqual(
            expect.stringContaining("quotes the field guidance"),
        );
    });
});

// The guard is derived from the guidance the model is shown, so it cannot drift:
// whatever a field's description says, a value may not quote it back. These pin
// that property - the guard trips on the live guidance and clears real steps.
describe("echoesStepGuidance", () => {
    it("flags the guidance the model is shown", () => {
        expect(echoesStepGuidance(STEP_DESCRIPTION_GUIDANCE)).toBe(true);
        expect(echoesStepGuidance(STEP_LOCATION_GUIDANCE)).toBe(true);
    });

    it("clears real step text and short values", () => {
        expect(echoesStepGuidance('the "Send Money" button')).toBe(false);
        expect(echoesStepGuidance("in the toast notification")).toBe(false);
        expect(echoesStepGuidance("on the product card in the search results grid")).toBe(false);
        expect(echoesStepGuidance(undefined)).toBe(false);
    });
});

describe("buildTestSpecSchema flow enforcement", () => {
    const IDS: ReadonlySet<string> = new Set(["funds-management", "account-settings"]);

    it("accepts a flow id that is in the closed set", () => {
        const schema = buildTestSpecSchema(IDS);

        expect(schema.safeParse({ ...VALID, flow: "funds-management" }).success).toBe(true);
    });

    it("rejects a flow id outside the set and surfaces the valid ids", () => {
        const schema = buildTestSpecSchema(IDS);

        // The exact paraphrase the bug produced: a real flow's human name, not its id.
        const result = schema.safeParse({ ...VALID, flow: "Funds Management" });

        expect(result.success).toBe(false);
        const issues = JSON.stringify(result.error?.issues);
        expect(issues).toContain("funds-management");
        expect(issues).toContain("account-settings");
    });

    it("falls back to permissive when the set is empty or absent", () => {
        for (const schema of [buildTestSpecSchema(), buildTestSpecSchema(new Set())]) {
            expect(schema.safeParse({ ...VALID, flow: "Any Free Text At All" }).success).toBe(true);
        }
    });
});
