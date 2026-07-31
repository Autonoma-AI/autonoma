import { describe, expect, it } from "vitest";
import { renderTestMarkdown, type TestSpec, testSpecSchema } from "../../src/agents/05-test-generator/test-spec";
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

    it("rejects a verb that does not exist", () => {
        const result = testSpecSchema.safeParse(
            withSteps([
                { verb: "wait", description: "2 seconds" },
                { verb: "click", description: 'the "Save" button' },
            ]),
        );

        expect(result.success).toBe(false);
    });

    it("rejects a visibility-only test", () => {
        const result = testSpecSchema.safeParse(
            withSteps([{ verb: "assert", description: 'text "Dashboard"', location: "as a page heading" }]),
        );

        expect(result.success).toBe(false);
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
});
