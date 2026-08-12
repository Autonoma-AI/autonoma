export interface ImageFormat {
    mediaType: string;
    /** Filename extension, WITHOUT the dot - what a storage key for these bytes should end in. */
    extension: string;
}

/**
 * WebP's signature is split: bytes 0-3 are `RIFF` and 8-11 are `WEBP`, with the file size in between, so it
 * is matched on the second half at its own offset.
 */
const SIGNATURES: readonly {
    readonly bytes: readonly number[];
    readonly offset: number;
    readonly format: ImageFormat;
}[] = [
    { bytes: [0x89, 0x50, 0x4e, 0x47], offset: 0, format: { mediaType: "image/png", extension: "png" } },
    { bytes: [0xff, 0xd8, 0xff], offset: 0, format: { mediaType: "image/jpeg", extension: "jpeg" } },
    { bytes: [0x57, 0x45, 0x42, 0x50], offset: 8, format: { mediaType: "image/webp", extension: "webp" } },
    { bytes: [0x47, 0x49, 0x46, 0x38], offset: 0, format: { mediaType: "image/gif", extension: "gif" } },
];

export class UnknownImageFormatError extends Error {
    constructor(byteLength: number) {
        super(`Buffer of ${byteLength} bytes does not start with a recognised image signature (PNG, JPEG, WebP, GIF)`);
    }
}

export function detectImageFormat(buffer: Buffer): ImageFormat {
    const match = SIGNATURES.find(({ bytes, offset }) => bytes.every((byte, index) => buffer[offset + index] === byte));
    if (match == null) throw new UnknownImageFormatError(buffer.length);
    return match.format;
}

/** Spellings that name a format we already know, but are not what we write. */
const EXTENSION_ALIASES: Readonly<Record<string, string>> = { jpg: "jpeg" };

/**
 * The format a key's extension CLAIMS. Our own keys say `.png` for JPEG bytes, so prefer
 * {@link detectImageFormat} unless the bytes are genuinely out of reach.
 */
export function imageFormatFromKey(key: string): ImageFormat | undefined {
    const suffix = key.split(".").pop()?.toLowerCase();
    if (suffix == null) return undefined;
    const extension = EXTENSION_ALIASES[suffix] ?? suffix;
    return SIGNATURES.find(({ format }) => format.extension === extension)?.format;
}
