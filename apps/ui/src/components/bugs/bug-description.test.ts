import { describe, expect, it } from "vitest";
import { normalizeBugDescriptionMarkdown } from "./bug-description";

describe("normalizeBugDescriptionMarkdown", () => {
    it("separates inline markdown sections emitted in bug descriptions", () => {
        const description =
            "The login flow rejected valid credentials. ## Affected files - frontend/app/api/auth/login.ts - frontend/app/api/allauthApi.ts ## Suggested fix Investigate password hashing.";

        expect(normalizeBugDescriptionMarkdown(description)).toBe(
            [
                "The login flow rejected valid credentials.",
                "## Affected files",
                "frontend/app/api/auth/login.ts - frontend/app/api/allauthApi.ts",
                "## Suggested fix",
                "Investigate password hashing.",
            ].join("\n\n"),
        );
    });
});
