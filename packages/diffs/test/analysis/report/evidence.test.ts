import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvidenceManifestEntry } from "@autonoma/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    groundNarrative,
    resolvePrimaryScreenshot,
    validateSuspectedCause,
} from "../../../src/analysis/report/evidence";
import { Codebase } from "../../../src/codebase";
import type { RepoCheckout } from "../../../src/codebase";

function fetched(...assetIds: string[]): Map<string, EvidenceManifestEntry> {
    return new Map(assetIds.map((assetId) => [assetId, { assetId, s3Key: `s3/${assetId}`, kind: "screenshot" }]));
}

describe("groundNarrative", () => {
    it("keeps fetched evidence images and strips unfetched ones", () => {
        const markdown = "Bug. ![a](evidence:shot-a) and ![b](evidence:shot-b)";
        const { markdown: cleaned, manifest } = groundNarrative(markdown, fetched("shot-a"));

        expect(cleaned).toContain("evidence:shot-a");
        expect(cleaned).not.toContain("evidence:shot-b");
        expect(manifest.map((e) => e.assetId)).toEqual(["shot-a"]);
    });

    it("builds an empty manifest and leaves prose untouched when nothing is embedded", () => {
        const { markdown, manifest } = groundNarrative("Just prose, no images.", fetched("shot-a"));
        expect(markdown).toBe("Just prose, no images.");
        expect(manifest).toEqual([]);
    });

    it("strips a raw storage path masquerading as an image, never surfacing it", () => {
        const { markdown, manifest } = groundNarrative("![x](s3://bucket/secret.png)", fetched("shot-a"));
        expect(markdown).not.toContain("s3://bucket/secret.png");
        expect(manifest).toEqual([]);
    });
});

describe("resolvePrimaryScreenshot", () => {
    it("resolves a fetched asset to its storage key and bare pin coordinates", () => {
        const map = new Map<string, EvidenceManifestEntry>([
            ["shot-a", { assetId: "shot-a", s3Key: "s3/a", kind: "screenshot", pin: { x: 1, y: 2, role: "click" } }],
        ]);
        expect(resolvePrimaryScreenshot("shot-a", map)).toEqual({ s3Key: "s3/a", pin: { x: 1, y: 2 } });
    });

    it("drops an unfetched or absent reference", () => {
        expect(resolvePrimaryScreenshot("never-fetched", fetched("shot-a"))).toBeUndefined();
        expect(resolvePrimaryScreenshot(undefined, fetched("shot-a"))).toBeUndefined();
    });
});

describe("validateSuspectedCause", () => {
    let root: string;
    let codebase: Codebase;

    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), "reporter-evidence-"));
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "checkout.ts"), "export function total() {\n  return items.length;\n}\n");
        codebase = new Codebase(root);
    });

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it("keeps a reference whose snippet really appears in the repo", () => {
        const cause = validateSuspectedCause(
            {
                explanation: "off by one",
                codeReferences: [{ file: "src/checkout.ts", lines: "2", snippet: "return items.length;" }],
            },
            codebase,
        );
        expect(cause?.codeReferences).toHaveLength(1);
    });

    it("drops a reference whose snippet is fabricated, and the whole cause when none survive", () => {
        const cause = validateSuspectedCause(
            {
                explanation: "guessed",
                codeReferences: [{ file: "src/checkout.ts", lines: "2", snippet: "return items.length - 1;" }],
            },
            codebase,
        );
        expect(cause).toBeUndefined();
    });

    it("keeps the real reference and drops the fabricated one from a mixed set", () => {
        const cause = validateSuspectedCause(
            {
                explanation: "mixed",
                codeReferences: [
                    { file: "src/checkout.ts", lines: "2", snippet: "return items.length;" },
                    { file: "src/checkout.ts", lines: "9", snippet: "throw new Error('nope');" },
                ],
            },
            codebase,
        );
        expect(cause?.codeReferences).toHaveLength(1);
        expect(cause?.codeReferences[0]?.snippet).toBe("return items.length;");
    });

    it("drops a reference to a file outside the repo (traversal) or one that does not exist", () => {
        const traversal = validateSuspectedCause(
            { explanation: "escape", codeReferences: [{ file: "../../../etc/passwd", snippet: "root:" }] },
            codebase,
        );
        expect(traversal).toBeUndefined();

        const missing = validateSuspectedCause(
            { explanation: "missing", codeReferences: [{ file: "src/nope.ts", lines: "1" }] },
            codebase,
        );
        expect(missing).toBeUndefined();
    });
});

describe("validateSuspectedCause across a multi-repo workspace", () => {
    let workspaceRoot: string;
    let codebase: Codebase;

    beforeAll(() => {
        workspaceRoot = mkdtempSync(join(tmpdir(), "reporter-ws-"));
        const primaryDir = join(workspaceRoot, "acme__web");
        const depDir = join(workspaceRoot, "acme__api");
        mkdirSync(primaryDir, { recursive: true });
        mkdirSync(depDir, { recursive: true });
        writeFileSync(join(primaryDir, "app.ts"), "export const ui = 1;\n");
        writeFileSync(join(depDir, "pricing.ts"), "export const tax = 1.0;\n");

        const primary: RepoCheckout = {
            name: "acme/web",
            role: "primary",
            relPath: "acme__web",
            dir: primaryDir,
            headSha: "web-head",
            baseSha: "web-base",
        };
        const dep: RepoCheckout = {
            name: "acme/api",
            role: "dependency",
            relPath: "acme__api",
            dir: depDir,
            headSha: "api-head",
            baseSha: "api-base",
        };
        codebase = new Codebase(workspaceRoot, [primary, dep], []);
    });

    afterAll(() => rmSync(workspaceRoot, { recursive: true, force: true }));

    it("validates a dependency reference against that dependency's clone", () => {
        const cause = validateSuspectedCause(
            {
                explanation: "backend tax bug",
                codeReferences: [
                    { repo: "acme/api", file: "pricing.ts", lines: "1", snippet: "export const tax = 1.0;" },
                ],
            },
            codebase,
        );
        expect(cause?.codeReferences).toHaveLength(1);
    });

    it("validates an omitted-repo reference against the primary, and drops a ref pointing across repos", () => {
        // A primary ref (no repo) resolves to the primary clone; a ref that names the dependency but cites a file
        // that lives in the primary is dropped (it is validated against the dependency, where the file is absent).
        const cause = validateSuspectedCause(
            {
                explanation: "mixed repos",
                codeReferences: [
                    { file: "app.ts", snippet: "export const ui = 1;" },
                    { repo: "acme/api", file: "app.ts", snippet: "export const ui = 1;" },
                ],
            },
            codebase,
        );
        expect(cause?.codeReferences).toHaveLength(1);
        expect(cause?.codeReferences[0]?.repo).toBeUndefined();
    });

    it("drops a reference whose repo is not part of the checkout", () => {
        const cause = validateSuspectedCause(
            {
                explanation: "unknown repo",
                codeReferences: [{ repo: "acme/ghost", file: "pricing.ts", snippet: "export const tax = 1.0;" }],
            },
            codebase,
        );
        expect(cause).toBeUndefined();
    });
});
