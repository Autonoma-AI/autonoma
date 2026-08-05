import { describe, expect, it, vi } from "vitest";
import type { GitProvider } from "../../src/git-provider/git-provider";
import { resolveDependencyCheckout } from "../../src/multirepo/resolve-dependency-checkout";

/**
 * A structurally complete GitProvider whose only live method is
 * `getBranchHead` - the single method resolveDependencyCheckout touches.
 */
function buildProvider(getBranchHead: GitProvider["getBranchHead"]): GitProvider {
    const unused = () => Promise.reject(new Error("not used by resolveDependencyCheckout"));
    return {
        name: "github",
        getRepository: unused,
        getRepositoryByFullName: unused,
        getBranchHead,
        fetchRepoTarball: unused,
        postComment: unused,
        updateComment: unused,
        deleteComment: unused,
        setCommitStatus: unused,
        createDeployment: unused,
        createDeploymentStatus: unused,
    };
}

const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });

describe("resolveDependencyCheckout", () => {
    it("resolves the target branch to its head SHA when it exists", async () => {
        const getBranchHead = vi.fn().mockResolvedValue("abc123");

        const checkout = await resolveDependencyCheckout(buildProvider(getBranchHead), "acme/api", "feature-x", "main");

        expect(checkout).toEqual({ branch: "feature-x", sha: "abc123", usedFallback: false });
        expect(getBranchHead).toHaveBeenCalledExactlyOnceWith("acme/api", "feature-x");
    });

    it("falls back to the fallback branch when the target branch does not exist", async () => {
        const getBranchHead = vi.fn().mockRejectedValueOnce(notFound()).mockResolvedValueOnce("def456");

        const checkout = await resolveDependencyCheckout(buildProvider(getBranchHead), "acme/api", "feature-x", "main");

        expect(checkout).toEqual({ branch: "main", sha: "def456", usedFallback: true });
        expect(getBranchHead).toHaveBeenNthCalledWith(1, "acme/api", "feature-x");
        expect(getBranchHead).toHaveBeenNthCalledWith(2, "acme/api", "main");
    });

    it("returns undefined when neither the target nor the fallback branch resolves", async () => {
        const getBranchHead = vi.fn().mockRejectedValue(notFound());

        const checkout = await resolveDependencyCheckout(buildProvider(getBranchHead), "acme/api", "feature-x", "main");

        expect(checkout).toBeUndefined();
        expect(getBranchHead).toHaveBeenCalledTimes(2);
    });

    it("does not retry the fallback branch when it equals the missing target branch", async () => {
        const getBranchHead = vi.fn().mockRejectedValue(notFound());

        const checkout = await resolveDependencyCheckout(buildProvider(getBranchHead), "acme/api", "main", "main");

        expect(checkout).toBeUndefined();
        expect(getBranchHead).toHaveBeenCalledExactlyOnceWith("acme/api", "main");
    });
});
