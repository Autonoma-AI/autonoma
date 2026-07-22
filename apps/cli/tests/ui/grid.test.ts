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
});
