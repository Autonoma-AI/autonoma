import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { UnknownImageFormatError, detectImageFormat, imageFormatFromKey } from "../src/image-format";
import { Screenshot } from "../src/screenshot";

const WIDTH = 8;
const HEIGHT = 8;

function solid() {
    return sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: { r: 1, g: 2, b: 3 } } });
}

const ENCODINGS = [
    { encode: () => solid().png(), mediaType: "image/png", extension: "png" },
    { encode: () => solid().jpeg(), mediaType: "image/jpeg", extension: "jpeg" },
    { encode: () => solid().webp(), mediaType: "image/webp", extension: "webp" },
];

describe("detectImageFormat", () => {
    it.each(ENCODINGS)("identifies a real $extension encoding", async ({ encode, mediaType, extension }) => {
        expect(detectImageFormat(await encode().toBuffer())).toEqual({ mediaType, extension });
    });

    it("rejects bytes that are not an image at all", () => {
        expect(() => detectImageFormat(Buffer.from("not an image"))).toThrow(UnknownImageFormatError);
    });
});

describe("Screenshot", () => {
    it("reports the media type and extension of its own bytes", async () => {
        const screenshot = Screenshot.fromBuffer(await solid().jpeg().toBuffer());

        expect(screenshot.mediaType).toBe("image/jpeg");
        expect(screenshot.extension).toBe("jpeg");
    });
});

describe("imageFormatFromKey", () => {
    it("reads the format a storage key's extension claims", () => {
        expect(imageFormatFromKey("s3://bucket/run/clip.gif")?.mediaType).toBe("image/gif");
        expect(imageFormatFromKey("s3://bucket/run/step-1-before.jpeg")?.mediaType).toBe("image/jpeg");
    });

    it("reads a `.jpg` key as the JPEG it names", () => {
        expect(imageFormatFromKey("s3://bucket/run/legacy.jpg")?.mediaType).toBe("image/jpeg");
    });

    it("returns undefined for an extension it does not recognise, rather than inventing one", () => {
        expect(imageFormatFromKey("s3://bucket/run/video.mp4")).toBeUndefined();
        expect(imageFormatFromKey("s3://bucket/run/no-extension")).toBeUndefined();
    });
});
