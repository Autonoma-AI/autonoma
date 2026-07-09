import { describe, expect, it } from "vitest";
import { extractEvidenceAssetIds, stripUnbackedNarrativeImages } from "../src/schemas/evidence-tokens";

describe("extractEvidenceAssetIds", () => {
    it("extracts the assetId from an evidence image token", () => {
        expect(extractEvidenceAssetIds("Before the click ![](evidence:s3-before) it was fine.")).toEqual(["s3-before"]);
    });

    it("extracts ids from tokens with captions and titles", () => {
        const markdown = '![Login greyed out](evidence:s3-before) and ![](evidence:s3-after "shot")';
        expect(extractEvidenceAssetIds(markdown)).toEqual(["s3-before", "s3-after"]);
    });

    it("dedupes repeated ids, preserving first-seen order", () => {
        const markdown = "![](evidence:s5-after) then ![](evidence:s3-before) then ![again](evidence:s5-after)";
        expect(extractEvidenceAssetIds(markdown)).toEqual(["s5-after", "s3-before"]);
    });

    it("ignores non-evidence images", () => {
        expect(extractEvidenceAssetIds("![diagram](https://example.com/a.png)")).toEqual([]);
    });

    it("returns an empty array when there are no tokens", () => {
        expect(extractEvidenceAssetIds("Just prose, no evidence.")).toEqual([]);
    });
});

describe("stripUnbackedNarrativeImages", () => {
    it("removes evidence tokens whose asset is not backed and reports them", () => {
        const result = stripUnbackedNarrativeImages(
            "keep ![](evidence:real) drop ![](evidence:fake) end",
            new Set(["real"]),
        );
        expect(result.markdown).toBe("keep ![](evidence:real) drop  end");
        expect(result.strippedSrcs).toEqual(["evidence:fake"]);
    });

    it("removes a fabricated raw storage path", () => {
        const result = stripUnbackedNarrativeImages(
            "See ![Error Screenshot](cmrb8bwct00150nx8otmu9nhu/6/after.png) here.",
            new Set(["s6-after"]),
        );
        expect(result.markdown).toBe("See  here.");
        expect(result.strippedSrcs).toEqual(["cmrb8bwct00150nx8otmu9nhu/6/after.png"]);
    });

    it("removes external and relative URL images even when other evidence is backed", () => {
        const result = stripUnbackedNarrativeImages(
            "![ok](evidence:s1-before) ![ext](https://example.com/a.png) ![rel](/shots/b.png)",
            new Set(["s1-before"]),
        );
        expect(result.markdown).toBe("![ok](evidence:s1-before)  ");
        expect(result.strippedSrcs).toEqual(["https://example.com/a.png", "/shots/b.png"]);
    });

    it("leaves the narrative untouched when every image is a backed token", () => {
        const markdown = "![a](evidence:s1-before) and ![b](evidence:s1-after)";
        const result = stripUnbackedNarrativeImages(markdown, new Set(["s1-before", "s1-after"]));
        expect(result.markdown).toBe(markdown);
        expect(result.strippedSrcs).toEqual([]);
    });

    it("strips every image when the manifest is empty", () => {
        const result = stripUnbackedNarrativeImages("text ![](evidence:x) more ![](a/b.png)", new Set());
        expect(result.markdown).toBe("text  more ");
        expect(result.strippedSrcs).toEqual(["evidence:x", "a/b.png"]);
    });
});
