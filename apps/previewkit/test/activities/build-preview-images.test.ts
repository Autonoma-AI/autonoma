import { CancelledFailure } from "@temporalio/activity";
import { MockActivityEnvironment } from "@temporalio/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The activity entrypoint pulls in heavy collaborators at module load (DB,
// k8s/AWS service factory, env). Stub them so the unit test exercises only the
// abort-vs-failure routing the activity adds on top of the pipeline.
vi.mock("@autonoma/db", () => ({ db: {}, Prisma: { DbNull: null } }));
vi.mock("../../src/db", () => ({ markBuildSuperseded: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/logger", () => ({
    logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
    extendObservabilityContext: vi.fn(),
}));

// Hoisted so the vi.mock factory (itself hoisted) can close over it.
const { buildMock } = vi.hoisted(() => ({ buildMock: vi.fn() }));
vi.mock("../../src/create-services", () => ({
    createPreviewkitServices: vi.fn().mockResolvedValue({ previewPipeline: { build: buildMock } }),
}));

import { buildPreviewImages } from "../../src/activities/index";

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

const input = {
    event: {
        action: "synchronize" as const,
        prNumber: 7,
        repoFullName: "acme/web",
        organizationId: "org_1",
        githubRepositoryId: 123,
        headSha: "abc1234def5678",
        headRef: "feature/login",
        baseSha: "",
        baseRef: "",
        cloneUrl: "https://github.com/acme/web.git",
    },
    namespace: "preview-acme-web-pr-7",
    configRevisionId: undefined,
};

describe("buildPreviewImages abort handling", () => {
    beforeEach(() => {
        buildMock.mockReset();
    });

    it("converts a build aborted by the cancellation signal into a CancelledFailure", async () => {
        const env = new MockActivityEnvironment();
        const started = deferred();
        // Mirror the real pipeline: when the signal fires, the buildctl spawn is
        // killed and the builder throws its own domain error (BuildAbortedError),
        // NOT a Temporal CancelledFailure.
        buildMock.mockImplementation(
            (_event: unknown, _ns: unknown, _rev: unknown, signal: AbortSignal) =>
                new Promise((_resolve, reject) => {
                    started.resolve();
                    signal.addEventListener("abort", () => reject(new Error("buildctl aborted (build cancelled)")));
                }),
        );

        const run = env.run(buildPreviewImages, input);
        await started.promise;
        env.cancel("superseded");

        // The workflow keys its supersede branch off isCancellation(), so the
        // activity must surface the abort as a CancelledFailure - otherwise the
        // workflow runs the failure finalizer and stamps the environment failed.
        await expect(run).rejects.toBeInstanceOf(CancelledFailure);
    });

    it("propagates a genuine build failure unchanged when the signal did not fire", async () => {
        const env = new MockActivityEnvironment();
        buildMock.mockRejectedValue(new Error("railpack exploded"));

        const run = env.run(buildPreviewImages, input);
        await expect(run).rejects.toThrow("railpack exploded");
        await expect(run).rejects.not.toBeInstanceOf(CancelledFailure);
    });
});
