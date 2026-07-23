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
});
