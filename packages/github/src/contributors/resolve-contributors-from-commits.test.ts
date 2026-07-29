import { describe, expect, it } from "vitest";
import type { PullRequestCommit } from "../github-installation-client";
import { parseCoAuthoredByTrailers } from "./parse-co-authors";
import { contributorKey, isUnresolved, resolveContributorsFromCommits } from "./resolve-contributors-from-commits";

function commit(overrides: Partial<PullRequestCommit>): PullRequestCommit {
    return { sha: "sha", message: "", authorLogin: undefined, authoredAt: "", ...overrides };
}

describe("parseCoAuthoredByTrailers", () => {
    it("parses a single trailer", () => {
        const trailers = parseCoAuthoredByTrailers("fix: bug\n\nCo-authored-by: Bob Jones <bob@example.com>");
        expect(trailers).toEqual([{ name: "Bob Jones", email: "bob@example.com" }]);
    });

    it("parses multiple trailers case-insensitively and dedupes by email", () => {
        const message = [
            "feat: thing",
            "",
            "Co-authored-by: Bob <bob@example.com>",
            "co-authored-by: Dana <dana@example.com>",
            "CO-AUTHORED-BY: Bob Again <BOB@example.com>",
        ].join("\n");
        const trailers = parseCoAuthoredByTrailers(message);
        expect(trailers).toEqual([
            { name: "Bob", email: "bob@example.com" },
            { name: "Dana", email: "dana@example.com" },
        ]);
    });

    it("ignores prose that merely mentions the phrase mid-line", () => {
        const trailers = parseCoAuthoredByTrailers("This was co-authored-by nobody in particular <not-a-trailer>");
        expect(trailers).toEqual([]);
    });

    it("parses trailers on CRLF line endings without leaking the carriage return", () => {
        const message = "feat: thing\r\n\r\nCo-authored-by: Bob <bob@example.com>\r\n";
        expect(parseCoAuthoredByTrailers(message)).toEqual([{ name: "Bob", email: "bob@example.com" }]);
    });

    it("returns an empty array for a message with no trailers", () => {
        expect(parseCoAuthoredByTrailers("just a normal message")).toEqual([]);
    });
});

describe("resolveContributorsFromCommits", () => {
    it("returns opener, pushers, and co-authors deduped, with logins where resolvable", () => {
        const commits = [
            commit({ sha: "c1", authorLogin: "alice", message: "feat: a" }),
            commit({
                sha: "c2",
                authorLogin: "carol",
                message: "fix: b\n\nCo-authored-by: Bob <bob@example.com>",
            }),
        ];

        const contributors = resolveContributorsFromCommits(commits, { openerLogin: "alice" });

        const byLogin = new Map(contributors.filter((c) => c.login != null).map((c) => [c.login, c]));
        expect(byLogin.get("alice")).toMatchObject({ login: "alice", isOpener: true });
        expect(byLogin.get("carol")).toMatchObject({ login: "carol", isOpener: false });

        const bob = contributors.find((c) => c.email === "bob@example.com");
        expect(bob).toMatchObject({ displayName: "Bob", email: "bob@example.com" });
        expect(bob?.login).toBeUndefined();

        // alice appears as both a commit author and the opener - a single deduped row.
        expect(contributors).toHaveLength(3);
    });

    it("dedupes a login that authored multiple commits", () => {
        const commits = [
            commit({ sha: "c1", authorLogin: "alice", message: "one" }),
            commit({ sha: "c2", authorLogin: "alice", message: "two" }),
        ];
        const contributors = resolveContributorsFromCommits(commits);
        expect(contributors).toHaveLength(1);
        expect(contributors[0]).toMatchObject({ login: "alice", isOpener: false });
    });

    it("includes the opener even when they authored no commits", () => {
        const commits = [commit({ sha: "c1", authorLogin: "carol", message: "work" })];
        const contributors = resolveContributorsFromCommits(commits, { openerLogin: "alice" });
        expect(contributors.find((c) => c.login === "alice")).toMatchObject({ isOpener: true });
        expect(contributors.find((c) => c.login === "carol")).toMatchObject({ isOpener: false });
    });

    it("keeps a co-author unresolved when no matching commit login exists", () => {
        const commits = [commit({ sha: "c1", message: "solo\n\nCo-authored-by: Eve <eve@example.com>" })];
        const contributors = resolveContributorsFromCommits(commits);
        expect(contributors).toEqual([
            { login: undefined, displayName: "Eve", email: "eve@example.com", isOpener: false },
        ]);
        expect(contributors.map(isUnresolved)).toEqual([true]);
    });
});

describe("isUnresolved", () => {
    it("is true only when no login was resolved", () => {
        expect(isUnresolved({ login: "alice" })).toBe(false);
        expect(isUnresolved({})).toBe(true);
    });
});

describe("contributorKey", () => {
    it("prefers login, then email, then displayName, lowercased", () => {
        expect(contributorKey({ login: "Alice", email: "a@x.com" })).toBe("alice");
        expect(contributorKey({ email: "Bob@X.com", displayName: "Bob" })).toBe("bob@x.com");
        expect(contributorKey({ displayName: "Carol" })).toBe("carol");
    });

    it("throws when no identity is present", () => {
        expect(() => contributorKey({})).toThrow();
    });
});
