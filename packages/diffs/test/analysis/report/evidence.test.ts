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

    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), "reporter-evidence-"));
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "checkout.ts"), "export function total() {\n  return items.length;\n}\n");
    });

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it("keeps a reference whose snippet really appears in the repo", () => {
        const cause = validateSuspectedCause(
            {
                explanation: "off by one",
                codeReferences: [{ file: "src/checkout.ts", lines: "2", snippet: "return items.length;" }],
            },
            root,
        );
        expect(cause?.codeReferences).toHaveLength(1);
    });

    it("drops a reference whose snippet is fabricated, and the whole cause when none survive", () => {
        const cause = validateSuspectedCause(
            {
                explanation: "guessed",
                codeReferences: [{ file: "src/checkout.ts", lines: "2", snippet: "return items.length - 1;" }],
            },
            root,
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
            root,
        );
        expect(cause?.codeReferences).toHaveLength(1);
        expect(cause?.codeReferences[0]?.snippet).toBe("return items.length;");
    });

    it("drops a reference to a file outside the repo (traversal) or one that does not exist", () => {
        const traversal = validateSuspectedCause(
            { explanation: "escape", codeReferences: [{ file: "../../../etc/passwd", snippet: "root:" }] },
            root,
        );
        expect(traversal).toBeUndefined();

        const missing = validateSuspectedCause(
            { explanation: "missing", codeReferences: [{ file: "src/nope.ts", lines: "1" }] },
            root,
        );
        expect(missing).toBeUndefined();
    });
});
