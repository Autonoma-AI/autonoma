import { diffChars, diffWordsWithSpace, structuredPatch, type StructuredPatchHunk } from "diff";

/**
 * Turns two versions of a text into a flat, renderable line model.
 *
 * The heavy lifting - building the patch, word-level intra-line diffing, and the
 * line-similarity math behind move detection - is delegated to `diff` (jsdiff).
 * What lives here is the policy layered on top: collapsing whitespace-only edits
 * and recognising relocated blocks. The output is a `DiffLine[]` that a renderer
 * maps to rows with a single exhaustive switch on `kind`.
 */

const DEFAULT_MIN_MOVED_BLOCK_LINES = 1;
const DEFAULT_NEAR_MATCH_THRESHOLD = 0.7;

/**
 * Context lines kept around each change by default. Large enough to render a
 * whole document as one hunk, which is what prose-sized inputs want; `slice`
 * clamps, so an oversized window costs nothing.
 */
const DEFAULT_CONTEXT_LINES = Number.MAX_SAFE_INTEGER;

/** A run of characters within a changed line, flagged if it is part of the edit. */
export interface InlineSegment {
    text: string;
    /** `true` for the added/removed characters; `false` for the shared context. */
    changed: boolean;
}

/** The `@@ ... @@` boundary between two hunks. */
export interface HunkLine {
    kind: "hunk";
    header: string;
    oldStart: number;
    newStart: number;
}

/** An unchanged line, present in both sides. */
export interface ContextLine {
    kind: "context";
    content: string;
    oldLine: number;
    newLine: number;
}

/** A line added by the patch. `segments` is set when it replaces a deleted line. */
export interface AddLine {
    kind: "add";
    content: string;
    newLine: number;
    segments?: InlineSegment[];
}

/** A line removed by the patch. `segments` is set when a new line replaces it. */
export interface DeleteLine {
    kind: "delete";
    content: string;
    oldLine: number;
    segments?: InlineSegment[];
}

/**
 * A line belonging to a block that was deleted in one place and re-added
 * verbatim in another. `direction` says which side this is; `blockId` pairs the
 * two sides of the same move.
 */
export interface MovedLine {
    kind: "moved";
    content: string;
    direction: "from" | "to";
    blockId: number;
    oldLine?: number;
    newLine?: number;
}

/**
 * Like {@link MovedLine}, but the relocated line carries a small edit, so it is
 * styled distinctly. `segments` highlights what changed between the two sides.
 */
export interface NearMatchLine {
    kind: "near-match";
    content: string;
    direction: "from" | "to";
    blockId: number;
    segments?: InlineSegment[];
    oldLine?: number;
    newLine?: number;
}

export type DiffLine = HunkLine | ContextLine | AddLine | DeleteLine | MovedLine | NearMatchLine;

export interface DiffOptions {
    /** Render a delete/add pair that differs only in whitespace as context. Default `true`. */
    collapseWhitespace?: boolean;
    /** Detect relocated blocks and near-matches. Default `true`. */
    detectMoves?: boolean;
    /** Minimum consecutive lines for a relocation to count as a move. Default `1`. */
    minMovedBlockLines?: number;
    /** Per-line similarity (0-1) above which a relocation is a near-match. Default `0.7`. */
    nearMatchThreshold?: number;
    /** Context lines to keep around each change. Defaults to the whole document. */
    context?: number;
}

/**
 * Diffs two whole versions of a text into a flat model of renderable lines. Pass
 * `""` for the side that does not exist to render a pure addition or deletion.
 */
export function parseSources(oldSource: string, newSource: string, options: DiffOptions = {}): DiffLine[] {
    const {
        collapseWhitespace = true,
        detectMoves = true,
        minMovedBlockLines = DEFAULT_MIN_MOVED_BLOCK_LINES,
        nearMatchThreshold = DEFAULT_NEAR_MATCH_THRESHOLD,
        context = DEFAULT_CONTEXT_LINES,
    } = options;

    const { hunks } = structuredPatch("old", "new", oldSource, newSource, "", "", { context });

    const lines: DiffLine[] = [];
    for (const hunk of hunks) {
        lines.push({
            kind: "hunk",
            header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
            oldStart: hunk.oldStart,
            newStart: hunk.newStart,
        });
        lines.push(...buildBlocks(classifyHunkLines(hunk), collapseWhitespace));
    }

    if (detectMoves) {
        detectMovedBlocks(lines, minMovedBlockLines, nearMatchThreshold);
    }

    return lines;
}

/** Intermediate, per-line classification before whitespace collapse and pairing. */
type RawLine =
    | { t: "context"; content: string; oldLine: number; newLine: number }
    | { t: "del"; content: string; oldLine: number }
    | { t: "add"; content: string; newLine: number };

function classifyHunkLines(hunk: StructuredPatchHunk): RawLine[] {
    const out: RawLine[] = [];
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;

    for (const line of hunk.lines) {
        const marker = line[0];
        const content = line.slice(1);
        switch (marker) {
            case "+":
                out.push({ t: "add", content, newLine: newLine++ });
                break;
            case "-":
                out.push({ t: "del", content, oldLine: oldLine++ });
                break;
            // "\" is jsdiff's "\ No newline at end of file" marker - not a real line.
            case "\\":
                break;
            default:
                out.push({ t: "context", content, oldLine: oldLine++, newLine: newLine++ });
        }
    }
    return out;
}

/**
 * Walks the classified lines, emitting context verbatim and resolving each run
 * of deletions/additions into a change block: whitespace-only pairs collapse to
 * context, genuine replacements gain word-level {@link InlineSegment}s, and the
 * conventional "all deletions then all additions" order is preserved.
 */
function buildBlocks(raw: RawLine[], collapseWhitespace: boolean): DiffLine[] {
    const out: DiffLine[] = [];
    let i = 0;

    while (i < raw.length) {
        const item = raw[i];
        if (item == null) break;
        if (item.t === "context") {
            out.push({
                kind: "context",
                content: item.content,
                oldLine: item.oldLine,
                newLine: item.newLine,
            });
            i++;
            continue;
        }

        const dels: Extract<RawLine, { t: "del" }>[] = [];
        const adds: Extract<RawLine, { t: "add" }>[] = [];
        while (i < raw.length) {
            const change = raw[i];
            if (change == null || change.t === "context") break;
            if (change.t === "del") dels.push(change);
            else adds.push(change);
            i++;
        }
        out.push(...resolveBlock(dels, adds, collapseWhitespace));
    }

    return out;
}

function resolveBlock(
    dels: Extract<RawLine, { t: "del" }>[],
    adds: Extract<RawLine, { t: "add" }>[],
    collapseWhitespace: boolean,
): DiffLine[] {
    const out: DiffLine[] = [];
    let pendingDels: DeleteLine[] = [];
    let pendingAdds: AddLine[] = [];

    // Deletes and adds within a run conventionally render grouped - all deletes,
    // then all adds. A whitespace-only pair collapses to an unchanged line, which
    // ends the current group: emitting it keeps gutter line numbers monotonic.
    const flush = () => {
        out.push(...pendingDels, ...pendingAdds);
        pendingDels = [];
        pendingAdds = [];
    };

    const paired = Math.min(dels.length, adds.length);
    for (let p = 0; p < paired; p++) {
        const del = dels[p];
        const add = adds[p];
        if (del == null || add == null) continue;
        // jsdiff sometimes emits a line as deleted and re-added verbatim to reach a
        // cheaper alignment; that pair is not an edit and must not render as one.
        const isNonChange =
            del.content === add.content || (collapseWhitespace && isWhitespaceOnlyChange(del.content, add.content));
        if (isNonChange) {
            flush();
            out.push({
                kind: "context",
                content: add.content,
                oldLine: del.oldLine,
                newLine: add.newLine,
            });
            continue;
        }
        const { removed, added } = inlineSegments(del.content, add.content);
        pendingDels.push({
            kind: "delete",
            content: del.content,
            oldLine: del.oldLine,
            segments: removed,
        });
        pendingAdds.push({ kind: "add", content: add.content, newLine: add.newLine, segments: added });
    }

    for (const del of dels.slice(paired)) {
        pendingDels.push({ kind: "delete", content: del.content, oldLine: del.oldLine });
    }
    for (const add of adds.slice(paired)) {
        pendingAdds.push({ kind: "add", content: add.content, newLine: add.newLine });
    }

    flush();
    return out;
}

/** True when two lines are identical once all whitespace is removed, but not byte-identical. */
function isWhitespaceOnlyChange(a: string, b: string): boolean {
    return a !== b && a.replace(/\s+/g, "") === b.replace(/\s+/g, "");
}

/**
 * Word-level diff of a replacement pair, split into the segments to highlight on
 * each side: removed words on the delete line, added words on the add line.
 *
 * Whitespace has to be significant here. `diffWords` ignores it, and reports a
 * whitespace-divergent common run using the *new* side's text - so the removed
 * segments would rejoin into a line that was never in the old source, and the
 * renderer would paint text the file does not contain.
 */
function inlineSegments(oldContent: string, newContent: string): { removed: InlineSegment[]; added: InlineSegment[] } {
    const parts = diffWordsWithSpace(oldContent, newContent);
    const removed: InlineSegment[] = [];
    const added: InlineSegment[] = [];
    for (const part of parts) {
        if (!part.added) removed.push({ text: part.value, changed: part.removed });
        if (!part.removed) added.push({ text: part.value, changed: part.added });
    }
    return { removed, added };
}

/** Fraction of characters shared between two strings, per a character-level diff. */
function similarity(a: string, b: string): number {
    if (a === b) return 1;
    let common = 0;
    let total = 0;
    for (const part of diffChars(a, b)) {
        total += part.value.length;
        if (!part.added && !part.removed) common += part.value.length;
    }
    return total === 0 ? 1 : common / total;
}

/**
 * A deletion or addition line: where it sits in the `lines` array, its content
 * and gutter number, and the change block it belongs to. The block id separates
 * relocations (different blocks) from ordinary in-place edits (a deletion
 * replaced by an addition in the same block), which must never look like moves.
 */
interface ChangeRef {
    index: number;
    content: string;
    lineNo: number;
    block: number;
}

/**
 * Finds blocks deleted in one place and re-added in another and rewrites them in
 * place - nothing is reordered. Two passes over the delete/add lines: exact
 * relocations first (-> `moved`), then near-matches on what is left (->
 * `near-match`), so an exact move is never stolen by a fuzzy one. Each pass walks
 * deletes left to right and claims the first matching add run of `minBlock`+
 * lines; runs are confined to a single block on each side, and the two sides must
 * differ, which is what keeps in-place edits from looking like moves.
 */
function detectMovedBlocks(lines: DiffLine[], minBlock: number, threshold: number): void {
    const dels: ChangeRef[] = [];
    const adds: ChangeRef[] = [];
    let block = 0;
    lines.forEach((line, index) => {
        if (line.kind === "delete") {
            dels.push({ index, content: line.content, lineNo: line.oldLine, block });
        } else if (line.kind === "add") {
            adds.push({ index, content: line.content, lineNo: line.newLine, block });
        } else {
            block++;
        }
    });

    const delUsed = dels.map(() => false);
    const addUsed = adds.map(() => false);
    let blockId = 0;

    /** How many consecutive lines from `from`/`to` pair up as one relocated run. */
    const runLength = (from: number, to: number, matches: (a: string, b: string) => boolean): number => {
        const delBlock = dels[from]?.block;
        const addBlock = adds[to]?.block;
        let len = 0;
        for (;;) {
            const del = dels[from + len];
            const add = adds[to + len];
            if (del == null || add == null) return len;
            if (delUsed[from + len] === true || addUsed[to + len] === true) return len;
            if (del.block !== delBlock || add.block !== addBlock) return len;
            if (!matches(del.content, add.content)) return len;
            len++;
        }
    };

    const markMoves = (matches: (a: string, b: string) => boolean, kind: "moved" | "near-match") => {
        for (let i = 0; i < dels.length; i++) {
            if (delUsed[i] === true) continue;
            for (let j = 0; j < adds.length; j++) {
                if (addUsed[j] === true || dels[i]?.block === adds[j]?.block) continue;
                const len = runLength(i, j, matches);
                if (len < minBlock) continue;
                const id = blockId++;
                for (let k = 0; k < len; k++) {
                    const from = dels[i + k];
                    const to = adds[j + k];
                    if (from == null || to == null) continue;
                    delUsed[i + k] = true;
                    addUsed[j + k] = true;
                    rewriteAsMove(lines, from, to, id, kind);
                }
                break;
            }
        }
    };

    markMoves((a, b) => a === b, "moved");
    markMoves((a, b) => similarity(a, b) >= threshold, "near-match");
}

/** Replaces a matched delete/add pair with its `moved`/`near-match` counterparts. */
function rewriteAsMove(
    lines: DiffLine[],
    from: ChangeRef,
    to: ChangeRef,
    blockId: number,
    kind: "moved" | "near-match",
): void {
    if (kind === "moved") {
        lines[from.index] = {
            kind,
            content: from.content,
            direction: "from",
            blockId,
            oldLine: from.lineNo,
        };
        lines[to.index] = {
            kind,
            content: to.content,
            direction: "to",
            blockId,
            newLine: to.lineNo,
        };
        return;
    }

    const { removed, added } = inlineSegments(from.content, to.content);
    lines[from.index] = {
        kind,
        content: from.content,
        direction: "from",
        blockId,
        segments: removed,
        oldLine: from.lineNo,
    };
    lines[to.index] = {
        kind,
        content: to.content,
        direction: "to",
        blockId,
        segments: added,
        newLine: to.lineNo,
    };
}
