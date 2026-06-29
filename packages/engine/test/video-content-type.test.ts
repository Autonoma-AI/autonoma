import { describe, expect, it } from "vitest";
import { videoContentType } from "../src/platform/video-content-type";

describe("videoContentType", () => {
    it("maps web recordings to video/webm so browsers can seek them", () => {
        expect(videoContentType("webm")).toBe("video/webm");
    });

    it("maps mobile recordings to video/mp4", () => {
        expect(videoContentType("mp4")).toBe("video/mp4");
    });

    it("ignores a leading dot and casing in the extension", () => {
        expect(videoContentType(".WEBM")).toBe("video/webm");
    });

    it("falls back to octet-stream for unknown extensions", () => {
        expect(videoContentType("mov")).toBe("application/octet-stream");
    });
});
