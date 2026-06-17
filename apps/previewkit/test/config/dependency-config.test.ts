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

const fileYaml = ["version: 1", "apps:", "  - name: api-from-file", "    path: .", "    port: 5000"].join("\n");

interface ProviderOverrides {
    getRepositoryByFullName?: ReturnType<typeof vi.fn>;
    getBranchHead?: ReturnType<typeof vi.fn>;
    fetchFileContent?: ReturnType<typeof vi.fn>;
}

function buildProvider(overrides: ProviderOverrides = {}) {
    const stub = {
        getRepositoryByFullName: overrides.getRepositoryByFullName ?? vi.fn().mockResolvedValue(depRepo),
        getBranchHead: overrides.getBranchHead ?? vi.fn().mockResolvedValue("abc123"),
        fetchFileContent: overrides.fetchFileContent ?? vi.fn().mockResolvedValue(undefined),
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

    it("prefers the dependency Application's active DB revision over .preview.yaml", async () => {
        seedActiveRevision();
        const { provider, stub } = buildProvider();

        const resolved = await resolveDependencyConfig(provider, ORG_ID, DEP, "feature-x");

        expect(resolved).toMatchObject({
            source: "revision",
            revisionId: "rev_1",
            branch: "feature-x",
            usedFallback: false,
        });
        expect(resolved?.config.apps[0]?.name).toBe("api");
        expect(stub.fetchFileContent).not.toHaveBeenCalled();
    });

    it("falls back to the fallback branch when the target branch does not exist for a revision-sourced dep", async () => {
        seedActiveRevision();
        const getBranchHead = vi
            .fn()
            .mockRejectedValueOnce(Object.assign(new Error("Not Found"), { status: 404 }))
            .mockResolvedValueOnce("def456");
        const { provider } = buildProvider({ getBranchHead });

        const resolved = await resolveDependencyConfig(provider, ORG_ID, DEP, "feature-x");

        expect(resolved).toMatchObject({ source: "revision", branch: "main", usedFallback: true });
        expect(getBranchHead).toHaveBeenNthCalledWith(1, "acme/api", "feature-x");
        expect(getBranchHead).toHaveBeenNthCalledWith(2, "acme/api", "main");
    });

    it("skips a revision-sourced dep when neither the target nor the fallback branch exists", async () => {
        seedActiveRevision();
        const getBranchHead = vi.fn().mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
        const { provider } = buildProvider({ getBranchHead });

        const resolved = await resolveDependencyConfig(provider, ORG_ID, DEP, "feature-x");

        expect(resolved).toBeUndefined();
    });

    it("falls back to .preview.yaml when the dep repo has no Application in this org", async () => {
        const fetchFileContent = vi.fn().mockResolvedValue(fileYaml);
        const { provider } = buildProvider({ fetchFileContent });

        const resolved = await resolveDependencyConfig(provider, ORG_ID, DEP, "feature-x");

        expect(resolved).toMatchObject({ source: "file", branch: "feature-x", usedFallback: false });
        expect(resolved?.config.apps[0]?.name).toBe("api-from-file");
    });

    it("keeps the historical file semantics: missing file on the target branch falls back to the fallback branch", async () => {
        const fetchFileContent = vi
            .fn()
            .mockImplementation((_repo: string, _path: string, ref: string) =>
                Promise.resolve(ref === "main" ? fileYaml : undefined),
            );
        const { provider } = buildProvider({ fetchFileContent });

        const resolved = await resolveDependencyConfig(provider, ORG_ID, DEP, "feature-x");

        expect(resolved).toMatchObject({ source: "file", branch: "main", usedFallback: true });
    });

    it("returns undefined when neither a revision nor a .preview.yaml resolves", async () => {
        const { provider } = buildProvider();

        const resolved = await resolveDependencyConfig(provider, ORG_ID, DEP, "feature-x");

        expect(resolved).toBeUndefined();
    });

    it("degrades to the file path when the GitHub repo lookup fails", async () => {
        const getRepositoryByFullName = vi.fn().mockRejectedValue(new Error("boom"));
        const fetchFileContent = vi.fn().mockResolvedValue(fileYaml);
        const { provider } = buildProvider({ getRepositoryByFullName, fetchFileContent });

        const resolved = await resolveDependencyConfig(provider, ORG_ID, DEP, "feature-x");

        expect(resolved).toMatchObject({ source: "file", branch: "feature-x" });
        expect(dbMock.application.findUnique).not.toHaveBeenCalled();
    });
});
