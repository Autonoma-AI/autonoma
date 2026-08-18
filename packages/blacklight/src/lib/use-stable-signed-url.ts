"use client";

import { useState } from "react";

/** The stable identity of a (possibly signed) URL: everything before the query string. */
function pathOf(url: string): string {
    const query = url.indexOf("?");
    return query === -1 ? url : url.slice(0, query);
}

/**
 * Pins a media URL across re-signings. A signed S3 URL gets a fresh signature (a new query string) on every read,
 * so a polling query hands the same asset a different `src` each tick - which would reload a `<video>` or re-fetch
 * an `<img>` on every poll. This returns the FIRST url seen for a given path and only adopts a new one when the
 * path itself changes (a genuinely different asset), so the element keeps one URL for the asset's signed lifetime
 * instead of thrashing. A URL with no query string (or one whose path is unchanged) passes through untouched.
 */
export function useStableSignedUrl(url: string): string;
export function useStableSignedUrl(url: string | undefined): string | undefined;
export function useStableSignedUrl(url: string | undefined): string | undefined {
    const [pinned, setPinned] = useState(url);
    // When url goes absent, clear the pin (next = undefined) so a later re-sign on the same path adopts the fresh
    // signature instead of returning the stale one. While url is present, keep the first URL seen for its path.
    const next = url == null ? undefined : pinned != null && pathOf(pinned) === pathOf(url) ? pinned : url;
    if (next !== pinned) setPinned(next);
    return next;
}
