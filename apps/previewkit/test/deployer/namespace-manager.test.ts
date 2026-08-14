import { createHash } from "node:crypto";
import type * as k8s from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import { type GatekeeperRoute, NamespaceManager } from "../../src/deployer/namespace-manager";

// buildNamespaceName is a pure function; the constructor wires a CoreV1Api
// client we never call here. A no-op `makeApiClient` is enough to let the
// constructor succeed.
const stubKubeConfig = { makeApiClient: () => ({}) } as unknown as k8s.KubeConfig;
const manager = new NamespaceManager(stubKubeConfig);

// Independently mirrors the 16-hex-char hash buildNamespaceName appends, so
// expectations assert against a real sha256 digest rather than a
// hand-copied literal.
function hashOf(input: string): string {
    return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

describe("NamespaceManager.buildNamespaceName", () => {
    it("builds {owner}-{repo}-{N}-{hash} for simple owner/repo names", () => {
        // hash is sha256("acme/web#42").slice(0, 16)
        expect(manager.buildNamespaceName("acme/web", 42)).toBe("acme-web-42-8455b40d414fa88a");
    });

    it("lowercases mixed-case owners (regression: case-sensitive sanitize ate uppercase chars), hashing the original case", () => {
        // The readable prefix lowercases, but the hash is taken over the
        // ORIGINAL (unsanitized) repoFullName so it stays sensitive to case.
        expect(manager.buildNamespaceName("BigCorp/some-repo", 1516)).toBe("bigcorp-some-repo-1516-3aa72eb52833edd6");
    });

    it("preserves multi-segment repo names", () => {
        expect(manager.buildNamespaceName("acme-corp/multi-word-repo-name", 7)).toBe(
            "acme-corp-multi-word-repo-name-7-d61be2170861e4f5",
        );
    });

    it("replaces all non-alphanumerics (dots, underscores, slashes) with hyphens", () => {
        expect(manager.buildNamespaceName("acme.io/foo_bar.baz", 1)).toBe("acme-io-foo-bar-baz-1-76c8b7412cedb018");
    });

    it("collapses consecutive hyphens", () => {
        expect(manager.buildNamespaceName("a---b//c", 1)).toBe("a-b-c-1-d07f5de34620858a");
    });

    it("trims leading and trailing hyphens before assembling", () => {
        expect(manager.buildNamespaceName("-foo/bar-", 9)).toBe("foo-bar-9-b65b7c5a1130be36");
    });

    it("never truncates the -{N}-{hash} suffix, even for very long owner/repo combinations (Kubernetes DNS label limit)", () => {
        const result = manager.buildNamespaceName("acme-corporation-of-america/very-long-repository-name", 12345);
        expect(result.length).toBeLessThanOrEqual(63);
        expect(result.endsWith("-12345-" + hashOf("acme-corporation-of-america/very-long-repository-name#12345"))).toBe(
            true,
        );
    });

    it("strips a trailing hyphen left by a mid-segment truncation of the prefix", () => {
        // Pick a length that would slice exactly at a hyphen boundary if not
        // for the trailing-hyphen cleanup pass.
        const result = manager.buildNamespaceName("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbb/ccc", 7);
        expect(result.length).toBeLessThanOrEqual(63);
        expect(result.endsWith("-")).toBe(false);
        expect(result.endsWith("-7-" + hashOf("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbb/ccc#7"))).toBe(true);
    });

    it("produces a stable name for the same input (idempotent)", () => {
        const first = manager.buildNamespaceName("acme/web", 99);
        const second = manager.buildNamespaceName("acme/web", 99);
        expect(first).toBe(second);
    });

    it("gives two different (owner, repo) pairs that sanitize to the same readable prefix different namespaces (collision fix)", () => {
        // "foo/bar-baz" and "foo-bar/baz" both slug to the human-readable
        // prefix "foo-bar-baz" - under the old scheme (which sanitized the
        // whole "owner/repo" string as one opaque blob) these collided into
        // the identical namespace. The hash covers the exact, unsanitized
        // identity, so the two now produce different namespaces.
        const first = manager.buildNamespaceName("foo/bar-baz", 1);
        const second = manager.buildNamespaceName("foo-bar/baz", 1);
        expect(first.startsWith("foo-bar-baz-1-")).toBe(true);
        expect(second.startsWith("foo-bar-baz-1-")).toBe(true);
        expect(first).not.toBe(second);
    });

    it("output is always a valid RFC 1123 DNS label", () => {
        const dnsLabelRegex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
        const cases: Array<[string, number]> = [
            ["acme/web", 1],
            ["BigCorp/some-repo", 1516],
            ["acme.io/foo_bar.baz", 1],
            ["a---b//c", 1],
            ["UPPER/CASE", 42],
            ["acme-corporation-of-america/very-long-repository-name", 12345],
        ];

        for (const [repo, pr] of cases) {
            const name = manager.buildNamespaceName(repo, pr);
            expect(name).toMatch(dnsLabelRegex);
            expect(name.length).toBeLessThanOrEqual(63);
        }
    });
});

// Fake CoreV1Api capturing the replaceNamespace body, seeded with an existing
// namespace object the way readNamespace would return it.
function managerWithNamespace(existing: k8s.V1Namespace): {
    manager: NamespaceManager;
    replaced: () => k8s.V1Namespace | undefined;
} {
    let replacedBody: k8s.V1Namespace | undefined;
    const fakeCore = {
        readNamespace: () => Promise.resolve(structuredClone(existing)),
        replaceNamespace: ({ body }: { name: string; body: k8s.V1Namespace }) => {
            replacedBody = body;
            return Promise.resolve(body);
        },
    };
    const kc = { makeApiClient: () => fakeCore } as unknown as k8s.KubeConfig;
    return { manager: new NamespaceManager(kc), replaced: () => replacedBody };
}

describe("NamespaceManager.ensureGatekeeperManagement", () => {
    const routes: Record<string, GatekeeperRoute> = {
        "abc123def456.preview.autonoma.app": { service: "web", port: 3000 },
        "fed654cba321.preview.autonoma.app": { service: "api", port: 4000 },
    };

    it("labels the namespace for discovery and writes routes + idle-timeout annotations", async () => {
        const { manager, replaced } = managerWithNamespace({
            metadata: { name: "acme-web-42-8455b40d414fa88a" },
        });

        await manager.ensureGatekeeperManagement("acme-web-42-8455b40d414fa88a", routes, "45m");

        const ns = replaced();
        expect(ns?.metadata?.labels?.["gatekeeper.dev/managed"]).toBe("true");
        expect(ns?.metadata?.annotations?.["gatekeeper.dev/idle-timeout"]).toBe("45m");
        const written: unknown = JSON.parse(ns?.metadata?.annotations?.["gatekeeper.dev/routes"] ?? "{}");
        expect(written).toEqual(routes);
    });

    it("preserves existing labels and annotations (previewkit status metadata lives there too)", async () => {
        const { manager, replaced } = managerWithNamespace({
            metadata: {
                name: "acme-web-42-8455b40d414fa88a",
                labels: { "previewkit.dev/managed-by": "previewkit", "previewkit.dev/pr-number": "42" },
                annotations: {
                    "previewkit.dev/status": "deploying",
                    // A previous deploy's routes: must be overwritten, not merged.
                    "gatekeeper.dev/routes": JSON.stringify({ "old.host": { service: "gone", port: 1 } }),
                },
            },
        });

        await manager.ensureGatekeeperManagement("acme-web-42-8455b40d414fa88a", routes, "30m");

        const ns = replaced();
        expect(ns?.metadata?.labels?.["previewkit.dev/managed-by"]).toBe("previewkit");
        expect(ns?.metadata?.labels?.["previewkit.dev/pr-number"]).toBe("42");
        expect(ns?.metadata?.labels?.["gatekeeper.dev/managed"]).toBe("true");
        expect(ns?.metadata?.annotations?.["previewkit.dev/status"]).toBe("deploying");
        const written: unknown = JSON.parse(ns?.metadata?.annotations?.["gatekeeper.dev/routes"] ?? "{}");
        expect(written).toEqual(routes);
    });
});
