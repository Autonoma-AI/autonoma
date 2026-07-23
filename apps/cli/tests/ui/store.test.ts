import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createStore, type RunStore } from "../../src/ui/store";

const META = { title: "Generating your test suite", project: "acme", version: "0.0.0" };

function makeStore(reader?: Parameters<typeof createStore>[0]["reader"]): RunStore {
    return createStore({ outputDir: "/out", meta: META, reader });
}

describe("run store", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    test("startStep marks the step running and tracks it as current", () => {
        const store = makeStore();
        store.startStep("kb");
        const s = store.getState();
        expect(s.currentStep).toBe("kb");
        expect(s.steps.kb.status).toBe("running");
        expect(s.steps.kb.startedAt).toBeDefined();
    });

    test("noteWrite registers a WRITING artifact and the hero follows it", () => {
        const store = makeStore();
        store.startStep("kb");
        store.noteWrite("AUTONOMA.md");
        const s = store.getState();
        expect(s.artifacts["AUTONOMA.md"]?.status).toBe("WRITING");
        expect(s.artifacts["AUTONOMA.md"]?.step).toBe("kb");
        expect(s.live.artifactId).toBe("AUTONOMA.md");
        expect(s.live.writingLive).toBe(true);
    });

    test("writingLive settles back to false after the write quiets down", () => {
        const store = makeStore();
        store.noteWrite("AUTONOMA.md");
        expect(store.getState().live.writingLive).toBe(true);
        vi.advanceTimersByTime(1000);
        expect(store.getState().live.writingLive).toBe(false);
    });

    test("absolute paths under the output dir are keyed by their relative path", () => {
        const store = makeStore();
        store.noteWrite("/out/qa-tests/auth/login.md");
        expect(store.getState().artifacts["qa-tests/auth/login.md"]).toBeDefined();
    });

    test("dotfiles and extension-less paths never become artifacts", () => {
        const store = makeStore();
        store.noteWrite(".pipeline-state.json");
        store.noteWrite("qa-tests");
        store.handleFsChange(".bfs-state.json");
        expect(store.getState().artifactOrder).toHaveLength(0);
    });

    test("atomic-write tmp files never become artifacts", () => {
        const store = makeStore();
        store.handleFsChange("recipe.json.tmp.27897.9f565a011e03");
        store.noteWrite("scratch.tmp");
        expect(store.getState().artifactOrder).toHaveLength(0);
    });

    test("well-known files carry a human title; test files do not", () => {
        const store = makeStore();
        store.noteWrite("AUTONOMA.md");
        store.noteWrite("entity-audit.md");
        store.noteWrite("qa-tests/search/sort-by-price.md");
        const s = store.getState();
        expect(s.artifacts["AUTONOMA.md"]?.title).toBe("Knowledge Base");
        expect(s.artifacts["entity-audit.md"]?.title).toBe("Database Entity Analysis");
        expect(s.artifacts["qa-tests/search/sort-by-price.md"]?.title).toBeUndefined();
    });

    test("nested test files carry their folder path as the description", () => {
        const store = makeStore();
        store.noteWrite("qa-tests/global/assistant/chat-with-ai-assistant.md");
        const art = store.getState().artifacts["qa-tests/global/assistant/chat-with-ai-assistant.md"];
        expect(art?.name).toBe("chat-with-ai-assistant.md");
        expect(art?.description).toBe("qa-tests/global/assistant/");
    });

    test("a file discovered by the fs watcher settles to DONE and follows into the hero", () => {
        const store = makeStore();
        store.startStep("projectMapper");
        store.endStep("projectMapper", "done");
        store.handleFsChange("project-map.json");
        // Watcher events are writes: hero follows them like tool writes.
        expect(store.getState().live.artifactId).toBe("project-map.json");
        vi.advanceTimersByTime(1000);
        expect(store.getState().artifacts["project-map.json"]?.status).toBe("DONE");
    });

    test("new files register at the top of the list", () => {
        const store = makeStore();
        store.noteWrite("project-map.json");
        store.noteWrite("pages.json");
        store.noteWrite("AUTONOMA.md");
        expect(store.getState().artifactOrder).toEqual(["AUTONOMA.md", "pages.json", "project-map.json"]);
    });

    test("test files sort alphabetically in a block above the pipeline files", () => {
        const store = makeStore();
        store.noteWrite("project-map.json");
        store.noteWrite("pages.json");
        store.noteWrite("qa-tests/search/sort-by-price.md");
        store.noteWrite("qa-tests/journeys/ai-assisted-discovery.md");
        store.noteWrite("qa-tests/search/filter-by-beds.md");
        expect(store.getState().artifactOrder).toEqual([
            "qa-tests/journeys/ai-assisted-discovery.md",
            "qa-tests/search/filter-by-beds.md",
            "qa-tests/search/sort-by-price.md",
            "pages.json",
            "project-map.json",
        ]);
    });

    test("a later step re-touching a settled file returns it to DONE after the write quiets", () => {
        const store = makeStore();
        store.startStep("pagesFinder");
        store.noteWrite("pages.json");
        store.endStep("pagesFinder", "done");
        expect(store.getState().artifacts["pages.json"]?.status).toBe("DONE");

        store.startStep("kb");
        store.noteWrite("pages.json");
        expect(store.getState().artifacts["pages.json"]?.status).toBe("WRITING");
        vi.advanceTimersByTime(1000);
        expect(store.getState().artifacts["pages.json"]?.status).toBe("DONE");
    });

    test("WRITING is transient: a file settles to DONE once its write quiets, even mid-step", () => {
        const store = makeStore();
        store.startStep("testGenerator");
        store.noteWrite("qa-tests/search/sort-by-price.md");
        expect(store.getState().artifacts["qa-tests/search/sort-by-price.md"]?.status).toBe("WRITING");
        vi.advanceTimersByTime(1000);
        expect(store.getState().artifacts["qa-tests/search/sort-by-price.md"]?.status).toBe("DONE");

        // A later update flips it back to WRITING for the next burst.
        store.noteWrite("qa-tests/search/sort-by-price.md");
        expect(store.getState().artifacts["qa-tests/search/sort-by-price.md"]?.status).toBe("WRITING");
        vi.advanceTimersByTime(1000);
        expect(store.getState().artifacts["qa-tests/search/sort-by-price.md"]?.status).toBe("DONE");
    });

    test("endStep(done) settles the step's artifacts to DONE", () => {
        const store = makeStore();
        store.startStep("kb");
        store.noteWrite("AUTONOMA.md");
        store.endStep("kb", "done");
        const s = store.getState();
        expect(s.steps.kb.status).toBe("done");
        expect(s.artifacts["AUTONOMA.md"]?.status).toBe("DONE");
    });

    test("after esc back to the explainer, the next write re-follows into the hero", () => {
        const store = makeStore();
        store.startStep("kb");
        store.noteWrite("AUTONOMA.md");
        store.dispatchNav({ type: "enter" }); // pin it (unfollows)
        store.dispatchNav({ type: "focusLeft" });
        store.dispatchNav({ type: "closeDocument" }); // esc: explainer + follow re-armed
        expect(store.getState().live.following).toBe(true);
        expect(store.getState().live.path).toBeUndefined();

        store.noteWrite("scenarios.md");
        expect(store.getState().live.artifactId).toBe("scenarios.md");
    });

    test("a pinned hero (following off) does not switch to newly written files", () => {
        const store = makeStore();
        store.noteWrite("AUTONOMA.md");
        store.dispatchNav({ type: "toggleFollow" });
        store.noteWrite("scenarios.md");
        expect(store.getState().live.artifactId).toBe("AUTONOMA.md");
    });

    test("warn/error logs surface in the activity feed, info stays log-only", () => {
        const store = makeStore();
        store.appendLog({ level: "info", text: "quiet" });
        store.appendLog({ level: "error", text: "boom" });
        const feed = store.getState().activityFeed;
        expect(feed).toHaveLength(1);
        expect(feed[0]?.arg).toBe("boom");
        expect(feed[0]?.failed).toBe(true);
    });

    test("a countdown shows, then auto-dismisses and resolves when it runs out", async () => {
        const store = makeStore();
        const done = store.runCountdown({ title: "Handing off", lines: ["explainer"], seconds: 10 });
        expect(store.getState().countdown?.title).toBe("Handing off");
        vi.advanceTimersByTime(10_000);
        await done;
        expect(store.getState().countdown).toBeUndefined();
    });

    test("skipCountdown resolves the countdown immediately", async () => {
        const store = makeStore();
        const done = store.runCountdown({ title: "Handing off", lines: [], seconds: 10 });
        store.skipCountdown();
        await done;
        expect(store.getState().countdown).toBeUndefined();
    });

    test("finish freezes the run with an outcome", () => {
        const store = makeStore();
        store.finish({ kind: "complete" });
        const s = store.getState();
        expect(s.finished).toBe(true);
        expect(s.outcome?.kind).toBe("complete");
        expect(s.currentStep).toBeUndefined();
    });

    test("setLiveFile updates hero text and scroll bounds", () => {
        const store = makeStore();
        const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
        store.setLiveFile("AUTONOMA.md", text, "markdown");
        const s = store.getState();
        expect(s.live.text).toBe(text);
        expect(s.live.kind).toBe("markdown");
        expect(s.nav.maxScroll).toBeGreaterThan(0);
    });

    test("hero refreshes from disk when the shown file changes on disk", async () => {
        vi.useRealTimers();
        const reader = vi.fn(async (absPath: string) => ({ text: `content of ${absPath}`, kind: "markdown" as const }));
        const store = makeStore(reader);
        store.noteWrite("AUTONOMA.md");
        await vi.waitFor(() => {
            expect(store.getState().live.text).toBe("content of /out/AUTONOMA.md");
        });
    });
});
