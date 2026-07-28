import { describe, expect, it } from "vitest";
import { type DiffLine, parseSources } from "./diff";

/** Drops hunk separators so assertions can focus on the line content. */
function bodyKinds(lines: DiffLine[]): DiffLine["kind"][] {
    return lines.filter((line) => line.kind !== "hunk").map((line) => line.kind);
}

/** The rendered content of every non-hunk line, in order. */
function bodyContent(lines: DiffLine[]): string[] {
    return lines.filter((line) => line.kind !== "hunk").map((line) => line.content);
}

describe("parseSources", () => {
    it("classifies context, additions, and deletions with line numbers", () => {
        const lines = parseSources("keep\nold\ntail", "keep\nnew\ntail", { detectMoves: false });

        expect(lines[0]).toMatchObject({ kind: "hunk", oldStart: 1, newStart: 1 });
        expect(lines[1]).toMatchObject({ kind: "context", content: "keep", oldLine: 1, newLine: 1 });
        expect(lines[2]).toMatchObject({ kind: "delete", content: "old", oldLine: 2 });
        expect(lines[3]).toMatchObject({ kind: "add", content: "new", newLine: 2 });
        expect(lines[4]).toMatchObject({ kind: "context", content: "tail", oldLine: 3, newLine: 3 });
    });

    it("renders an empty old side as a pure addition", () => {
        const lines = parseSources("", "1. Open the cart\n2. Check out");

        expect(bodyKinds(lines)).toEqual(["add", "add"]);
        expect(bodyContent(lines)).toEqual(["1. Open the cart", "2. Check out"]);
    });

    it("renders an empty new side as a pure deletion", () => {
        const lines = parseSources("1. Open the cart\n2. Check out", "");

        expect(bodyKinds(lines)).toEqual(["delete", "delete"]);
    });

    it("reports no changes between identical sources", () => {
        expect(parseSources("same\ntext", "same\ntext")).toEqual([]);
    });

    it("keeps the whole text as one hunk by default", () => {
        const old = ["a", "b", "c", "d", "e", "f", "g", "CHANGED", "h", "i", "j"].join("\n");
        const next = old.replace("CHANGED", "EDITED");

        const lines = parseSources(old, next);

        expect(lines.filter((line) => line.kind === "hunk")).toHaveLength(1);
        expect(bodyContent(lines)).toHaveLength(12);
    });

    it("elides unchanged runs when context is limited", () => {
        const old = Array.from({ length: 40 }, (_, i) => `line ${i}`);
        const next = [...old];
        next[2] = "edited head";
        next[37] = "edited tail";

        const lines = parseSources(old.join("\n"), next.join("\n"), { context: 1 });

        expect(lines.filter((line) => line.kind === "hunk")).toHaveLength(2);
    });

    describe("word-level segments", () => {
        it("marks only the words that changed on each side", () => {
            const lines = parseSources("Add two items to the cart", "Add three items to the cart", {
                detectMoves: false,
            });
            const del = lines.find((line) => line.kind === "delete");
            const add = lines.find((line) => line.kind === "add");

            expect(del?.kind === "delete" && del.segments).toContainEqual({
                text: "two",
                changed: true,
            });
            expect(add?.kind === "add" && add.segments).toContainEqual({
                text: "three",
                changed: true,
            });
            expect(del?.kind === "delete" && del.segments).toContainEqual({
                text: "Add ",
                changed: false,
            });
        });

        it.each([
            ["the quick brown fox", "the slow brown dog"],
            // Whitespace-divergent: the shared run around the edit is spaced
            // differently on each side, so a whitespace-insensitive word diff
            // would hand both sides the same (new) text.
            ["Assert the badge reads 2.", 'Assert the badge reads "2 items".'],
            ["a  b", "a b c"],
            ["Open  the cart", "Open the checkout page"],
        ])("rebuilds each side's own line from its segments (%j -> %j)", (before, after) => {
            const lines = parseSources(before, after, { detectMoves: false });
            const del = lines.find((line) => line.kind === "delete");
            const add = lines.find((line) => line.kind === "add");

            expect(del?.kind === "delete" && del.segments?.map((s) => s.text).join("")).toBe(before);
            expect(add?.kind === "add" && add.segments?.map((s) => s.text).join("")).toBe(after);
        });
    });

    describe("whitespace collapse", () => {
        const old = "a\n  indented\nb";
        const next = "a\n    indented\nb";

        it("renders a whitespace-only change as a single context line", () => {
            const lines = parseSources(old, next);

            expect(bodyKinds(lines)).toEqual(["context", "context", "context"]);
            expect(bodyContent(lines)).toContain("    indented");
        });

        it("keeps the add/delete pair when collapse is disabled", () => {
            const lines = parseSources(old, next, {
                collapseWhitespace: false,
                detectMoves: false,
            });

            expect(bodyKinds(lines)).toEqual(["context", "delete", "add", "context"]);
        });

        it("keeps gutter line numbers monotonic when a collapsed pair follows a real change", () => {
            // A block that both rewrites a line and reindents the next one: the
            // collapsed (context) line must stay below the change it follows.
            const lines = parseSources("a\nold value\n  keep\nb", "a\nnew value\n    keep\nb", {
                detectMoves: false,
            });

            const olds = lines.flatMap((l) => ("oldLine" in l && l.oldLine != null ? [l.oldLine] : []));
            const news = lines.flatMap((l) => ("newLine" in l && l.newLine != null ? [l.newLine] : []));
            expect(olds).toEqual([...olds].sort((a, b) => a - b));
            expect(news).toEqual([...news].sort((a, b) => a - b));
        });
    });

    describe("move detection", () => {
        it("marks a line deleted here and re-added verbatim elsewhere as moved", () => {
            const lines = parseSources("header\nmoved line\nmiddle\ntail", "header\nmiddle\ntail\nmoved line");
            const moved = lines.filter((line) => line.kind === "moved");

            expect(moved.every((l) => l.kind === "moved" && l.blockId === 0)).toBe(true);
            expect(moved.filter((l) => l.kind === "moved" && l.direction === "from")).toHaveLength(1);
            expect(moved.filter((l) => l.kind === "moved" && l.direction === "to")).toHaveLength(1);
        });

        it("does not surface a line jsdiff deleted and re-added verbatim as a change", () => {
            // Reaching a cheaper alignment, jsdiff drops and re-adds "tail" around
            // the relocated line; that pair is churn, not an edit.
            const lines = parseSources("header\nmoved line\nmiddle\ntail", "header\nmiddle\ntail\nmoved line");

            expect(lines.filter((l) => l.kind === "delete" || l.kind === "add")).toEqual([]);
            expect(bodyContent(lines).filter((c) => c === "tail")).toHaveLength(1);
        });

        it("falls back to add/delete when a reordered numbered list renumbers every step", () => {
            // Swapping two steps of a markdown list rewrites both prefixes, so no
            // line relocates verbatim and the word-level diff carries the change.
            const lines = parseSources("1. Log in\n2. Open settings\n3. Save", "1. Open settings\n2. Log in\n3. Save");

            expect(lines.some((l) => l.kind === "moved" || l.kind === "near-match")).toBe(false);
            expect(bodyKinds(lines)).toEqual(["delete", "delete", "add", "add", "context"]);
        });

        it("treats a relocated line carrying a small edit as a near-match", () => {
            const lines = parseSources("header\nconst a = 1;\nmiddle\ntail", "header\nmiddle\ntail\nconst a = 10;");
            const near = lines.filter((line) => line.kind === "near-match");

            expect(near).toHaveLength(2);
            const from = near.find((l) => l.kind === "near-match" && l.direction === "from");
            expect(from?.kind === "near-match" && from.segments?.some((s) => s.changed)).toBe(true);
        });

        it("does not treat an in-place edit as a move", () => {
            const lines = parseSources("a\nx one\nx two\nb", "a\nx one!\nx two!\nb");

            expect(lines.some((l) => l.kind === "moved" || l.kind === "near-match")).toBe(false);
        });

        it("respects minMovedBlockLines", () => {
            const old = "header\npair one\npair two\nmiddle\ntail";
            const next = "header\nmiddle\ntail\npair one\npair two";

            expect(parseSources(old, next).filter((l) => l.kind === "moved")).toHaveLength(4);
            expect(parseSources(old, next, { minMovedBlockLines: 3 }).some((l) => l.kind === "moved")).toBe(false);
        });

        it("leaves plain add/delete lines when detection is off", () => {
            const lines = parseSources("header\nmoved\nmiddle", "header\nmiddle\nmoved", {
                detectMoves: false,
            });

            expect(lines.some((l) => l.kind === "moved")).toBe(false);
            expect(bodyKinds(lines)).toContain("delete");
            expect(bodyKinds(lines)).toContain("add");
        });
    });
});
