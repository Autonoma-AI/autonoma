import { describe, expect, it } from "vitest";
import { extractEntityIds } from "../src/worker/extract-entity-ids";

describe("extractEntityIds", () => {
    it("reads snapshotId from an activity input object", () => {
        expect(extractEntityIds([{ snapshotId: "snap-1" }])).toEqual({ snapshotId: "snap-1" });
    });

    it("reads testGenerationId from an activity input object", () => {
        expect(extractEntityIds([{ testGenerationId: "gen-1" }])).toEqual({ testGenerationId: "gen-1" });
    });

    it("treats generationId as an alias for testGenerationId", () => {
        expect(extractEntityIds([{ generationId: "gen-2" }])).toEqual({ testGenerationId: "gen-2" });
    });

    it("prefers an explicit testGenerationId over a generationId alias on the same arg", () => {
        expect(extractEntityIds([{ testGenerationId: "gen-real", generationId: "gen-alias" }])).toEqual({
            testGenerationId: "gen-real",
        });
    });

    it("ignores a non-string or empty generationId", () => {
        expect(extractEntityIds([{ generationId: 42 }])).toEqual({});
        expect(extractEntityIds([{ generationId: "" }])).toEqual({});
    });

    it("returns an empty object when no arg carries a recognized id", () => {
        expect(extractEntityIds([{ foo: "bar" }, "not an object", null, 42])).toEqual({});
    });

    it("combines ids found across multiple args", () => {
        expect(extractEntityIds([{ snapshotId: "snap-1" }, { generationId: "gen-1" }])).toEqual({
            snapshotId: "snap-1",
            testGenerationId: "gen-1",
        });
    });
});
