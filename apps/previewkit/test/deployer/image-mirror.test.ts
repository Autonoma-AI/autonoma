import { describe, expect, it } from "vitest";
import { mirrorDockerHubImage } from "../../src/deployer/image-mirror";

const MIRROR = "140023360995.dkr.ecr.us-east-1.amazonaws.com/docker-hub";

describe("mirrorDockerHubImage", () => {
    it("prefixes official images with the library/ namespace", () => {
        expect(mirrorDockerHubImage("postgres:16-alpine", MIRROR)).toBe(`${MIRROR}/library/postgres:16-alpine`);
        expect(mirrorDockerHubImage("nginx:alpine", MIRROR)).toBe(`${MIRROR}/library/nginx:alpine`);
    });

    it("keeps the namespace of namespaced Docker Hub images", () => {
        expect(mirrorDockerHubImage("valkey/valkey:8-alpine", MIRROR)).toBe(`${MIRROR}/valkey/valkey:8-alpine`);
        expect(mirrorDockerHubImage("moby/buildkit:v0.21.1", MIRROR)).toBe(`${MIRROR}/moby/buildkit:v0.21.1`);
    });

    it("mirrors references with an explicit Docker Hub host", () => {
        expect(mirrorDockerHubImage("docker.io/redis:7", MIRROR)).toBe(`${MIRROR}/library/redis:7`);
        expect(mirrorDockerHubImage("docker.io/temporalio/temporal:1.7.0", MIRROR)).toBe(
            `${MIRROR}/temporalio/temporal:1.7.0`,
        );
        expect(mirrorDockerHubImage("index.docker.io/library/mongo:7", MIRROR)).toBe(`${MIRROR}/library/mongo:7`);
    });

    it("leaves references on other registries untouched", () => {
        expect(mirrorDockerHubImage("ghcr.io/my-org/web:pr-42", MIRROR)).toBe("ghcr.io/my-org/web:pr-42");
        expect(mirrorDockerHubImage("quay.io/coreos/etcd:v3.5", MIRROR)).toBe("quay.io/coreos/etcd:v3.5");
        expect(mirrorDockerHubImage("localhost:5000/web:dev", MIRROR)).toBe("localhost:5000/web:dev");
        expect(mirrorDockerHubImage("registry.previewkit.svc.cluster.local:5000/web:abc", MIRROR)).toBe(
            "registry.previewkit.svc.cluster.local:5000/web:abc",
        );
    });

    it("is idempotent: an already-mirrored reference is not rewritten again", () => {
        const mirrored = mirrorDockerHubImage("postgres:16", MIRROR);
        expect(mirrorDockerHubImage(mirrored, MIRROR)).toBe(mirrored);
    });

    it("preserves digests and untagged references", () => {
        expect(mirrorDockerHubImage("postgres@sha256:deadbeef", MIRROR)).toBe(
            `${MIRROR}/library/postgres@sha256:deadbeef`,
        );
        expect(mirrorDockerHubImage("redis", MIRROR)).toBe(`${MIRROR}/library/redis`);
    });

    it("returns the reference unchanged when the mirror is disabled", () => {
        expect(mirrorDockerHubImage("postgres:16", "")).toBe("postgres:16");
    });
});
