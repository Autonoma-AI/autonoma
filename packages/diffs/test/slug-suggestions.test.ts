import { describe, expect, it } from "vitest";
import { formatSlugNotFoundError, levenshteinDistance, suggestSimilarSlugs } from "../src/utils/slug-suggestions";

describe("levenshteinDistance", () => {
    it("returns 0 for identical strings", () => {
        expect(levenshteinDistance("hello", "hello")).toBe(0);
    });

    it("returns length of other string when one is empty", () => {
        expect(levenshteinDistance("", "hello")).toBe(5);
        expect(levenshteinDistance("hello", "")).toBe(5);
    });

    it("computes known distances correctly", () => {
        expect(levenshteinDistance("kitten", "sitting")).toBe(3);
        expect(levenshteinDistance("saturday", "sunday")).toBe(3);
    });

    it("handles single character differences", () => {
        expect(levenshteinDistance("cat", "bat")).toBe(1);
        expect(levenshteinDistance("cat", "cats")).toBe(1);
        expect(levenshteinDistance("cat", "at")).toBe(1);
    });
});

describe("suggestSimilarSlugs", () => {
    const validSlugs = [
        "login-flow",
        "checkout-flow",
        "settings-page",
        "user-profile",
        "dashboard-overview",
        "payment-method-add",
    ];

    it("suggests close matches for typos", () => {
        const suggestions = suggestSimilarSlugs("logn-flow", validSlugs);
        expect(suggestions[0]).toBe("login-flow");
    });

    it("suggests match when .md extension is appended", () => {
        const suggestions = suggestSimilarSlugs("login-flow.md", validSlugs);
        expect(suggestions).toContain("login-flow");
    });

    it("returns empty array when nothing is close", () => {
        const suggestions = suggestSimilarSlugs("completely-unrelated-very-long-string", validSlugs);
        expect(suggestions).toHaveLength(0);
    });

    it("returns at most maxSuggestions results", () => {
        const suggestions = suggestSimilarSlugs("flow", validSlugs, 2);
        expect(suggestions.length).toBeLessThanOrEqual(2);
    });

    it("sorts by distance ascending", () => {
        const suggestions = suggestSimilarSlugs("login-flo", validSlugs, 3);
        expect(suggestions[0]).toBe("login-flow");
    });
});

describe("formatSlugNotFoundError", () => {
    const validSlugs = ["login-flow", "checkout-flow", "settings-page"];

    it("includes invalid slug names and suggestions", () => {
        const error = formatSlugNotFoundError(["logn-flow"], validSlugs);
        expect(error).toContain("logn-flow");
        expect(error).toContain("login-flow");
        expect(error).toContain("Did you mean");
    });

    it("includes format reminder", () => {
        const error = formatSlugNotFoundError(["bad-slug"], validSlugs);
        expect(error).toContain("Do NOT use file paths");
        expect(error).toContain("Do NOT");
    });

    it("shows all valid slugs when list is small", () => {
        const error = formatSlugNotFoundError(["bad"], validSlugs);
        expect(error).toContain("All valid slugs");
        expect(error).toContain("login-flow");
        expect(error).toContain("checkout-flow");
        expect(error).toContain("settings-page");
    });

    it("does not show all slugs when list is large", () => {
        const largeSlugs = Array.from({ length: 25 }, (_, i) => `test-slug-${i}`);
        const error = formatSlugNotFoundError(["bad"], largeSlugs);
        expect(error).not.toContain("All valid slugs");
    });

    it("handles multiple invalid slugs", () => {
        const error = formatSlugNotFoundError(["logn-flow", "chekout-flow"], validSlugs);
        expect(error).toContain("logn-flow");
        expect(error).toContain("chekout-flow");
    });
});
