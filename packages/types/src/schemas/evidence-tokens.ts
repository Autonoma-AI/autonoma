/**
 * The reference-token contract that anchors inline evidence in a bug report's
 * narrative. The healing agent embeds a fetched screenshot as a Markdown image
 * whose URL is `evidence:<assetId>` (never a raw URL or storage path); the backend
 * resolves those tokens against the report's evidence manifest at detail-build
 * time, and the UI renders each resolved token as an inline image.
 *
 * Centralised here so the authoring side (which computes the manifest), the
 * apply-time validator (which strips every image not backed by the manifest), and
 * the renderer (which matches the scheme) all agree on one grammar.
 */
export const EVIDENCE_TOKEN_SCHEME = "evidence:";

// Matches any Markdown image: `![alt](<src>)` (an optional title after the src is
// tolerated). Group 1 is the src, which runs to the first whitespace or closing
// paren. Matching every image - not just evidence-scheme ones - is what lets the
// sanitizer neutralize a fabricated raw path, not only an unbacked token.
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(\s*([^\s)]+)[^)]*\)/g;

/**
 * The unique evidence assetIds an image token references in the narrative, in
 * first-seen order. Used by the author to size the manifest to what the narrative
 * actually embeds, and by the API to resolve only referenced tokens.
 */
export function extractEvidenceAssetIds(markdown: string): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const match of markdown.matchAll(MARKDOWN_IMAGE_RE)) {
        const src = match[1];
        if (src == null || !src.startsWith(EVIDENCE_TOKEN_SCHEME)) continue;
        const id = src.slice(EVIDENCE_TOKEN_SCHEME.length);
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
    }
    return ids;
}

/**
 * Remove every Markdown image whose src is not a manifest-backed
 * `evidence:<assetId>` token, returning the cleaned Markdown and the srcs that
 * were stripped. An unbacked evidence token, a raw storage path, and an external
 * URL are all stripped alike: an agent-authored narrative has exactly one way to
 * embed an image - a token minted for evidence it really fetched. This is the
 * apply-time gate that keeps a persisted narrative from surfacing anything else.
 */
export function stripUnbackedNarrativeImages(
    markdown: string,
    backedAssetIds: ReadonlySet<string>,
): { markdown: string; strippedSrcs: string[] } {
    const strippedSrcs: string[] = [];
    const cleaned = markdown.replace(MARKDOWN_IMAGE_RE, (match, src: string) => {
        const isBackedToken =
            src.startsWith(EVIDENCE_TOKEN_SCHEME) && backedAssetIds.has(src.slice(EVIDENCE_TOKEN_SCHEME.length));
        if (isBackedToken) return match;
        strippedSrcs.push(src);
        return "";
    });
    return { markdown: cleaned, strippedSrcs };
}
