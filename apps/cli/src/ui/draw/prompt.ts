import type { Grid } from "../grid";
import { theme } from "../theme";
import type { PromptState, RunState } from "../types";
import { wrapPlain } from "./wrap";

const MODAL_MAX_W = 96;
const MODAL_FILL = "#141414";
/** Visible option rows before the list windows around the highlight. */
const MAX_OPTION_ROWS = 8;

/**
 * A blocking question as a big centered modal over the dashboard - impossible
 * to miss. The run does not move until it's answered; esc means "go back"
 * only where the flow allows it (request.cancelable).
 */
export function drawPromptModal(g: Grid, state: RunState): void {
    const W = g.w;
    const H = g.h;
    const prompt = state.prompt;
    const req = prompt.current;
    if (req == null) return;

    const w = Math.min(MODAL_MAX_W, W - 6);
    const innerW = w - 6;

    const messageLines = wrapPlain(req.message, innerW);
    const detailLines = req.detail != null ? wrapPlain(req.detail, innerW) : [];

    let bodyRows = 1;
    if (req.kind === "select" || req.kind === "multiselect") {
        bodyRows = Math.min(req.options.length, MAX_OPTION_ROWS);
    }

    const h = 2 + messageLines.length + detailLines.length + (detailLines.length > 0 ? 1 : 0) + 1 + bodyRows + 2 + 2;
    const x = Math.floor((W - w) / 2);
    const y = Math.max(2, Math.floor((H - h) / 2));

    // Blank the area, border it, and re-tint so the border sits on the fill.
    g.clearRect(x, y, w, h, MODAL_FILL);
    g.rect(x, y, w, h, { edge: theme.cardEdge, corner: theme.accent });
    for (let yy = y; yy < y + h; yy++) g.fillBg(x, yy, w, MODAL_FILL);
    const bg = MODAL_FILL;

    let cy = y + 1;
    g.text(x + 3, cy, " ACTION REQUIRED ", { bg: theme.accent, color: theme.onAccent, bold: true });
    if (prompt.queued > 0) {
        g.textRight(x + w - 3, cy, `+${prompt.queued} more after this`, { color: theme.tertiary, bg });
    }
    cy += 2;

    for (const line of messageLines) {
        g.text(x + 3, cy, line, { color: theme.text, bold: true, bg });
        cy++;
    }
    for (const line of detailLines) {
        g.text(x + 3, cy, line, { color: theme.secondary, bg });
        cy++;
    }
    if (detailLines.length > 0) cy++;
    cy++;

    switch (req.kind) {
        case "confirm":
            drawConfirm(g, prompt, x + 3, cy, bg);
            break;
        case "select":
        case "multiselect":
            drawOptions(g, prompt, x, cy, w, bodyRows, bg);
            break;
        case "text":
            drawTextInput(g, prompt, x + 3, cy, innerW, bg);
            break;
    }
    cy += bodyRows + 1;

    const error = prompt.draft.error;
    if (error != null) {
        g.text(x + 3, y + h - 2, `! ${error}`, { color: theme.red, bold: true, bg });
    } else {
        drawKeysLine(g, state, x + 3, y + h - 2, bg);
    }
}

function drawKeysLine(g: Grid, state: RunState, x0: number, y: number, bg: string): void {
    const req = state.prompt.current;
    if (req == null) return;
    const parts: [string, string][] = [];
    if (req.kind === "confirm") parts.push(["←→ / y n", "choose"], ["enter", "confirm"]);
    if (req.kind === "select") parts.push(["↑↓", "choose"], ["enter", "confirm"]);
    if (req.kind === "multiselect") {
        parts.push(["↑↓", "move"], ["space", "toggle on/off"], ["enter", "confirm selection"]);
    }
    if (req.kind === "text") parts.push(["type your answer", ""], ["enter", "submit"]);
    if (req.cancelable === true) parts.push(["esc", "go back"]);

    let x = x0;
    for (const [k, label] of parts) {
        g.text(x, y, k, { color: theme.accent, bold: true, bg });
        x += k.length;
        if (label !== "") {
            g.text(x + 1, y, label, { color: theme.secondary, bg });
            x += label.length + 1;
        }
        x += 3;
    }
}

function drawConfirm(g: Grid, prompt: PromptState, x0: number, y: number, bg: string): void {
    const yes = prompt.draft.index === 0;
    const chip = (x: number, label: string, active: boolean): number => {
        const text = `  ${label}  `;
        if (active) g.text(x, y, text, { bg: theme.accent, color: theme.onAccent, bold: true });
        else g.text(x, y, text, { color: theme.secondary, bg });
        return text.length;
    };
    let x = x0;
    x += chip(x, "Yes", yes) + 4;
    chip(x, "No", !yes);
}

function drawOptions(g: Grid, prompt: PromptState, x0: number, y: number, w: number, rows: number, bg: string): void {
    const req = prompt.current;
    if (req == null || (req.kind !== "select" && req.kind !== "multiselect")) return;
    const multi = req.kind === "multiselect";
    const options = req.options;

    // Window around the highlighted option.
    let start = 0;
    if (options.length > rows) {
        start = Math.max(0, Math.min(prompt.draft.index - Math.floor(rows / 2), options.length - rows));
    }

    for (let i = 0; i < rows; i++) {
        const idx = start + i;
        const option = options[idx];
        if (option == null) break;
        const active = idx === prompt.draft.index;
        const rowY = y + i;
        if (active) g.fillBg(x0 + 1, rowY, w - 2, theme.selectionBg);
        const rowBg = active ? theme.selectionBg : bg;
        if (active) g.set(x0 + 2, rowY, "›", { color: theme.accent, bold: true, bg: rowBg });
        let x = x0 + 4;
        if (multi) {
            const checked = prompt.draft.checked.includes(option.value);
            g.text(x, rowY, checked ? "[x]" : "[ ]", {
                color: checked ? theme.accent : theme.faint,
                bold: checked,
                bg: rowBg,
            });
            x += 4;
        }
        g.text(x, rowY, option.label, { color: active ? theme.text : theme.secondary, bold: active, bg: rowBg });
        x += option.label.length;
        if (option.hint != null) {
            g.text(x + 2, rowY, option.hint.slice(0, Math.max(0, x0 + w - 3 - (x + 2))), {
                color: theme.tertiary,
                bg: rowBg,
            });
        }
    }
    if (options.length > rows) {
        g.textRight(x0 + w - 3, y + rows - 1, `${prompt.draft.index + 1}/${options.length}`, {
            color: theme.tertiary,
            bg,
        });
    }
}

function drawTextInput(g: Grid, prompt: PromptState, x0: number, y: number, maxW: number, bg: string): void {
    const { text, cursor } = prompt.draft;
    const req = prompt.current;
    const placeholder = req?.kind === "text" ? (req.placeholder ?? "") : "";

    g.text(x0, y, "> ", { color: theme.accent, bold: true, bg });
    const inputW = maxW - 3;
    if (text === "") {
        // Caret block first, dim placeholder after it - never under the caret.
        g.text(x0 + 2, y, " ", { bg: theme.accent });
        g.text(x0 + 4, y, placeholder.slice(0, inputW - 2), { color: theme.faint, bg });
        return;
    }
    // Keep the caret visible on long input by sliding the window.
    const from = Math.max(0, cursor - inputW + 1);
    const visible = text.slice(from, from + inputW);
    g.text(x0 + 2, y, visible, { color: theme.text, bg });
    const caretX = x0 + 2 + (cursor - from);
    const under = text.slice(cursor, cursor + 1) || " ";
    g.text(caretX, y, under, { bg: theme.accent, color: theme.onAccent });
}
