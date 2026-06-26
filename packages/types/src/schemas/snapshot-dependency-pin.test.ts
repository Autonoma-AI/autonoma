import { describe, expect, it } from "vitest";
import { parseSnapshotDependencyShaMap } from "./snapshot-dependency-pin";

describe("parseSnapshotDependencyShaMap", () => {
    it("returns an empty map for an unpinned snapshot (null)", () => {
        expect(parseSnapshotDependencyShaMap(null)).toEqual({});
        expect(parseSnapshotDependencyShaMap(undefined)).toEqual({});
    });

    it("reads back a pinned string->string map", () => {
        expect(parseSnapshotDependencyShaMap({ api: "abc123", worker: "def456" })).toEqual({
            api: "abc123",
            worker: "def456",
        });
    });

    it("preserves an empty pin distinctly (pinned, no dependencies)", () => {
        expect(parseSnapshotDependencyShaMap({})).toEqual({});
    });

    it("degrades to an empty map for a non-map or malformed value rather than throwing", () => {
        expect(parseSnapshotDependencyShaMap("abc123")).toEqual({});
        expect(parseSnapshotDependencyShaMap(["abc123"])).toEqual({});
        expect(parseSnapshotDependencyShaMap({ api: 123 })).toEqual({});
    });
});
