import { describe, expect, it } from "vitest";
import { ansiToRows } from "../../src/replay/ansi-to-rows";

const CYAN = "\x1b[38;2;0;200;255m";
const RESET = "\x1b[39m";
const BOLD = "\x1b[1m";

describe("ansiToRows", () => {
    it("splits a frame into one row per line", () => {
        const rows = ansiToRows("alpha\nbeta\ngamma");
        expect(rows).toHaveLength(3);
        expect(rows.map((row) => row.runs.map((run) => run.text).join(""))).toEqual(["alpha", "beta", "gamma"]);
    });

    it("carries an open style across a line break the way a terminal does", () => {
        const rows = ansiToRows(`${CYAN}one\ntwo${RESET}`);
        expect(rows[0]?.runs[0]?.css).toContain("rgb(0,200,255)");
        expect(rows[1]?.runs[0]?.css).toContain("rgb(0,200,255)");
    });

    it("merges neighbouring runs that share a style", () => {
        // Ink re-emits the same colour repeatedly; one span per colour change
        // is what keeps mutation payloads small.
        const rows = ansiToRows(`${CYAN}a${CYAN}b${CYAN}c`);
        expect(rows[0]?.runs).toHaveLength(1);
        expect(rows[0]?.runs[0]?.text).toBe("abc");
    });

    it("gives a blank row a glyph so it keeps its height", () => {
        const rows = ansiToRows("top\n\nbottom");
        expect(rows[1]?.runs[0]?.text).toBe(" ");
    });

    it("renders inverse video as swapped foreground and background", () => {
        const [normal] = ansiToRows("plain");
        const [inverse] = ansiToRows("\x1b[7minverse");
        expect(normal?.runs[0]?.css).not.toContain("background");
        expect(inverse?.runs[0]?.css).toContain("background");
    });

    it("keeps bold and dim distinguishable", () => {
        expect(ansiToRows(`${BOLD}x`)[0]?.runs[0]?.css).toContain("font-weight:700");
        expect(ansiToRows("\x1b[2mx")[0]?.runs[0]?.css).toContain("opacity");
    });
});
