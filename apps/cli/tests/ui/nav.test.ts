import { describe, expect, test } from "vitest";
import { navReducer } from "../../src/ui/nav";
import { createStore } from "../../src/ui/store";
import type { RunState } from "../../src/ui/types";

const META = { title: "t", project: "p", version: "0" };

function baseState(): RunState {
    const store = createStore({ outputDir: "/out", meta: META });
    store.startStep("projectMapper");
    store.noteWrite("project-map.json");
    store.endStep("projectMapper", "done");
    store.startStep("pagesFinder");
    store.noteWrite("pages.json");
    return store.getState();
}

describe("nav reducer", () => {
    test("default focus is the file list, cursor riding the newest write at the top", () => {
        const s = baseState();
        expect(s.nav.focus).toBe("artifacts");
        expect(s.nav.selectedArtifactIdx).toBe(0);
        expect(s.live.following).toBe(true);
    });

    test("the list is newest first", () => {
        const s = baseState();
        expect(s.artifactOrder).toEqual(["pages.json", "project-map.json"]);
    });

    test("right from the file list goes INTO the selected file", () => {
        let s = baseState();
        s = navReducer(s, { type: "moveDown" });
        s = navReducer(s, { type: "focusRight" });
        expect(s.nav.focus).toBe("main");
        expect(s.live.artifactId).toBe("project-map.json");
        expect(s.live.following).toBe(false);
    });

    test("moving the cursor in the list stops following", () => {
        let s = baseState();
        expect(s.live.following).toBe(true);
        s = navReducer(s, { type: "moveDown" });
        expect(s.live.following).toBe(false);
        expect(s.nav.selectedArtifactIdx).toBe(1);
    });

    test("left from the document lands the cursor on the open file", () => {
        let s = baseState();
        s = navReducer(s, { type: "focusRight" }); // open pages.json (idx 0)
        s = navReducer(s, { type: "focusLeft" });
        expect(s.nav.focus).toBe("artifacts");
        expect(s.nav.selectedArtifactIdx).toBe(0);
    });

    test("enter on a file opens it in the viewer from the top, pinned", () => {
        let s = baseState();
        s = navReducer(s, { type: "moveDown" });
        s = navReducer(s, { type: "enter" });
        expect(s.nav.focus).toBe("main");
        expect(s.live.artifactId).toBe("project-map.json");
        expect(s.live.following).toBe(false);
        expect(s.nav.mainScrollTop).toBe(0);
    });

    test("unfollowing by scrolling starts from the tail that was on screen", () => {
        let s = baseState();
        const store = createStore({ outputDir: "/out", meta: META });
        store.setLiveFile("AUTONOMA.md", Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"), "markdown");
        s = store.getState();
        s = navReducer(s, { type: "setViewport", rows: 20, cols: 80 });
        s = { ...s, nav: { ...s.nav, focus: "main" } };
        expect(s.live.following).toBe(true);

        s = navReducer(s, { type: "moveUp" });
        // Tail top is 50 - 20 = 30; one step up shows line 29.
        expect(s.nav.mainScrollTop).toBe(29);
        expect(s.live.following).toBe(false);

        s = navReducer(s, { type: "scrollBottom" });
        expect(s.nav.mainScrollTop).toBe(30);
    });

    test("the file cursor clamps to the list bounds", () => {
        let s = baseState();
        s = navReducer(s, { type: "moveDown" });
        expect(s.nav.selectedArtifactIdx).toBe(1);
        s = navReducer(s, { type: "moveUp" });
        s = navReducer(s, { type: "moveUp" });
        s = navReducer(s, { type: "moveUp" });
        expect(s.nav.selectedArtifactIdx).toBe(0);
    });

    test("toggleFollow flips following back on", () => {
        let s = baseState();
        s = navReducer(s, { type: "moveUp" });
        expect(s.live.following).toBe(false);
        s = navReducer(s, { type: "toggleFollow" });
        expect(s.live.following).toBe(true);
    });

    test("turning follow off freezes the view at the tail instead of snapping to top", () => {
        const store = createStore({ outputDir: "/out", meta: META });
        store.setLiveFile("AUTONOMA.md", Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"), "markdown");
        let s = store.getState();
        s = navReducer(s, { type: "setViewport", rows: 20, cols: 80 });
        expect(s.live.following).toBe(true);

        s = navReducer(s, { type: "toggleFollow" });
        expect(s.live.following).toBe(false);
        // The tail showed lines 30-49; the frozen view stays right there.
        expect(s.nav.mainScrollTop).toBe(30);
    });
});

describe("closeDocument", () => {
    test("esc from the file list returns to the step explainer with follow re-armed", () => {
        let s = baseState();
        s = navReducer(s, { type: "focusLeft" });
        s = navReducer(s, { type: "enter" }); // open the file (pins, unfollows)
        s = navReducer(s, { type: "focusLeft" });
        s = navReducer(s, { type: "closeDocument" });
        expect(s.live.path).toBeUndefined();
        expect(s.live.text).toBe("");
        // Follow-latest is the default state - esc restores it, so the next
        // write brings the hero back live without pressing f.
        expect(s.live.following).toBe(true);
    });
});
