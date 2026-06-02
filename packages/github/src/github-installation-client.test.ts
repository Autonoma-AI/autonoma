import { describe, expect, it } from "vitest";
import { parseRepoFullName } from "./github-installation-client";

describe("parseRepoFullName", () => {
    it("accepts exactly owner/repo", () => {
        expect(parseRepoFullName("Autonoma-AI/agent")).toEqual({ owner: "Autonoma-AI", repo: "agent" });
    });

    it.each(["", "owner", "owner/", "/repo", "owner/repo/extra", "owner//repo"])(
        "rejects malformed repo full name %s",
        (repoFullName) => {
            expect(() => parseRepoFullName(repoFullName)).toThrow("Invalid repository fullName format");
        },
    );
});
