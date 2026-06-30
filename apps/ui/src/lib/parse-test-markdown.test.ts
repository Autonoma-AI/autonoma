import { describe, expect, it } from "vitest";
import { parseTestMarkdown } from "./parse-test-markdown";

const DESCRIPTION = "Logging in with valid credentials lands the user on the dashboard.";

describe("parseTestMarkdown", () => {
    it("returns the frontmatter description and the trimmed plan body", () => {
        const content = `---\nscenario: standard\ndescription: ${DESCRIPTION}\n---\n\nNavigate to /login and sign in\n`;

        expect(parseTestMarkdown(content)).toEqual({
            description: DESCRIPTION,
            plan: "Navigate to /login and sign in",
        });
    });

    it("throws when the file has no frontmatter block", () => {
        expect(() => parseTestMarkdown("Navigate to /login and sign in")).toThrow();
    });

    it("throws when the frontmatter omits a description", () => {
        expect(() => parseTestMarkdown("---\nscenario: standard\n---\n\nNavigate to /login")).toThrow();
    });

    it("throws when the description is shorter than the 20-char floor", () => {
        expect(() => parseTestMarkdown("---\ndescription: too short\n---\n\nNavigate to /login")).toThrow();
    });
});
