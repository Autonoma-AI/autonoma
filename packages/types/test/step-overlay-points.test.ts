import { describe, expect, it } from "vitest";
import { getStepOverlayPoints } from "../src/types/step-overlay-points";

describe("getStepOverlayPoints", () => {
    it("extracts a click point tagged with the click role", () => {
        expect(getStepOverlayPoints({ outcome: "ok", point: { x: 12, y: 34 } })).toEqual([
            { x: 12, y: 34, role: "click" },
        ]);
    });

    it("extracts a drag's start and end points tagged with their roles", () => {
        expect(getStepOverlayPoints({ outcome: "ok", startPoint: { x: 1, y: 2 }, endPoint: { x: 3, y: 4 } })).toEqual([
            { x: 1, y: 2, role: "drag-start" },
            { x: 3, y: 4, role: "drag-end" },
        ]);
    });

    it("returns an empty array for outputs with no points", () => {
        expect(getStepOverlayPoints({ outcome: "ok", text: "hello" })).toEqual([]);
    });

    it("returns an empty array for non-object outputs", () => {
        expect(getStepOverlayPoints(undefined)).toEqual([]);
        expect(getStepOverlayPoints(null)).toEqual([]);
        expect(getStepOverlayPoints("not an output")).toEqual([]);
    });

    it("ignores malformed point fields rather than throwing", () => {
        expect(getStepOverlayPoints({ point: { x: "nope", y: 1 } })).toEqual([]);
    });
});
