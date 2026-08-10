/**
 * Parse a URL without throwing: `new URL` rejecting IS the answer to "is this a URL", so callers get undefined and
 * decide what that means for them - reject the input, fall back to a default, or pass the original string through.
 *
 * Deliberately silent. Whether a parse failure is worth a log line depends entirely on the caller: an
 * attacker-supplied redirect target reaching here is routine and logging it would be a free spam vector, while a
 * stored endpoint failing to parse is worth a breadcrumb. This package has no logger anyway, so the ones that want
 * a log wrap the call.
 */
export function parseUrl(candidate: string): URL | undefined {
    try {
        return new URL(candidate);
    } catch {
        return undefined;
    }
}
