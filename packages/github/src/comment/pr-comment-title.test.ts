import { describe, expect, it } from "vitest";
import { toPrCommentTitle } from "./pr-comment-title";

describe("toPrCommentTitle", () => {
    it("strips a leading Autonoma from a settled analysis title before prefixing", () => {
        expect(toPrCommentTitle("Autonoma found 2 bugs in this PR")).toBe("Autonoma - found 2 bugs in this PR");
        expect(toPrCommentTitle("Autonoma verified this change")).toBe("Autonoma - verified this change");
    });

    it("prefixes a title that does not lead with the brand", () => {
        expect(toPrCommentTitle("No tests needed for this change")).toBe("Autonoma - No tests needed for this change");
    });

    it("builds the pre-settle state titles", () => {
        expect(toPrCommentTitle("analyzing this PR")).toBe("Autonoma - analyzing this PR");
        expect(toPrCommentTitle("building preview")).toBe("Autonoma - building preview");
    });

    it("does not match a bare brand word as a lead to strip", () => {
        // "Autonoma" with no trailing space is not the "Autonoma <rest>" lead, so it is kept as the body.
        expect(toPrCommentTitle("Autonoma")).toBe("Autonoma - Autonoma");
    });
});
