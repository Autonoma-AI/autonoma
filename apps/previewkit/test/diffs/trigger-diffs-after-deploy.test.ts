import type { DeployPreviewEnvironmentOutput, PreviewDeployEvent } from "@autonoma/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../src/logger";

const { mockEnv, triggerPrDiffsJob, findOrgSettings } = vi.hoisted(() => ({
    mockEnv: { TEMPORAL_ADDRESS: undefined as string | undefined },
    triggerPrDiffsJob: vi.fn(),
    findOrgSettings: vi.fn(),
}));

vi.mock("../../src/env", () => ({ env: mockEnv }));
vi.mock("@autonoma/workflow", () => ({ triggerPrDiffsJob }));
vi.mock("@autonoma/db", () => ({ db: { organizationSettings: { findUnique: findOrgSettings } } }));

import { triggerDiffsAfterDeploy } from "../../src/diffs/trigger-diffs-after-deploy";

const testLogger = logger.child({ name: "trigger-diffs-after-deploy.test" });

function makeEvent(overrides: Partial<PreviewDeployEvent> = {}): PreviewDeployEvent {
    return {
        action: "opened",
        prNumber: 7,
        repoFullName: "acme/web",
        organizationId: "org_1",
        githubRepositoryId: 42,
        headSha: "head-sha",
        headRef: "feature/x",
        baseSha: "base-sha",
        baseRef: "main",
        cloneUrl: "https://github.com/acme/web.git",
        branchId: "branch_1",
        ...overrides,
    };
}

function makeResult(overrides: Partial<DeployPreviewEnvironmentOutput> = {}): DeployPreviewEnvironmentOutput {
    return {
        ready: true,
        readyCount: 1,
        totalCount: 1,
        urls: { web: "https://web.preview.example.com" },
        services: [],
        addons: [],
        warnings: [],
        primaryUrl: "https://web.preview.example.com",
        ...overrides,
    };
}

describe("triggerDiffsAfterDeploy", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockEnv.TEMPORAL_ADDRESS = "temporal.example.com:7233";
        findOrgSettings.mockResolvedValue({ previewkitAutoTriggerEnabled: true });
    });

    it("starts the diffs run workflow when the preview is ready", async () => {
        await triggerDiffsAfterDeploy(makeEvent(), makeResult(), testLogger);

        expect(triggerPrDiffsJob).toHaveBeenCalledTimes(1);
        expect(triggerPrDiffsJob).toHaveBeenCalledWith({
            organizationId: "org_1",
            branchId: "branch_1",
            headSha: "head-sha",
            baseSha: "base-sha",
            url: "https://web.preview.example.com",
        });
    });

    it("skips when Temporal is not configured (dev/self-host)", async () => {
        mockEnv.TEMPORAL_ADDRESS = undefined;
        await triggerDiffsAfterDeploy(makeEvent(), makeResult(), testLogger);
        expect(triggerPrDiffsJob).not.toHaveBeenCalled();
    });

    it("skips main-branch environments (PR 0)", async () => {
        await triggerDiffsAfterDeploy(makeEvent({ prNumber: 0 }), makeResult(), testLogger);
        expect(triggerPrDiffsJob).not.toHaveBeenCalled();
    });

    it("skips when the deploy event has no branchId (repo not onboarded)", async () => {
        await triggerDiffsAfterDeploy(makeEvent({ branchId: undefined }), makeResult(), testLogger);
        expect(triggerPrDiffsJob).not.toHaveBeenCalled();
    });

    it("skips when the environment is not fully ready", async () => {
        await triggerDiffsAfterDeploy(makeEvent(), makeResult({ ready: false }), testLogger);
        expect(triggerPrDiffsJob).not.toHaveBeenCalled();
    });

    it("skips when no primary url was resolved", async () => {
        await triggerDiffsAfterDeploy(makeEvent(), makeResult({ primaryUrl: undefined }), testLogger);
        expect(triggerPrDiffsJob).not.toHaveBeenCalled();
    });

    it("skips when PreviewKit auto-trigger is not enabled for the org", async () => {
        findOrgSettings.mockResolvedValue({ previewkitAutoTriggerEnabled: false });
        await triggerDiffsAfterDeploy(makeEvent(), makeResult(), testLogger);
        expect(triggerPrDiffsJob).not.toHaveBeenCalled();
    });

    it("skips when the org has no settings row", async () => {
        findOrgSettings.mockResolvedValue(null);
        await triggerDiffsAfterDeploy(makeEvent(), makeResult(), testLogger);
        expect(triggerPrDiffsJob).not.toHaveBeenCalled();
    });
});
