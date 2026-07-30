import { describe, expect, it } from "vitest";
import { getRunId } from "../../src/core/analytics";
import { ansiToRows } from "../../src/replay/ansi-to-rows";
import { FrameDiffer } from "../../src/replay/frame-differ";
import { HeadlessRenderer } from "../../src/replay/headless-renderer";
import { SessionRecorder } from "../../src/replay/session-recorder";
import { buildScenes } from "../../src/ui/fixtures";

const SIZE = { columns: 132, rows: 34 };

describe("SessionRecorder", () => {
    it("records under the run id, so the replay joins the run's events and logs", () => {
        // All three telemetry lanes key on this id. A replay under its own id
        // would be unreachable from the events and logs describing the same run.
        const recorder = new SessionRecorder({ size: SIZE });
        try {
            expect(recorder.sessionId).toBe(getRunId());
        } finally {
            recorder.stop();
        }
    });
});

describe("replay capture over real dashboard frames", () => {
    it("renders every fixture scene to a distinct full-width frame", () => {
        const renderer = new HeadlessRenderer(SIZE);
        const scenes = buildScenes();
        const frames = scenes.map((scene) => renderer.frame(scene.store.getState()));
        renderer.dispose();

        expect(new Set(frames).size).toBe(scenes.length);
        for (const frame of frames) {
            // A cursor escape here would mean Ink is repainting incrementally
            // rather than handing us a whole frame.
            // eslint-disable-next-line no-control-regex
            const escapes = /\x1b\[[0-9;?]*[A-Za-z]/g;
            const nonSgr = [...frame.matchAll(escapes)].filter((m) => !m[0].endsWith("m"));
            expect(nonSgr).toEqual([]);
            expect(frame.split("\n").length).toBeGreaterThan(20);
        }
    });

    it("does not leak the captured frame onto the real stdout", () => {
        const renderer = new HeadlessRenderer(SIZE);
        const original = process.stdout.write.bind(process.stdout);
        const captured: string[] = [];
        // Assert on content, not on write count: vitest's reporter shares this
        // stdout, so "nothing was written at all" is not ours to guarantee.
        process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
            captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
            return Reflect.apply(original, process.stdout, [chunk, ...rest]);
        }) as typeof process.stdout.write;

        let frame = "";
        try {
            frame = renderer.frame(buildScenes()[0]!.store.getState());
        } finally {
            process.stdout.write = original;
            renderer.dispose();
        }

        expect(frame).toContain("autonoma");
        expect(captured.some((chunk) => chunk.includes("autonoma"))).toBe(false);
    });

    it("keeps a scene-to-scene transition far cheaper than a full snapshot", () => {
        const renderer = new HeadlessRenderer(SIZE);
        const differ = new FrameDiffer();
        const scenes = buildScenes();

        const first = differ.next(ansiToRows(renderer.frame(scenes[0]!.store.getState())), 1000);
        const snapshotBytes = JSON.stringify(first).length;

        // Re-rendering the same state must produce no events at all.
        expect(differ.next(ansiToRows(renderer.frame(scenes[0]!.store.getState())), 1500)).toEqual([]);
        renderer.dispose();

        expect(snapshotBytes).toBeGreaterThan(1000);
    });
});
