import { JSDOM } from "jsdom";
import { buildNodeWithSN, createCache, createMirror, rebuild } from "rrweb-snapshot";
import { describe, expect, it } from "vitest";
import { ansiToRows } from "../../src/replay/ansi-to-rows";
import { FrameDiffer } from "../../src/replay/frame-differ";
import { HeadlessRenderer } from "../../src/replay/headless-renderer";
import type { ReplayEvent } from "../../src/replay/types";
import { buildScenes } from "../../src/ui/fixtures";

const FULL_SNAPSHOT = 2;
const MUTATION = 3;

/**
 * Replays our events through rrweb itself, the way a player does.
 *
 * This exists because asserting the shape of our own JSON is not evidence that
 * anything renders it. A mutation `add` is built with `skipChild: true`, so a
 * node arriving with nested `childNodes` loses them silently - a bug no
 * structural assertion catches, and one that shipped.
 */
function replay(events: ReplayEvent[]): string {
    const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>");
    const doc = dom.window.document;
    const mirror = createMirror();
    const cache = createCache();

    for (const event of events) {
        if (event.type === FULL_SNAPSHOT) {
            // Scripting is disabled on this jsdom document, so there is nothing to protect against.
            rebuild(event.data.node, { doc, mirror, cache, UNSAFE_allowUnprotectedRebuild: true });
            continue;
        }
        if (event.type !== MUTATION || !("removes" in event.data)) continue;

        for (const remove of event.data.removes) {
            const target = mirror.getNode(remove.id);
            const parent = mirror.getNode(remove.parentId);
            expect(target, `remove referenced an unknown node ${remove.id}`).not.toBeNull();
            expect(parent, `remove referenced an unknown parent ${remove.parentId}`).not.toBeNull();
            mirror.removeNodeFromMap(target!);
            parent!.removeChild(target!);
        }
        for (const add of event.data.adds) {
            const parent = mirror.getNode(add.parentId);
            expect(parent, `add referenced an unknown parent ${add.parentId}`).not.toBeNull();
            // The exact call rrweb's Replayer makes for mutation adds.
            const built = buildNodeWithSN(add.node, { doc, mirror, cache, skipChild: true, hackCss: true });
            parent!.appendChild(built!);
        }
    }

    const pre = doc.querySelector("pre");
    const rows = [...(pre?.querySelectorAll(":scope > div") ?? [])];
    return rows.map((row) => row.textContent).join("\n");
}

function framesToEvents(frames: string[]): ReplayEvent[] {
    const differ = new FrameDiffer();
    return frames.flatMap((frame, index) => differ.next(ansiToRows(frame), 1000 + index * 500));
}

describe("rrweb playback of our events", () => {
    it("renders a changed row, rather than emptying it", () => {
        const before = ["alpha one", "beta two", "gamma three"].join("\n");
        const after = ["alpha one", "BETA CHANGED", "gamma three"].join("\n");
        expect(replay(framesToEvents([before, after]))).toBe(after);
    });

    it("survives a long chain of mutations", () => {
        const frames = Array.from({ length: 12 }, (_, i) =>
            ["header", `counter ${i}`, "static line", `progress ${"#".repeat(i)}`].join("\n"),
        );
        const last = frames[frames.length - 1]!;
        expect(replay(framesToEvents(frames))).toBe(last);
    });

    it("recovers when the row count changes and forces a fresh snapshot", () => {
        const two = ["one", "two"].join("\n");
        const three = ["one", "two", "three"].join("\n");
        expect(replay(framesToEvents([two, three, two]))).toBe(two);
    });

    it("never emits a mutation add carrying nested children", () => {
        // The invariant behind the bug above, pinned directly so a regression is
        // obvious even if rrweb's own behaviour changes.
        const events = framesToEvents(["a\nb\nc", "a\nCHANGED\nc", "a\nCHANGED\nz"]);
        const adds = events
            .filter((event) => event.type === MUTATION && "adds" in event.data)
            .flatMap((event) => (event.type === MUTATION && "adds" in event.data ? event.data.adds : []));
        expect(adds.length).toBeGreaterThan(0);
        for (const add of adds) expect(add.node.childNodes ?? []).toHaveLength(0);
    });

    it("reproduces real dashboard frames through the whole pipeline", () => {
        const renderer = new HeadlessRenderer({ columns: 132, rows: 34 });
        const scenes = buildScenes();
        const frames = scenes.map((scene) => renderer.frame(scene.store.getState()));
        renderer.dispose();

        const expected = ansiToRows(frames[frames.length - 1]!)
            .map((row) => row.runs.map((run) => run.text).join(""))
            .join("\n");
        expect(replay(framesToEvents(frames))).toBe(expected);
    });
});
