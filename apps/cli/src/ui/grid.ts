import { theme } from "./theme";

const rgbCache = new Map<string, string>();

function rgbOf(hex: string): string {
    const cached = rgbCache.get(hex);
    if (cached != null) return cached;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const rgb = `${r};${g};${b}`;
    rgbCache.set(hex, rgb);
    return rgb;
}

function fgCode(hex: string): string {
    return `38;2;${rgbOf(hex)}`;
}

function bgCode(hex: string): string {
    return `48;2;${rgbOf(hex)}`;
}

/** Blend a hex color toward black, keeping `keep` (0..1) of each channel. */
function dimHex(hex: string, keep: number): string {
    const to2 = (n: number) =>
        Math.round(n * keep)
            .toString(16)
            .padStart(2, "0");
    return `#${to2(parseInt(hex.slice(1, 3), 16))}${to2(parseInt(hex.slice(3, 5), 16))}${to2(parseInt(hex.slice(5, 7), 16))}`;
}

export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface Cell {
    ch: string;
    color?: string;
    bg?: string;
    bold?: boolean;
}
export interface Seg {
    text: string;
    color?: string;
    bg?: string;
    bold?: boolean;
}
export interface Style {
    color?: string;
    bg?: string;
    bold?: boolean;
}

/**
 * A fixed character-cell framebuffer. Screens draw boxes, tables, highlights
 * and text at exact (x,y) coordinates, then `rows()` flattens into styled spans
 * for Ink. This is deterministic - every border edge, corner and column lines
 * up by construction - which Ink's flexbox + borderStyle could not deliver.
 */
export class Grid {
    readonly w: number;
    readonly h: number;
    cells: Cell[][];

    constructor(w: number, h: number) {
        this.w = w;
        this.h = h;
        this.cells = Array.from({ length: h }, () => Array.from({ length: w }, (): Cell => ({ ch: " " })));
    }

    set(x: number, y: number, ch: string, st: Style = {}): void {
        if (y < 0 || y >= this.h || x < 0 || x >= this.w) return;
        // A control char (\n, \t, ...) inside a cell breaks the emitted row
        // string and shifts every following terminal line - never store one.
        const safe = ch < " " ? " " : ch;
        this.cells[y]![x] = { ch: safe, color: st.color, bg: st.bg, bold: st.bold };
    }

    /** Draw a string starting at (x,y); truncates at the right edge. */
    text(x: number, y: number, s: string, st: Style = {}): void {
        for (let i = 0; i < s.length; i++) this.set(x + i, y, s[i]!, st);
    }

    /** Right-align a string ending at (xEnd, y) (xEnd inclusive). */
    textRight(xEnd: number, y: number, s: string, st: Style = {}): void {
        this.text(xEnd - s.length + 1, y, s, st);
    }

    hline(x: number, y: number, len: number, ch: string, color?: string): void {
        for (let i = 0; i < len; i++) this.set(x + i, y, ch, { color });
    }

    vline(x: number, y: number, len: number, ch: string, color?: string): void {
        for (let i = 0; i < len; i++) this.set(x, y + i, ch, { color });
    }

    /** Blank a rectangle: every cell becomes a space on `bg`. For overlays/modals. */
    clearRect(x: number, y: number, w: number, h: number, bg?: string): void {
        for (let yy = y; yy < y + h; yy++) {
            for (let xx = x; xx < x + w; xx++) this.set(xx, yy, " ", { bg });
        }
    }

    /**
     * Shade every cell OUTSIDE the protected rectangles - a focus spotlight
     * over the rest of the UI. Cells with no explicit fg get a dim gray so
     * default-colored text (borders, plain rows) darkens too; bold is dropped.
     */
    dimExcept(protect: Rect[], keep = 0.38, defaultFg = "#3a3a3a"): void {
        const inProtect = (x: number, y: number): boolean =>
            protect.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
        for (let y = 0; y < this.h; y++) {
            const row = this.cells[y]!;
            for (let x = 0; x < this.w; x++) {
                if (inProtect(x, y)) continue;
                const c = row[x]!;
                c.bold = false;
                c.color = c.color != null ? dimHex(c.color, keep) : defaultFg;
                if (c.bg != null) c.bg = dimHex(c.bg, keep);
            }
        }
    }

    /** Set a background colour across a span, preserving the chars already there. */
    fillBg(x: number, y: number, len: number, bg: string): void {
        const row = this.cells[y];
        if (row == null) return;
        for (let i = 0; i < len; i++) {
            const c = row[x + i];
            if (c) c.bg = bg;
        }
    }

    /**
     * A box with box-drawing borders. Corners use `corner` (lime by default),
     * edges use `edge` (gray). Optional `fill` paints the interior background.
     */
    rect(
        x: number,
        y: number,
        w: number,
        h: number,
        opts: { edge?: string; corner?: string; fill?: string } = {},
    ): void {
        const edge = opts.edge ?? theme.cardEdge;
        const corner = opts.corner ?? theme.accent;
        this.set(x, y, "┌", { color: corner });
        this.set(x + w - 1, y, "┐", { color: corner });
        this.set(x, y + h - 1, "└", { color: corner });
        this.set(x + w - 1, y + h - 1, "┘", { color: corner });
        this.hline(x + 1, y, w - 2, "─", edge);
        this.hline(x + 1, y + h - 1, w - 2, "─", edge);
        this.vline(x, y + 1, h - 2, "│", edge);
        this.vline(x + w - 1, y + 1, h - 2, "│", edge);
        if (opts.fill != null) for (let yy = y + 1; yy < y + h - 1; yy++) this.fillBg(x + 1, yy, w - 2, opts.fill);
    }

    /**
     * Flatten into per-row ANSI strings (24-bit color escapes). One string per
     * row keeps the Ink tree tiny - rendering thousands of nested <Text> spans
     * per frame is what makes large dashboards crawl.
     */
    ansiRows(): string[] {
        return this.rows().map((segs) => {
            let out = "";
            for (const s of segs) {
                const codes: string[] = [];
                if (s.bold) codes.push("1");
                if (s.color != null) codes.push(fgCode(s.color));
                if (s.bg != null) codes.push(bgCode(s.bg));
                if (codes.length === 0) {
                    out += s.text;
                } else {
                    out += `\x1b[${codes.join(";")}m${s.text}\x1b[0m`;
                }
            }
            return out;
        });
    }

    /** Flatten into per-row spans, merging adjacent cells with identical style. */
    rows(): Seg[][] {
        const out: Seg[][] = [];
        for (let y = 0; y < this.h; y++) {
            const row = this.cells[y]!;
            const segs: Seg[] = [];
            let cur: Seg | undefined;
            for (let x = 0; x < this.w; x++) {
                const c = row[x]!;
                if (cur && cur.color === c.color && cur.bg === c.bg && cur.bold === !!c.bold) {
                    cur.text += c.ch;
                } else {
                    cur = { text: c.ch, color: c.color, bg: c.bg, bold: c.bold };
                    segs.push(cur);
                }
            }
            out.push(segs);
        }
        return out;
    }
}
