import { stripUnbackedNarrativeImages } from "@autonoma/types";

// Order matters below: images are removed FIRST (via the shared evidence gate), because `![alt](src)` contains a
// link-shaped tail - unwrapping links first would leave a stray `!alt` behind.
const MARKDOWN_LINK_RE = /\[([^\]]*)\]\(\s*[^\s)]+[^)]*\)/g;
const HEADING_PREFIX_RE = /^\s{0,3}#{1,6}\s+/gm;
const WHITESPACE_RUN_RE = /\s+/g;

/**
 * Flatten one of the Reporter's authored plain-text surfaces - the PR's title and its headline - into the single
 * paragraph both of their renderers require: a GitHub comment body and the PR page. Neither resolves our inline
 * `evidence:`/`issue:`/`finding:` tokens or renders block markdown, so a heading or a token link that slipped past the
 * prompt would show as literal syntax there. Enforced rather than trusted - the prompt asks for plain prose, and this
 * guarantees it.
 *
 * Links are unwrapped to their text (never dropped) so the sentence still reads; images are removed outright,
 * since a comment paragraph has nowhere to put one.
 */
export function toPlainSummary(authored: string): string {
    const { markdown: imageless } = stripUnbackedNarrativeImages(authored, new Set());
    return imageless
        .replace(HEADING_PREFIX_RE, "")
        .replace(MARKDOWN_LINK_RE, "$1")
        .replace(WHITESPACE_RUN_RE, " ")
        .trim();
}
