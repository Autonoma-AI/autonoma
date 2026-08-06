import { describe, expect, test } from "vitest";
import { Grid } from "../../src/ui/grid";

describe("grid", () => {
    test("control characters never reach a cell - a newline would shift every row below", () => {
        const g = new Grid(20, 2);
        g.text(0, 0, "a\nb\tc", {});
        const row = g
            .rows()[0]!
            .map((s) => s.text)
            .join("");
        expect(row).toBe("a b c" + " ".repeat(15));
        for (const line of g.ansiRows()) {
            expect(line).not.toContain("\n");
            expect(line).not.toContain("\t");
        }
    });

    test("dimExcept shades cells outside the protected rects but leaves them inside untouched", () => {
        const g = new Grid(10, 3);
        g.text(0, 0, "OUT", { color: "#ccff00", bold: true });
        g.text(0, 1, "IN", { color: "#ccff00", bold: true });
        g.dimExcept([{ x: 0, y: 1, w: 10, h: 1 }]);

        const cells = g.cells;
        // Protected row keeps its bright color and bold.
        expect(cells[1]![0]!.color).toBe("#ccff00");
        expect(cells[1]![0]!.bold).toBe(true);
        // Shaded row is darkened and un-bolded.
        expect(cells[0]![0]!.color).not.toBe("#ccff00");
        expect(cells[0]![0]!.bold).toBe(false);
        // A cell with no explicit color gets a dim gray, not left default-bright.
        expect(cells[2]![0]!.color).toBeDefined();
    });

    test("clear resets every cell to a blank space without allocating new arrays", () => {
        const g = new Grid(5, 2);
        g.text(0, 0, "hello", { color: "#ccff00", bold: true });
        g.text(0, 1, "world", { color: "#ff0000" });

        const row0 = g.cells[0]!;
        const row1 = g.cells[1]!;

        g.clear();

        // Same array references - no reallocation.
        expect(g.cells[0]).toBe(row0);
        expect(g.cells[1]).toBe(row1);

        // Every cell is a blank space with no style.
        for (const row of g.cells) {
            for (const cell of row) {
                expect(cell.ch).toBe(" ");
                expect(cell.color).toBeUndefined();
                expect(cell.bg).toBeUndefined();
                expect(cell.bold).toBeUndefined();
            }
        }
    });

    test("ansiRows produces the same output before and after optimization", () => {
        const g = new Grid(15, 3);
        g.text(0, 0, "plain", {});
        g.text(0, 1, "colored", { color: "#ccff00", bold: true });
        g.text(0, 2, "bg", { bg: "#333333" });

        const rows = g.ansiRows();
        expect(rows).toHaveLength(3);
        // Plain row has no escape codes.
        expect(rows[0]).not.toContain("\x1b[");
        // Colored row has bold + fg color.
        expect(rows[1]).toContain("\x1b[1;38;2;");
        expect(rows[1]).toContain("colored");
        // BG-only row has bg color.
        expect(rows[2]).toContain("\x1b[48;2;");
        expect(rows[2]).toContain("bg");
    });
});
