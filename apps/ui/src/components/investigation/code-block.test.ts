import { describe, expect, it } from "vitest";
import { evidencePermalink, githubPermalink } from "./code-block";

describe("githubPermalink", () => {
    it("builds a blob permalink with a line anchor", () => {
        expect(githubPermalink("acme/web", "abc123", "src/app.ts", "42-58")).toBe(
            "https://github.com/acme/web/blob/abc123/src/app.ts#L42-L58",
        );
    });

    it("returns undefined without a repo, sha, or file", () => {
        expect(githubPermalink(undefined, "abc123", "src/app.ts", "1")).toBeUndefined();
        expect(githubPermalink("acme/web", undefined, "src/app.ts", "1")).toBeUndefined();
        expect(githubPermalink("acme/web", "abc123", undefined, "1")).toBeUndefined();
    });
});

describe("evidencePermalink", () => {
    const primaryRepo = "acme/web";
    const primarySha = "primary-sha";

    it("links a primary-repo reference (no repo set) to the primary repo + sha", () => {
        const link = evidencePermalink({ file: "src/app.ts", lines: "10" }, primaryRepo, primarySha);
        expect(link).toBe("https://github.com/acme/web/blob/primary-sha/src/app.ts#L10");
    });

    it("suppresses the link for a dependency reference so it never points at the wrong repo/sha", () => {
        // A dependency ref would otherwise resolve to acme/web/blob/<primary-sha>/pricing.ts - a file that does not
        // exist in the primary repo. Until the dependency's own pinned sha is threaded in, it must stay plain text.
        const link = evidencePermalink({ repo: "acme/api", file: "pricing.ts", lines: "1" }, primaryRepo, primarySha);
        expect(link).toBeUndefined();
    });
});
