import type { Grid } from "../grid";
import { theme } from "../theme";
import type { CompletionChoice, CompletionState, RunState } from "../types";
import { wrapPlain } from "./wrap";

const MODAL_MAX_W = 84;
const MODAL_FILL = "#141414";
/** Gap between two headline counts laid out side by side. */
const STAT_GAP = 6;
/** Padding inside a choice pill, either side of its label. */
const CHOICE_PAD = 2;
/** Gap between the two choice pills. */
const CHOICE_GAP = 3;

const CHOICES: { id: CompletionChoice; label: string }[] = [
    { id: "browse", label: "Browse the results" },
    { id: "exit", label: "Exit" },
];

/**
 * The closing summary: a centered modal mirroring the opening welcome, showing
 * what the run produced and offering to stay and read it. The store resolves
 * the caller's promise when the user picks.
 */
export function drawCompletionModal(g: Grid, state: RunState): void {
    const done = state.completion;
    if (done == null) return;
    const W = g.w;
    const H = g.h;

    const w = Math.min(MODAL_MAX_W, W - 6);
    const innerW = w - 8;

    const titleLines = wrapPlain(done.title, innerW);
    const bodyLines = done.lines.flatMap((line, i) => {
        const wrapped = wrapPlain(line, innerW);
        return i === 0 ? wrapped : ["", ...wrapped];
    });
    const statRows = statLayout(done, innerW);

    const h = 2 + 1 + titleLines.length + 1 + statRows.length * 2 + 1 + bodyLines.length + 2 + 2;
    const x = Math.floor((W - w) / 2);
    const y = Math.max(2, Math.floor((H - h) / 2));

    g.clearRect(x, y, w, h, MODAL_FILL);
    g.rect(x, y, w, h, { edge: theme.cardEdge, corner: theme.green });
    for (let yy = y; yy < y + h; yy++) g.fillBg(x, yy, w, MODAL_FILL);
    const bg = MODAL_FILL;

    let cy = y + 1;
    g.text(x + 4, cy, "◆ RUN COMPLETE", { color: theme.green, bold: true, bg });
    cy += 2;

    for (const line of titleLines) {
        g.text(x + 4, cy, line, { color: theme.text, bold: true, bg });
        cy++;
    }
    cy++;

    // Each row is the numbers, then their nouns underneath at the same columns.
    for (const row of statRows) {
        for (const cell of row) {
            g.text(x + 4 + cell.x, cy, String(cell.stat.value), { color: theme.accent, bold: true, bg });
            g.text(x + 4 + cell.x, cy + 1, cell.stat.label, { color: theme.secondary, bg });
        }
        cy += 2;
    }
    cy++;

    for (const line of bodyLines) {
        g.text(x + 4, cy, line, { color: theme.secondary, bg });
        cy++;
    }

    drawChoices(g, x + 4, y + h - 2, done.choice, bg);
}

interface StatCell {
    x: number;
    stat: { value: number; label: string };
}

/**
 * Counts sit side by side while they fit, and wrap to further rows when they
 * don't - a narrow terminal must never clip a number off the modal.
 */
function statLayout(done: CompletionState, innerW: number): StatCell[][] {
    const rows: StatCell[][] = [];
    let row: StatCell[] = [];
    let cursor = 0;
    for (const stat of done.stats) {
        const cellW = Math.max(String(stat.value).length, stat.label.length);
        if (row.length > 0 && cursor + cellW > innerW) {
            rows.push(row);
            row = [];
            cursor = 0;
        }
        row.push({ x: cursor, stat });
        cursor += cellW + STAT_GAP;
    }
    if (row.length > 0) rows.push(row);
    return rows;
}

/** Two pills; the highlighted one is filled, the other is an outline. */
function drawChoices(g: Grid, x: number, y: number, choice: CompletionChoice, bg: string): void {
    let cursor = x;
    for (const option of CHOICES) {
        const selected = option.id === choice;
        const label = `${" ".repeat(CHOICE_PAD)}${option.label}${" ".repeat(CHOICE_PAD)}`;
        if (selected) {
            g.fillBg(cursor, y, label.length, theme.accent);
            g.text(cursor, y, label, { color: MODAL_FILL, bold: true, bg: theme.accent });
        } else {
            g.text(cursor, y, label, { color: theme.secondary, bg });
        }
        cursor += label.length + CHOICE_GAP;
    }
}
