export const REPLAY_BACKGROUND = "#050505";
export const REPLAY_FOREGROUND = "#EDEDED";

/** Empty rows still need a glyph, or the row div collapses to zero height. */
const EMPTY_ROW_TEXT = " ";

// Matching ESC is the whole job here - this parser exists to read SGR sequences.
// eslint-disable-next-line no-control-regex
const SGR_PATTERN = /\x1b\[([0-9;]*)m/g;

interface Style {
    color?: string;
    background?: string;
    bold: boolean;
    dim: boolean;
    inverse: boolean;
}

/** A run of characters sharing one style, within a single row. */
export interface StyledRun {
    text: string;
    css: string;
}

export interface TerminalRow {
    runs: StyledRun[];
}

function emptyStyle(): Style {
    return { bold: false, dim: false, inverse: false };
}

/**
 * Apply one SGR sequence's parameters.
 *
 * Ink emits truecolor (`38;2;r;g;b`) for every themed color, so the 16-color and
 * 256-color forms never appear and are deliberately not handled - an unknown
 * parameter is skipped rather than guessed at, which shows up as unstyled text
 * rather than a wrong color.
 */
function applySgr(style: Style, params: number[]): Style {
    const next: Style = { ...style };
    for (let i = 0; i < params.length; i++) {
        const code = params[i];
        if (code === 0) {
            return emptyStyle();
        } else if (code === 1) {
            next.bold = true;
        } else if (code === 2) {
            next.dim = true;
        } else if (code === 7) {
            next.inverse = true;
        } else if (code === 22) {
            next.bold = false;
            next.dim = false;
        } else if (code === 27) {
            next.inverse = false;
        } else if (code === 39) {
            next.color = undefined;
        } else if (code === 49) {
            next.background = undefined;
        } else if ((code === 38 || code === 48) && params[i + 1] === 2) {
            const rgb = `rgb(${params[i + 2] ?? 0},${params[i + 3] ?? 0},${params[i + 4] ?? 0})`;
            if (code === 38) next.color = rgb;
            else next.background = rgb;
            i += 4;
        }
    }
    return next;
}

function styleToCss(style: Style): string {
    const foreground = style.color ?? REPLAY_FOREGROUND;
    const background = style.background ?? REPLAY_BACKGROUND;
    const parts = style.inverse
        ? [`color:${background}`, `background:${foreground}`]
        : [`color:${foreground}`, ...(style.background != null ? [`background:${background}`] : [])];
    if (style.bold) parts.push("font-weight:700");
    if (style.dim) parts.push("opacity:.6");
    return parts.join(";");
}

function pushRun(row: TerminalRow, text: string, css: string): void {
    if (text.length === 0) return;
    const last = row.runs[row.runs.length - 1];
    // Ink re-emits the same SGR run-to-run; merging keeps the DOM (and the
    // resulting mutation payloads) roughly one span per visible colour change.
    if (last != null && last.css === css) {
        last.text += text;
        return;
    }
    row.runs.push({ text, css });
}

/**
 * Split one rendered Ink frame into styled rows.
 *
 * Style carries across the newline boundary the way a terminal does, so a run
 * left open at the end of a row continues into the next.
 */
export function ansiToRows(frame: string): TerminalRow[] {
    const rows: TerminalRow[] = [{ runs: [] }];
    let style = emptyStyle();
    let cursor = 0;

    const appendText = (text: string) => {
        const segments = text.split("\n");
        segments.forEach((segment, index) => {
            if (index > 0) rows.push({ runs: [] });
            const row = rows[rows.length - 1];
            if (row != null) pushRun(row, segment, styleToCss(style));
        });
    };

    for (const match of frame.matchAll(SGR_PATTERN)) {
        appendText(frame.slice(cursor, match.index));
        const params = (match[1] ?? "").split(";").map((value) => (value === "" ? 0 : Number(value)));
        style = applySgr(style, params);
        cursor = (match.index ?? 0) + match[0].length;
    }
    appendText(frame.slice(cursor));

    for (const row of rows) {
        if (row.runs.length === 0) row.runs.push({ text: EMPTY_ROW_TEXT, css: styleToCss(emptyStyle()) });
    }
    return rows;
}
