import type { Artifact, RunState } from "./types";

export type NavAction =
    | { type: "moveUp" }
    | { type: "moveDown" }
    | { type: "focusLeft" }
    | { type: "focusRight" }
    | { type: "enter" }
    | { type: "pageUp" }
    | { type: "pageDown" }
    | { type: "scrollTop" }
    | { type: "scrollBottom" }
    | { type: "toggleFollow" }
    | { type: "closeDocument" }
    | { type: "setViewport"; rows: number; cols: number };

const PAGE_LINES = 10;

/** All artifacts, newest first - the flat FILES column. */
export function allArtifacts(state: RunState): Artifact[] {
    return state.artifactOrder.map((id) => state.artifacts[id]).filter((a): a is Artifact => a != null);
}

export function selectedArtifact(state: RunState): Artifact | undefined {
    return allArtifacts(state)[state.nav.selectedArtifactIdx];
}

function clamp(n: number, max: number): number {
    return Math.max(0, Math.min(max, n));
}

/** The furthest scroll-top: with a known viewport it's exact, else approximate. */
function maxTopOf(state: RunState): number {
    if (state.nav.viewportRows != null) return Math.max(0, state.live.lineCount - state.nav.viewportRows);
    return state.nav.maxScroll;
}

/**
 * Scroll the document. While following, the view sits at the tail even though
 * mainScrollTop was never set - so the first manual scroll starts FROM the
 * tail position, not from wherever the counter was left.
 */
function scroll(state: RunState, delta: number): RunState {
    const maxTop = maxTopOf(state);
    const from = state.live.following ? maxTop : state.nav.mainScrollTop;
    const top = clamp(from + delta, maxTop);
    return { ...state, nav: { ...state.nav, mainScrollTop: top }, live: { ...state.live, following: false } };
}

/** Open the selected file in the viewer: pin it and move focus there. */
function openSelected(state: RunState): RunState {
    const art = selectedArtifact(state);
    if (art == null) return state;
    return {
        ...state,
        nav: { ...state.nav, focus: "main", mainScrollTop: 0 },
        live: { ...state.live, following: false, artifactId: art.id, path: art.path, name: art.name },
    };
}

/**
 * Keyboard navigation over the two panels. Left/Right (h/l) move between the
 * file list and the viewer - moving right from the list opens the selected
 * file, Finder-style. Up/Down (k/j) move the cursor or scroll the document.
 * Default focus is the viewer so the document scrolls immediately.
 */
export function navReducer(state: RunState, action: NavAction): RunState {
    const nav = state.nav;

    switch (action.type) {
        case "focusLeft": {
            if (nav.focus === "main") {
                // Land the cursor on the file that's open in the viewer.
                const idx = state.live.artifactId != null ? state.artifactOrder.indexOf(state.live.artifactId) : -1;
                return {
                    ...state,
                    nav: { ...nav, focus: "artifacts", selectedArtifactIdx: idx >= 0 ? idx : nav.selectedArtifactIdx },
                };
            }
            return state;
        }
        case "focusRight": {
            // From the file list, "going right" means going INTO the file.
            if (nav.focus === "artifacts") return openSelected(state);
            return state;
        }

        case "moveUp":
        case "moveDown": {
            const delta = action.type === "moveUp" ? -1 : 1;
            if (nav.focus === "artifacts") {
                // Moving the cursor is browsing: stop the list/hero jumping to
                // every new write until `f` re-follows.
                const idx = clamp(nav.selectedArtifactIdx + delta, Math.max(0, allArtifacts(state).length - 1));
                return {
                    ...state,
                    nav: { ...nav, selectedArtifactIdx: idx },
                    live: { ...state.live, following: false },
                };
            }
            return scroll(state, delta);
        }

        case "enter": {
            if (nav.focus === "artifacts") return openSelected(state);
            return state;
        }

        case "pageUp":
            return scroll(state, -PAGE_LINES);
        case "pageDown":
            return scroll(state, PAGE_LINES);
        case "scrollTop":
            return { ...state, nav: { ...nav, mainScrollTop: 0 }, live: { ...state.live, following: false } };
        case "scrollBottom":
            return { ...state, nav: { ...nav, mainScrollTop: maxTopOf(state) } };

        case "toggleFollow": {
            if (state.live.following) {
                // Turning OFF freezes the view exactly where the tail was -
                // the stale scroll offset would otherwise snap to the top.
                return {
                    ...state,
                    nav: { ...state.nav, mainScrollTop: maxTopOf(state) },
                    live: { ...state.live, following: false },
                };
            }
            return { ...state, live: { ...state.live, following: true } };
        }

        case "closeDocument": {
            // Back to the DEFAULT state: the step explainer, with follow-latest
            // re-armed - the next write brings the hero back live. Browsing and
            // pinning are the exceptions; esc always returns to the living view.
            return {
                ...state,
                nav: { ...state.nav, mainScrollTop: 0 },
                live: {
                    ...state.live,
                    artifactId: undefined,
                    path: undefined,
                    name: undefined,
                    text: "",
                    lineCount: 0,
                    writingLive: false,
                    following: true,
                },
            };
        }

        case "setViewport": {
            if (nav.viewportRows === action.rows && nav.viewportCols === action.cols) return state;
            return { ...state, nav: { ...nav, viewportRows: action.rows, viewportCols: action.cols } };
        }
    }
}
