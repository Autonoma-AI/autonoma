import { z } from "zod";
import { overlayPointSchema } from "../types/step-overlay-points";

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

/**
 * The link-token schemes the analysis report prose (and issue narratives) use to cross-reference the report's own
 * entities: a branch-scoped, cross-snapshot issue (`[text](issue:<id>)`) and a per-snapshot finding
 * (`[text](finding:<slug>)`). Unlike `evidence:` - a Markdown IMAGE that renders inline - these are Markdown
 * LINKS the renderer resolves to in-app routes. A token that references an unknown id/slug renders as its plain
 * text (no dangling link), the link counterpart of an unbacked `evidence:` image rendering as nothing.
 */
export const ISSUE_TOKEN_SCHEME = "issue:";
export const FINDING_TOKEN_SCHEME = "finding:";

/**
 * One narrative-embedded evidence asset resolved for the client: a short-lived signed URL, never the raw storage
 * key. The narrative references it by `evidence:<assetId>` token; the API resolves the referenced tokens against a
 * report/issue evidence manifest, and the renderer looks each token up here to draw the image (with its pin) - or
 * nothing when the token has no resolved asset. Shared across every surface that resolves an evidence manifest.
 */
export const resolvedEvidenceAssetSchema = z.object({
    assetId: z.string(),
    url: z.string(),
    kind: z.enum(["screenshot", "step_output"]),
    pin: overlayPointSchema.optional(),
});
export type ResolvedEvidenceAsset = z.infer<typeof resolvedEvidenceAssetSchema>;

// Matches any Markdown image: `![alt](<src>)` (an optional title after the src is
// tolerated). Group 1 is the src, which runs to the first whitespace or closing
// paren. Matching every image - not just evidence-scheme ones - is what lets the
// sanitizer neutralize a fabricated raw path, not only an unbacked token.
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(\s*([^\s)]+)[^)]*\)/g;

// Matches a Markdown link or image whose destination carries one of our token schemes. Group 1 is the
// leading "!" (present on an image, absent on a link), group 2 the label, group 3 the scheme, group 4 the
// id/slug. Deliberately narrower than MARKDOWN_IMAGE_RE: this one is a renderer, not a sanitizer, so it only
// touches destinations it knows how to resolve and leaves ordinary links alone.
const NARRATIVE_TOKEN_RE = /(!?)\[([^\]]*)\]\(\s*(evidence:|issue:|finding:)([^\s)]*)[^)]*\)/g;

/**
 * How a caller resolves the two token schemes that have a destination outside the app. Both are optional: a
 * scheme with no resolver, or a resolver that returns undefined for an id it does not know, degrades that
 * token to its plain label - the same "a fabricated reference resolves to nothing" rule the UI renderer follows.
 */
export interface NarrativeTokenResolvers {
    issueUrl?: (issueId: string) => string | undefined;
    evidenceUrl?: (assetId: string) => string | undefined;
}

/**
 * Rewrite a narrative's in-app tokens into Markdown a reader outside the app can follow: an `issue:` token
 * becomes a link to the issue page and an `evidence:` image its signed URL. A `finding:` token always degrades
 * to its label, because a finding is per-snapshot and its slug names nothing reachable outside the app.
 */
export function flattenNarrativeTokens(markdown: string, resolvers: NarrativeTokenResolvers = {}): string {
    return markdown.replace(NARRATIVE_TOKEN_RE, (_match, bang: string, label: string, scheme: string, id: string) => {
        const isImage = bang === "!";
        const resolved = resolveNarrativeToken(scheme, id, isImage, resolvers);
        if (resolved == null) return label;
        return isImage ? `![${label}](${resolved})` : `[${label}](${resolved})`;
    });
}

function resolveNarrativeToken(
    scheme: string,
    id: string,
    isImage: boolean,
    resolvers: NarrativeTokenResolvers,
): string | undefined {
    // An `evidence:` token is only ever an image and an `issue:` token only ever a link; a narrative that
    // crosses them is malformed, and rendering it as plain text is the same degradation an unknown id gets.
    if (scheme === EVIDENCE_TOKEN_SCHEME) return isImage ? resolvers.evidenceUrl?.(id) : undefined;
    if (scheme === ISSUE_TOKEN_SCHEME) return isImage ? undefined : resolvers.issueUrl?.(id);
    return undefined;
}

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
