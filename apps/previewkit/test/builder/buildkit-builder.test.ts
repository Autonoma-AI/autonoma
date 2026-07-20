import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BuildError, type BuildRequest } from "../../src/builder/builder";
import { BuildKitBuilder, TRANSIENT_NETWORK_PATTERNS } from "../../src/builder/buildkit-builder";

class CountingJobManager {
    readonly releasedNames: string[] = [];
    provisionCount = 0;

    async provision(): Promise<{ name: string; host: string }> {
        this.provisionCount += 1;
        return { name: "buildkit-test", host: "tcp://10.40.0.20:1234" };
    }

    async release(instance: { name: string }): Promise<void> {
        this.releasedNames.push(instance.name);
    }
}

class ReleaseFailingJobManager {
    readonly releasedNames: string[] = [];

    async provision(): Promise<{ name: string; host: string }> {
        return {
            name: "buildkit-release-failure",
            get host(): string {
                throw new Error("original build failure");
            },
        };
    }

    async release(instance: { name: string }): Promise<void> {
        this.releasedNames.push(instance.name);
        throw new Error("control cluster temporarily unavailable");
    }
}

class RetryRecordingJobManager {
    readonly events: string[] = [];
    private provisionCount = 0;

    async provision(): Promise<{ name: string; host: string }> {
        this.provisionCount += 1;
        const attempt = this.provisionCount;
        this.events.push(`provision-${attempt}`);
        if (attempt === 1) {
            return {
                name: "buildkit-first",
                get host(): string {
                    throw new BuildError("buildkit connection refused", { isTransient: true });
                },
            };
        }
        return {
            name: "buildkit-second",
            get host(): string {
                throw new Error("deterministic build failure");
            },
        };
    }

    async release(instance: { name: string }): Promise<void> {
        this.events.push(`release-${instance.name === "buildkit-first" ? 1 : 2}`);
    }
}

class SuccessfulJobManager {
    readonly releasedNames: string[] = [];

    async provision(): Promise<{ name: string; host: string }> {
        return { name: "buildkit-success", host: "tcp://10.40.0.22:1234" };
    }

    async release(instance: { name: string }): Promise<void> {
        this.releasedNames.push(instance.name);
    }
}

describe("BuildKitBuilder", () => {
    it("does not provision buildkit infrastructure when local Dockerfile validation fails", async () => {
        const jobManager = new CountingJobManager();
        const builder = new BuildKitBuilder({
            jobManager,
            buildTimeoutMs: 5_000,
        });

        await expect(
            builder.build({
                appName: "web",
                contextPath: tmpdir(),
                dockerfile: "missing-previewkit-Dockerfile",
                buildArgs: {},
                imageTag: "registry.local:5000/acme/web:abc1234",
            }),
        ).rejects.toThrow("Specified Dockerfile not found");

        expect(jobManager.provisionCount).toBe(0);
        expect(jobManager.releasedNames).toEqual([]);
    });

    it("releases the per-attempt Job without masking the original build failure", async () => {
        const jobManager = new ReleaseFailingJobManager();
        const builder = new BuildKitBuilder({
            jobManager,
            buildTimeoutMs: 5_000,
        });

        await expect(
            builder.build({
                appName: "web",
                contextPath: tmpdir(),
                generatedDockerfile: "FROM scratch\n",
                buildArgs: {},
                imageTag: "registry.local:5000/acme/web:abc1234",
            }),
        ).rejects.toThrow("original build failure");

        expect(jobManager.releasedNames).toEqual(["buildkit-release-failure"]);
    });

    it("releases a failed transient Job before provisioning the retry", async () => {
        const jobManager = new RetryRecordingJobManager();
        const builder = new BuildKitBuilder({
            jobManager,
            buildTimeoutMs: 5_000,
            retryDelayMs: 0,
        });

        const error = await builder
            .build({
                appName: "web",
                contextPath: tmpdir(),
                generatedDockerfile: "FROM scratch\n",
                buildArgs: {},
                imageTag: "registry.local:5000/acme/web:abc1234",
            })
            .catch((err: unknown) => err);

        expect(error).toBeInstanceOf(Error);
        expect(jobManager.events).toEqual(["provision-1", "release-1", "provision-2", "release-2"]);
    });

    it("throws an actionable error when an app has neither a Dockerfile nor a build block", async () => {
        const tempDir = await mkdtemp(join(tmpdir(), "previewkit-no-build-test-"));
        const jobManager = new CountingJobManager();
        const builder = new BuildKitBuilder({
            jobManager,
            buildTimeoutMs: 5_000,
        });

        try {
            const error = await builder
                .build({
                    appName: "web",
                    contextPath: tempDir,
                    buildArgs: {},
                    imageTag: "registry.local:5000/acme/web:abc1234",
                })
                .catch((err: unknown) => err);

            expect(error).toBeInstanceOf(BuildError);
            expect(error).toHaveProperty("message", expect.stringContaining("no `build` block"));
            expect(jobManager.provisionCount).toBe(0);
            expect(jobManager.releasedNames).toEqual([]);
        } finally {
            await rm(tempDir, { recursive: true, force: true }).catch((err: unknown) => {
                console.warn("Failed to remove PreviewKit no-build test directory", err);
            });
        }
    });

    it("omits remote cache flags from every build strategy and releases each Job", async () => {
        const tempDir = await mkdtemp(join(tmpdir(), "previewkit-buildctl-test-"));
        const appDir = join(tempDir, "apps", "web");
        const binDir = join(tempDir, "bin");
        const buildctlPath = join(binDir, "buildctl");
        const capturedArgsPath = join(tempDir, "buildctl-args.txt");
        const previousPath = process.env.PATH;
        const previousCapturePath = process.env.PREVIEWKIT_CAPTURE_ARGS;

        try {
            await mkdir(binDir, { recursive: true });
            await mkdir(appDir, { recursive: true });
            await writeFile(join(tempDir, "Dockerfile"), "FROM scratch\n");
            await writeFile(
                join(appDir, "package.json"),
                JSON.stringify({ name: "web", scripts: { start: "node server.js" } }),
            );
            await writeFile(buildctlPath, '#!/bin/sh\nprintf "%s\\n" "$@" > "$PREVIEWKIT_CAPTURE_ARGS"\n');
            await chmod(buildctlPath, 0o755);
            process.env.PATH = `${binDir}:${previousPath ?? ""}`;
            process.env.PREVIEWKIT_CAPTURE_ARGS = capturedArgsPath;

            const jobManager = new SuccessfulJobManager();
            const builder = new BuildKitBuilder({
                jobManager,
                buildTimeoutMs: 5_000,
            });

            const imageTag = "registry.local:5000/acme/web:abc1234";
            const strategies: Array<{ name: string; request: BuildRequest }> = [
                {
                    name: "on-disk Dockerfile",
                    request: {
                        appName: "web",
                        contextPath: tempDir,
                        dockerfile: "Dockerfile",
                        buildArgs: {},
                        imageTag,
                    },
                },
                {
                    name: "generated Dockerfile",
                    request: {
                        appName: "web",
                        contextPath: appDir,
                        generatedDockerfile: "FROM scratch\n",
                        buildArgs: {},
                        imageTag,
                    },
                },
            ];

            for (const strategy of strategies) {
                const result = await builder.build(strategy.request);
                const capturedArgs = await readFile(capturedArgsPath, "utf8");

                expect(result.imageTag, strategy.name).toBe(imageTag);
                expect(capturedArgs, strategy.name).not.toContain("--import-cache");
                expect(capturedArgs, strategy.name).not.toContain("--export-cache");
                expect(capturedArgs, strategy.name).not.toContain("type=s3");
            }
            expect(jobManager.releasedNames).toEqual(
                Array.from({ length: strategies.length }, () => "buildkit-success"),
            );
        } finally {
            if (previousPath == null) delete process.env.PATH;
            else process.env.PATH = previousPath;
            if (previousCapturePath == null) delete process.env.PREVIEWKIT_CAPTURE_ARGS;
            else process.env.PREVIEWKIT_CAPTURE_ARGS = previousCapturePath;
            await rm(tempDir, { recursive: true, force: true }).catch((err: unknown) => {
                console.warn("Failed to remove PreviewKit builder test directory", err);
            });
        }
    });
});

/** Mirrors the check in BuildKitBuilder.exec: any pattern hit in the combined output tail marks the failure transient. */
function isTransient(outputTail: string): boolean {
    return TRANSIENT_NETWORK_PATTERNS.some((p) => p.test(outputTail));
}

describe("TRANSIENT_NETWORK_PATTERNS", () => {
    it("classifies session-loss errors from an unhealthy build pod as transient", () => {
        const sessionLossTails = [
            "error: failed to solve: no active session for p8vvbrjdbtxfam6jrbdj8bhbn: context deadline exceeded",
            "rpc error: code = Unknown desc = session healthcheck failed: rpc error: code = DeadlineExceeded desc = context deadline exceeded",
            "error: failed to solve: failed to get session: context deadline exceeded",
        ];
        for (const tail of sessionLossTails) {
            expect(isTransient(tail), tail).toBe(true);
        }
    });

    it("classifies pod-shutdown and connection errors as transient", () => {
        const connectionTails = [
            "buildkitd is shutting down: graceful_stop",
            "error: failed to solve: rpc error: code = Unavailable desc = error reading from server: EOF",
            "dial tcp 10.0.1.7:1234: connect: connection refused",
        ];
        for (const tail of connectionTails) {
            expect(isTransient(tail), tail).toBe(true);
        }
    });

    it("classifies pre-build worker-listing failures against an unhealthy build pod as transient", () => {
        // The daemon accepts the TCP connection then drops it before the gRPC
        // handshake (memory-ceilinged pod), so buildctl never lists its workers.
        // A retry provisions a fresh isolated buildkitd Job.
        const workerListingTails = [
            'error: listing workers for Build: failed to list workers: Unavailable: connection error: desc = "error reading server preface: read tcp 10.70.72.95:47158->10.70.73.221:1234: use of closed network connection"',
            "failed to list workers: Unavailable: connection error",
        ];
        for (const tail of workerListingTails) {
            expect(isTransient(tail), tail).toBe(true);
        }
    });

    it("does not treat a bare connection string in user build output as transient", () => {
        // The worker-listing signal is anchored on buildctl's own framing, not
        // the bare Go/gRPC connection strings, so a user's RUN step printing
        // "use of closed network connection" is never mislabeled a platform outage.
        expect(isTransient("RUN app log: write tcp: use of closed network connection")).toBe(false);
        expect(isTransient("error reading server preface (from the user's own grpc client)")).toBe(false);
    });

    it("does not classify a bare in-build deadline as transient", () => {
        // Without session/dial wording, "context deadline exceeded" can come from
        // a deterministic in-build timeout that a retry would only replay.
        expect(isTransient("error: failed to solve: process did not complete: context deadline exceeded")).toBe(false);
    });

    it("does not classify an ordinary build failure as transient", () => {
        const buildFailureTail =
            'error: failed to solve: process "/bin/sh -c pnpm build" did not complete successfully: exit code: 1';
        expect(isTransient(buildFailureTail)).toBe(false);
    });
});
