import { describe, expect, it } from "vitest";
import { ansiToRows } from "../../src/replay/ansi-to-rows";
import { FrameDiffer } from "../../src/replay/frame-differ";
import type { MutationEvent, ReplayEvent } from "../../src/replay/types";

const FULL_SNAPSHOT = 2;
const MUTATION = 3;

function frame(lines: string[]): ReturnType<typeof ansiToRows> {
    return ansiToRows(lines.join("\n"));
}

function isMutation(event: ReplayEvent | undefined): event is MutationEvent {
    return event != null && event.type === MUTATION && "removes" in event.data;
}

function mutationOf(events: ReplayEvent[]): MutationEvent {
    const event = events[0];
    if (!isMutation(event)) throw new Error(`expected a mutation, got ${JSON.stringify(events).slice(0, 120)}`);
    return event;
}

/**
 * Rows touched by a mutation. Taken from `removes`, whose parent is always a
 * row - `adds` also carry text nodes parented to their span, since a mutation
 * add cannot nest children.
 */
function touchedRowIds(event: MutationEvent): number[] {
    return [...new Set(event.data.removes.map((remove) => remove.parentId))].sort((a, b) => a - b);
}

describe("FrameDiffer", () => {
    it("emits a full snapshot for the first frame", () => {
        const events = new FrameDiffer().next(frame(["a", "b"]), 1000);
        expect(events).toHaveLength(1);
        expect(events[0]?.type).toBe(FULL_SNAPSHOT);
    });

    it("emits nothing when the frame is unchanged", () => {
        const differ = new FrameDiffer();
        differ.next(frame(["a", "b"]), 1000);
        expect(differ.next(frame(["a", "b"]), 1500)).toEqual([]);
    });

    it("rebuilds only the rows that changed", () => {
        const differ = new FrameDiffer();
        differ.next(frame(["one", "two", "three", "four"]), 1000);
        const event = mutationOf(differ.next(frame(["one", "CHANGED", "three", "four"]), 1500));

        expect(touchedRowIds(event)).toHaveLength(1);
        expect(event.data.adds.some((add) => add.node.textContent === "CHANGED")).toBe(true);
        // The old spans must be removed, or the row accumulates stale text.
        expect(event.data.removes.length).toBeGreaterThan(0);
        // Every added node must land under a parent this mutation knows about:
        // the touched row, or a span the same mutation just added.
        const knownParents = new Set([...touchedRowIds(event), ...event.data.adds.map((add) => add.node.id)]);
        for (const add of event.data.adds) expect(knownParents.has(add.parentId)).toBe(true);
    });

    it("falls back to a full snapshot when the row count changes", () => {
        const differ = new FrameDiffer();
        differ.next(frame(["a", "b"]), 1000);
        const events = differ.next(frame(["a", "b", "c"]), 1500);
        expect(events[0]?.type).toBe(FULL_SNAPSHOT);
    });

    it("re-snapshots after invalidate, since the player's DOM is gone", () => {
        const differ = new FrameDiffer();
        differ.next(frame(["a", "b"]), 1000);
        differ.invalidate();
        expect(differ.next(frame(["a", "b"]), 1500)[0]?.type).toBe(FULL_SNAPSHOT);
    });

    it("never reuses a node id, so the player's mirror stays consistent", () => {
        const differ = new FrameDiffer();
        const seen = new Set<number>();
        const collect = (node: { id: number; childNodes?: { id: number }[] }) => {
            expect(seen.has(node.id)).toBe(false);
            seen.add(node.id);
        };

        differ.next(frame(["a", "b"]), 1000);
        for (let i = 0; i < 5; i++) {
            const event = mutationOf(differ.next(frame([`a${i}`, "b"]), 1000 + i));
            for (const add of event.data.adds) collect(add.node);
        }
    });

    it("costs far less than a full snapshot for a small change", () => {
        // The whole reason diffing exists: a 30-minute run cannot afford a full
        // snapshot per frame.
        const wide = Array.from({ length: 34 }, (_, i) => `row ${i} `.repeat(14));
        const differ = new FrameDiffer();
        const snapshotBytes = JSON.stringify(differ.next(ansiToRows(wide.join("\n")), 1000)).length;

        const changed = [...wide];
        changed[7] = "row 7 changed";
        const mutationBytes = JSON.stringify(differ.next(ansiToRows(changed.join("\n")), 1500)).length;

        expect(mutationBytes).toBeLessThan(snapshotBytes / 10);
    });
});
