import { describe, expect, it } from "vitest";
import { trustedPreviewConfigSchema } from "../../src/config/schema";
import { enrichRepositoryShas } from "../../src/multirepo/enrich-repository-shas";

function buildConfig() {
    return trustedPreviewConfigSchema.parse({
        version: 2,
        apps: [
            { name: "web", repository: "acme/web", port: 3000 },
            { name: "api", repository: "acme/api", port: 4000 },
        ],
        repositories: [{ repo: "acme/api", fallback_branch: "develop" }],
    });
}

describe("enrichRepositoryShas", () => {
    it("stamps the deployed sha onto the matching authored entry, preserving its overrides", () => {
        const enriched = enrichRepositoryShas(buildConfig(), new Map([["acme/api", "api-sha"]]));

        expect(enriched.repositories).toEqual([{ repo: "acme/api", fallback_branch: "develop", sha: "api-sha" }]);
    });

    it("adds an entry with the default fallback_branch for a repo with no authored settings", () => {
        const enriched = enrichRepositoryShas(buildConfig(), new Map([["acme/worker", "worker-sha"]]));

        expect(enriched.repositories).toEqual([
            { repo: "acme/api", fallback_branch: "develop" },
            { repo: "acme/worker", fallback_branch: "main", sha: "worker-sha" },
        ]);
    });

    it("matches repo full names case-insensitively instead of duplicating the entry", () => {
        const enriched = enrichRepositoryShas(buildConfig(), new Map([["ACME/API", "api-sha"]]));

        expect(enriched.repositories).toEqual([{ repo: "acme/api", fallback_branch: "develop", sha: "api-sha" }]);
    });

    it("returns the config unchanged for an empty sha map", () => {
        const config = buildConfig();

        expect(enrichRepositoryShas(config, new Map())).toBe(config);
    });
});
