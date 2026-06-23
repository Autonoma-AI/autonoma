import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDependencyConfig } from "../../src/config/dependency-config";
import type { RepoDependency } from "../../src/config/schema";
import type { GitProvider } from "../../src/git-provider/git-provider";

const dbMock = vi.hoisted(() => ({
    application: {
        findUnique: vi.fn(),
    },
    previewkitConfigRevision: {
        findFirst: vi.fn(),
    },
}));

vi.mock("@autonoma/db", () => ({ db: dbMock }));

const ORG_ID = "org_1";
const DEP: RepoDependency = { name: "api", repo: "acme/api", fallback_branch: "main" };

const depRepo = {
    id: 456,
    name: "api",
    fullName: "acme/api",
    defaultBranch: "main",
    private: true,
};

const revisionDocument = {
    version: 1,
    apps: [{ name: "api", path: ".", port: 4000 }],
};

interface ProviderOverrides {
    getRepositoryByFullName?: ReturnType<typeof vi.fn>;
    getBranchHead?: ReturnType<typeof vi.fn>;
}

function buildProvider(overrides: ProviderOverrides = {}) {
    const stub = {
        getRepositoryByFullName: overrides.getRepositoryByFullName ?? vi.fn().mockResolvedValue(depRepo),
        getBranchHead: overrides.getBranchHead ?? vi.fn().mockResolvedValue("abc123"),
    };
    const provider: GitProvider = stub as unknown as GitProvider;
    return { provider, stub };
}

function seedActiveRevision() {
    dbMock.application.findUnique.mockImplementation((args: { where: Record<string, unknown> }) => {
        if ("organizationId_githubRepositoryId" in args.where) {
            return Promise.resolve({ id: "app_dep" });
        }
        return Promise.resolve({ activeConfigRevisionId: "rev_1" });
    });
    dbMock.previewkitConfigRevision.findFirst.mockResolvedValue({
        id: "rev_1",
        schemaVersion: 1,
        document: revisionDocument,
    });
}

describe("resolveDependencyConfig", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbMock.application.findUnique.mockResolvedValue(null);
        dbMock.previewkitConfigRevision.findFirst.mockResolvedValue(null);
    });

    it("resolves the dependency Application's active DB config revision", async () => {
        seedActiveRevision();
        const { provider } = buildProvider();

        const resolved = await resolveDependencyConfig(provider, ORG_ID, DEP, "feature-x");

        expect(resolved).toMatchObject({
            revisionId: "rev_1",
            branch: "feature-x",
            sha: "abc123",
            usedFallback: false,
        });
        expect(resolved?.config.apps[0]?.name).toBe("api");
    });

    it("falls back to the fallback branch when the target branch does not exist", async () => {
        seedActiveRevision();
        const getBranchHead = vi
            .fn()
            .mockRejectedValueOnce(Object.assign(new Error("Not Found"), { status: 404 }))
            .mockResolvedValueOnce("def456");
        const { provider } = buildProvider({ getBranchHead });

        const resolved = await resolveDependencyConfig(provider, ORG_ID, DEP, "feature-x");

        expect(resolved).toMatchObject({ branch: "main", sha: "def456", usedFallback: true });
        expect(getBranchHead).toHaveBeenNthCalledWith(1, "acme/api", "feature-x");
        expect(getBranchHead).toHaveBeenNthCalledWith(2, "acme/api", "main");
    });

    it("skips the dependency when neither the target nor the fallback branch exists", async () => {
        seedActiveRevision();
        const getBranchHead = vi.fn().mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
        const { provider } = buildProvider({ getBranchHead });

        const resolved = await resolveDependencyConfig(provider, ORG_ID, DEP, "feature-x");

        expect(resolved).toBeUndefined();
    });

    it("skips the dependency when the dep repo has no Application in this org", async () => {
        const { provider } = buildProvider();

        const resolved = await resolveDependencyConfig(provider, ORG_ID, DEP, "feature-x");

        expect(resolved).toBeUndefined();
    });

    it("skips the dependency when it has no active config revision", async () => {
        // Application exists but has no active revision pointer.
        dbMock.application.findUnique.mockImplementation((args: { where: Record<string, unknown> }) => {
            if ("organizationId_githubRepositoryId" in args.where) {
                return Promise.resolve({ id: "app_dep" });
            }
            return Promise.resolve({ activeConfigRevisionId: null });
        });
        const { provider } = buildProvider();

        const resolved = await resolveDependencyConfig(provider, ORG_ID, DEP, "feature-x");

        expect(resolved).toBeUndefined();
    });

    it("skips the dependency when the GitHub repo lookup fails", async () => {
        const getRepositoryByFullName = vi.fn().mockRejectedValue(new Error("boom"));
        const { provider } = buildProvider({ getRepositoryByFullName });

        const resolved = await resolveDependencyConfig(provider, ORG_ID, DEP, "feature-x");

        expect(resolved).toBeUndefined();
        expect(dbMock.application.findUnique).not.toHaveBeenCalled();
    });
});
