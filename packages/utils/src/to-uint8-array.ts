/**
 * Views a Buffer as a plain Uint8Array without copying. `node:crypto`'s types
 * accept `Uint8Array` but not every `Buffer` overload under our strict settings,
 * so the crypto helpers in this package funnel their buffers through here.
 */
export function toUint8Array(buf: Buffer): Uint8Array {
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
