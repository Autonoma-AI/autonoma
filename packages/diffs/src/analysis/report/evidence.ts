import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import {
    type CodeReference,
    type EvidenceManifestEntry,
    extractEvidenceAssetIds,
    type PrimaryScreenshot,
    stripUnbackedNarrativeImages,
    type SuspectedCause,
} from "@autonoma/types";

/**
 * Grounding-by-construction helpers for the Reporter, built analysis-native on the shared evidence-token grammar
 * (`@autonoma/types`) rather than the deprecated healing/bugs path. The two guarantees:
 *
 * - Image tokens: an `evidence:<assetId>` image survives only if the agent actually fetched that asset. Referenced
 *   ids not in the fetched allow-list are stripped from the prose and never enter the manifest.
 * - Code references: a `suspectedCause` file:line reference survives only if it matches the checked-out repo, so
 *   the free-form `bash` tool can never produce a fabricated reference that reaches persistence.
 */

/**
 * Strip any image whose evidence token was not fetched from `markdown`, and return the manifest of exactly the
 * assets the surviving prose references (referenced ∩ fetched, in first-seen order). Both the per-issue narratives
 * and the report prose pass through here at persist time.
 */
export function groundNarrative(
    markdown: string,
    fetched: ReadonlyMap<string, EvidenceManifestEntry>,
): { markdown: string; manifest: EvidenceManifestEntry[] } {
    const { markdown: cleaned } = stripUnbackedNarrativeImages(markdown, new Set(fetched.keys()));
    const manifest: EvidenceManifestEntry[] = [];
    for (const assetId of extractEvidenceAssetIds(cleaned)) {
        const entry = fetched.get(assetId);
        if (entry != null) manifest.push(entry);
    }
    return { markdown: cleaned, manifest };
}

/** Resolve a model-chosen `primaryScreenshotAssetId` to a concrete frame - only when that asset was fetched. */
export function resolvePrimaryScreenshot(
    assetId: string | undefined,
    fetched: ReadonlyMap<string, EvidenceManifestEntry>,
): PrimaryScreenshot | undefined {
    if (assetId == null) return undefined;
    const entry = fetched.get(assetId);
    if (entry == null) return undefined;
    // The manifest pin is an OverlayPoint (carries a `role`); a hero pin is bare coordinates, so map explicitly
    // rather than leak the extra field.
    return entry.pin != null ? { s3Key: entry.s3Key, pin: { x: entry.pin.x, y: entry.pin.y } } : { s3Key: entry.s3Key };
}

/**
 * Validate a `suspectedCause` against the checked-out repo, dropping every code reference whose file/lines/snippet
 * does not match, and dropping the whole cause when no reference survives (the schema requires at least one). This
 * is what keeps a `bash`-reading agent from persisting a fabricated file:line: the reference must point at code
 * that is really there.
 */
export function validateSuspectedCause(
    cause: SuspectedCause | undefined,
    codebaseRoot: string,
): SuspectedCause | undefined {
    if (cause == null) return undefined;

    const logger = rootLogger.child({ name: "validateSuspectedCause" });
    const survivors = cause.codeReferences.filter((ref) => isValidCodeReference(ref, codebaseRoot, logger));
    if (survivors.length === 0) {
        logger.warn("Dropping suspectedCause - no code reference validated against the repo", {
            extra: { references: cause.codeReferences.length },
        });
        return undefined;
    }
    return { explanation: cause.explanation, codeReferences: survivors };
}

/**
 * A reference is valid when its file is inside the repo and either its verbatim snippet is really present in that
 * file, or (with no snippet) its line range is within the file. A snippet that does not appear - a fabricated or
 * paraphrased excerpt - fails; a file outside the clone fails.
 */
function isValidCodeReference(ref: CodeReference, codebaseRoot: string, logger: Logger): boolean {
    const content = readRepoFile(codebaseRoot, ref.file);
    if (content == null) {
        logger.warn("Dropping code reference - file not readable inside the repo", { extra: { file: ref.file } });
        return false;
    }

    if (ref.snippet != null && ref.snippet.trim().length > 0) {
        const present = normalizeWhitespace(content).includes(normalizeWhitespace(ref.snippet));
        if (!present) {
            logger.warn("Dropping code reference - snippet not found in file", {
                extra: { file: ref.file, lines: ref.lines },
            });
        }
        return present;
    }

    if (ref.lines != null) {
        const withinFile = lineRangeWithinFile(ref.lines, content);
        if (!withinFile) {
            logger.warn("Dropping code reference - line range outside the file", {
                extra: { file: ref.file, lines: ref.lines },
            });
        }
        return withinFile;
    }

    return true;
}

/** Read a repo-relative file, refusing any path that escapes the clone root (traversal, absolute paths). */
function readRepoFile(codebaseRoot: string, file: string): string | undefined {
    if (isAbsolute(file)) return undefined;
    const resolved = resolve(codebaseRoot, file);
    const rel = relative(codebaseRoot, resolved);
    if (rel.startsWith("..")) return undefined;
    try {
        return readFileSync(resolved, "utf8");
    } catch {
        return undefined;
    }
}

/** Whether the (start of the) `N` or `N-M` range falls within the file's line count. */
function lineRangeWithinFile(lines: string, content: string): boolean {
    const start = Number.parseInt(lines.split("-")[0]?.trim() ?? "", 10);
    if (Number.isNaN(start) || start < 1) return false;
    return start <= content.split("\n").length;
}

/** Collapse all runs of whitespace to a single space so a copied snippet matches despite indentation drift. */
function normalizeWhitespace(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}
