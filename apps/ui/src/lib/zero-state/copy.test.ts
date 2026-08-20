import { describe, expect, it } from "vitest";
import { SURFACE_COPY, WAITING_FOR_FIRST_PULL_REQUEST, ZERO_SURFACES } from "./copy";

/**
 * The voice rules for zero-state copy, enforced rather than documented.
 *
 * These are the ones a reviewer reliably misses because they are about a character or a phrase rather than about
 * meaning. The rules that actually matter - never claim a state that was not measured, name the event that ends
 * the wait - cannot be asserted here and stay a review question.
 */
describe("zero-state copy", () => {
    const everyString = ZERO_SURFACES.flatMap((surface) => {
        const { zero, empty } = SURFACE_COPY[surface];
        return [
            { surface, where: "zero.title", text: zero.title },
            { surface, where: "zero.description", text: zero.description ?? "" },
            { surface, where: "empty.title", text: empty.title },
            { surface, where: "empty.description", text: empty.description ?? "" },
            ...(zero.steps ?? []).flatMap((step, index) => [
                { surface, where: `zero.steps[${index}].label`, text: step.label },
                {
                    surface,
                    where: `zero.steps[${index}].detail`,
                    text: typeof step.detail === "string" ? step.detail : "",
                },
            ]),
        ];
    });

    it("gives every surface both readings", () => {
        for (const surface of ZERO_SURFACES) {
            expect(SURFACE_COPY[surface].zero.title, `${surface} zero.title`).not.toBe("");
            expect(SURFACE_COPY[surface].empty.title, `${surface} empty.title`).not.toBe("");
        }
    });

    it("uses no em dashes", () => {
        for (const { surface, where, text } of everyString) {
            expect(text, `${surface} ${where}`).not.toContain("—");
        }
    });

    it("does not shout or say 'Get started'", () => {
        for (const { surface, where, text } of everyString) {
            expect(text, `${surface} ${where}`).not.toMatch(/get started|let's|!/i);
        }
    });

    /**
     * The sidebar meter and the panels have to name this state identically, which is the whole reason the string
     * is exported rather than written twice.
     */
    it("keeps one name for the window before the first pull request", () => {
        expect(WAITING_FOR_FIRST_PULL_REQUEST).toBe("Waiting for your first pull request");
    });
});
