import type { TermSize } from "./hooks/useTerminalSize";

/**
 * The smallest terminal the dashboard can be drawn in, in terminal cells.
 *
 * Below either axis the layout folds into itself rather than degrading: the
 * activity feed's top edge crosses above the panels (`panelBottom` drops under
 * `PANEL_TOP`), rows overwrite each other, and the modals - which carry the
 * instructions a run cannot continue past - get clipped mid-sentence. 80x24 is
 * the classic terminal default, and the height that fits the tallest modal.
 */
export const MIN_COLUMNS = 80;
export const MIN_ROWS = 24;

/**
 * The frame is rendered inline, so drawing exactly as many lines as the
 * terminal has makes it scroll and walk off-screen. One row always stays free.
 */
const RESERVED_ROW = 1;

/** Grid height for a terminal that tall. */
export function gridRowsFor(terminalRows: number): number {
    return Math.max(1, terminalRows - RESERVED_ROW);
}

/** Terminal height a grid that tall was measured from. */
export function terminalRowsFor(gridRows: number): number {
    return gridRows + RESERVED_ROW;
}

/** Is there room to draw the dashboard on a grid this size? */
export function gridFitsDashboard(width: number, gridRows: number): boolean {
    return width >= MIN_COLUMNS && terminalRowsFor(gridRows) >= MIN_ROWS;
}

/** Is there room to draw the dashboard in a terminal this size? */
export function terminalFitsDashboard(size: TermSize): boolean {
    return gridFitsDashboard(size.columns, gridRowsFor(size.rows));
}
