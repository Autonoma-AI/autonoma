import { describe, expect, it, vi } from "vitest";
import { resolveDependencyConfig } from "../../src/config/dependency-config";
import { resolveConfig } from "../../src/config/resolver";
import type { RepoDependency } from "../../src/config/schema";
import type { GitProvider } from "../../src/git-provider/git-provider";

const DEP: RepoDependency = { name: "api", repo: "acme/api", fallback_branch: "main" };

// The dependency config is owned by the primary app's revision and passed in -
// dependency repos are not separate Applications, so no DB lookup happens here.
const depConfig = resolveConfig({
    document: { version: 1, apps: [{ name: "api", path: ".", port: 4000 }] },
    allowCustomResources: true,
});

function buildProvider(getBranchHead?: ReturnType<typeof vi.fn>): GitProvider {
    const stub = { getBranchHead: getBranchHead ?? vi.fn().mockResolvedValue("abc123") };
    return stub as unknown as GitProvider;
}

describe("resolveDependencyConfig", () => {
    it("resolves the provided config at the target branch", async () => {
        const resolved = await resolveDependencyConfig(buildProvider(), DEP, "feature-x", depConfig);

        expect(resolved).toMatchObject({ branch: "feature-x", sha: "abc123", usedFallback: false });
        expect(resolved?.config.apps[0]?.name).toBe("api");
    });

    it("falls back to the fallback branch when the target branch does not exist", async () => {
        const getBranchHead = vi
            .fn()
            .mockRejectedValueOnce(Object.assign(new Error("Not Found"), { status: 404 }))
            .mockResolvedValueOnce("def456");

        const resolved = await resolveDependencyConfig(buildProvider(getBranchHead), DEP, "feature-x", depConfig);

        expect(resolved).toMatchObject({ branch: "main", sha: "def456", usedFallback: true });
        expect(getBranchHead).toHaveBeenNthCalledWith(1, "acme/api", "feature-x");
        expect(getBranchHead).toHaveBeenNthCalledWith(2, "acme/api", "main");
    });

    it("skips the dependency when neither the target nor the fallback branch exists", async () => {
        const getBranchHead = vi.fn().mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));

        const resolved = await resolveDependencyConfig(buildProvider(getBranchHead), DEP, "feature-x", depConfig);

        expect(resolved).toBeUndefined();
    });

    it("skips the dependency when the primary revision carries no config for it", async () => {
        const resolved = await resolveDependencyConfig(buildProvider(), DEP, "feature-x", undefined);

        expect(resolved).toBeUndefined();
    });
});
