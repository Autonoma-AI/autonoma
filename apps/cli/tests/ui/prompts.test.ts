import { afterEach, describe, expect, test } from "vitest";
import * as p from "../../src/ui/prompts";
import { createStore, setActiveStore, type RunStore } from "../../src/ui/store";

const META = { title: "t", project: "p", version: "0" };

function activeStore(): RunStore {
    const store = createStore({ outputDir: "/out", meta: META });
    setActiveStore(store);
    return store;
}

afterEach(() => {
    setActiveStore(undefined);
});

describe("prompts facade with the TUI mounted", () => {
    test("log/note/intro/outro feed the store", () => {
        const store = activeStore();
        p.intro("hello");
        p.log.info("info line");
        p.log.error("error line");
        p.note("body", "Title");
        p.outro("bye");
        const log = store.getState().log;
        expect(log.map((e) => e.level)).toEqual(["intro", "info", "error", "note", "outro"]);
        expect(log[3]?.title).toBe("Title");
    });

    test("confirm renders as a prompt and resolves on submit", async () => {
        const store = activeStore();
        const pending = p.confirm({ message: "Continue?", initialValue: true });
        expect(store.getState().prompt.current?.kind).toBe("confirm");
        store.submitPrompt();
        await expect(pending).resolves.toBe(true);
        expect(store.getState().prompt.current).toBeUndefined();
    });

    test("select resolves to the highlighted option, honoring initialValue", async () => {
        const store = activeStore();
        const pending = p.select({
            message: "pick",
            options: [
                { value: "a", label: "A" },
                { value: "b", label: "B" },
            ],
            initialValue: "b",
        });
        store.submitPrompt();
        await expect(pending).resolves.toBe("b");
    });

    test("multiselect toggles and resolves in option order", async () => {
        const store = activeStore();
        const pending = p.multiselect({
            message: "pick many",
            options: [
                { value: "x", label: "X" },
                { value: "y", label: "Y" },
            ],
            initialValues: ["y"],
        });
        store.dispatchPrompt({ type: "toggle" }); // checks "x" (cursor on first)
        store.submitPrompt();
        await expect(pending).resolves.toEqual(["x", "y"]);
    });

    test("text collects typed input; esc cancels only cancelable prompts", async () => {
        const store = activeStore();
        const first = p.text({ message: "name?" });
        store.dispatchPrompt({ type: "input", text: "hi" });
        store.submitPrompt();
        await expect(first).resolves.toBe("hi");

        // Default: esc is a no-op that explains how to quit.
        void p.text({ message: "must answer" });
        store.cancelPrompt();
        expect(store.getState().prompt.current).toBeDefined();
        expect(store.getState().prompt.draft.error).toContain("Ctrl+C");
        store.submitPrompt();

        const third = p.text({ message: "skippable?", cancelable: true });
        store.cancelPrompt();
        expect(p.isCancel(await third)).toBe(true);
    });

    test("questions queue and present one at a time", async () => {
        const store = activeStore();
        const a = p.confirm({ message: "first?" });
        const b = p.confirm({ message: "second?", initialValue: false });
        expect(store.getState().prompt.current?.message).toBe("first?");
        expect(store.getState().prompt.queued).toBe(1);
        store.submitPrompt();
        await expect(a).resolves.toBe(true);
        expect(store.getState().prompt.current?.message).toBe("second?");
        store.submitPrompt();
        await expect(b).resolves.toBe(false);
    });

    test("an empty required multiselect refuses to submit with an inline error", () => {
        const store = activeStore();
        void p.multiselect({
            message: "must pick",
            options: [{ value: "x", label: "X" }],
        });
        store.submitPrompt();
        expect(store.getState().prompt.current).toBeDefined();
        expect(store.getState().prompt.draft.error).toContain("at least one");
    });
});

describe("prompts facade headless (no store)", () => {
    test("confirm resolves to its default; text falls back to defaultValue or cancel", async () => {
        await expect(p.confirm({ message: "?" })).resolves.toBe(true);
        await expect(p.confirm({ message: "?", initialValue: false })).resolves.toBe(false);
        await expect(p.text({ message: "?", defaultValue: "d" })).resolves.toBe("d");
        expect(p.isCancel(await p.text({ message: "?" }))).toBe(true);
    });

    test("select/multiselect resolve to initial values or cancel", async () => {
        await expect(
            p.select({ message: "?", options: [{ value: "a", label: "A" }], initialValue: "a" }),
        ).resolves.toBe("a");
        expect(p.isCancel(await p.select({ message: "?", options: [{ value: "a", label: "A" }] }))).toBe(true);
        await expect(
            p.multiselect({ message: "?", options: [{ value: "a", label: "A" }], initialValues: ["a"] }),
        ).resolves.toEqual(["a"]);
    });
});

describe("emergency teardown", () => {
    test("teardownUi runs the registered teardown once and clears it", async () => {
        const { registerUiTeardown, teardownUi } = await import("../../src/core/ui-lifecycle");
        let calls = 0;
        registerUiTeardown(() => calls++);
        teardownUi();
        teardownUi();
        expect(calls).toBe(1);
    });
});
