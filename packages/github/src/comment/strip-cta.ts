// The ways a CTA renders on its line (see `renderCta` in ./markdown):
//   - text form (current):  [PREFIX LABEL](<HREF>)                  - plain markdown link
//   - image form (current): [![LABEL](<ASSET>)](<HREF>)             - markdown image-link (Open in Autonoma, See preview)
//   - asset form (legacy):  <a href="HREF" ...><img alt="LABEL" ... /></a>
//   - text form (legacy):   <a href="HREF" ...>PREFIX LABEL</a>
// CTAs on a line are joined by `renderCtas` with " · " (current) or, on comments posted before the
// text-first refactor, "&nbsp;&nbsp;" (assets) or " | " (text). The legacy patterns are retained so
// teardown can still strip a "See preview" CTA from a comment posted before this shipped.
const CTA_SEPARATOR = /(?:&nbsp;){2}| \| | · /;

/**
 * Removes a single CTA (identified by its label, e.g. "See preview") from an already-rendered
 * comment body, preserving every other CTA and the rest of the comment. Used by the previewkit
 * teardown path to drop the now-dead preview link from the results comment without re-rendering it.
 *
 * Operates line by line so it can drop just the matching CTA token from a multi-CTA line, and drop
 * the whole line (plus the single blank line the renderer emits before it) when it was the only CTA.
 * Returns the body unchanged when the label is absent, so callers can no-op cheaply.
 */
export function stripCtaFromBody(body: string, label: string): string {
    if (!bodyContainsCta(body, label)) return body;

    const lines = body.split("\n");
    const out: string[] = [];
    for (const line of lines) {
        if (!lineContainsCta(line, label)) {
            out.push(line);
            continue;
        }
        const rebuilt = rebuildCtaLine(line, label);
        if (rebuilt != null) {
            out.push(rebuilt);
            continue;
        }
        // The CTA was the only one on its line: drop the line, and the single blank line the
        // renderer pushed before it (`sections.push("", renderCtas(...))`), so no gap is left.
        if (out.length > 0 && out[out.length - 1] === "") out.pop();
    }
    return out.join("\n");
}

function rebuildCtaLine(line: string, label: string): string | undefined {
    const separator = detectSeparator(line);
    const kept = line.split(CTA_SEPARATOR).filter((part) => !partIsCta(part, label));
    if (kept.length === 0) return undefined;
    return kept.join(separator);
}

// Rejoin with whichever separator the line actually used, so both the current and legacy forms rebuild cleanly.
function detectSeparator(line: string): string {
    if (line.includes("&nbsp;&nbsp;")) return "&nbsp;&nbsp;";
    if (line.includes(" | ")) return " | ";
    return " · ";
}

function bodyContainsCta(body: string, label: string): boolean {
    return partIsCta(body, label);
}

function lineContainsCta(line: string, label: string): boolean {
    return partIsCta(line, label);
}

function partIsCta(part: string, label: string): boolean {
    return (
        markdownCtaPattern(label).test(part) || assetCtaPattern(label).test(part) || textCtaPattern(label).test(part)
    );
}

// The current form: a markdown link `[PREFIX LABEL](` or image-link `[![LABEL](`, where the label sits
// immediately before the `](`. Matches both the text CTA and the image-link CTAs (Open in Autonoma, See
// preview). The `](` check is agnostic to the destination form, so it matches whether or not the href is
// angle-bracketed (`](<...>)`).
function markdownCtaPattern(label: string): RegExp {
    return new RegExp(`\\[[^\\]]*${escapeRegExp(label)}\\]\\(`);
}

// alt="LABEL" uniquely identifies the legacy asset-anchor CTA for this label (alt carries the escaped label).
function assetCtaPattern(label: string): RegExp {
    return new RegExp(`alt="${escapeRegExp(label)}"`);
}

// >...LABEL...</a> - the legacy text-link anchor; the label may carry an emoji prefix. The asset form
// never matches (its anchor text is empty: `/></a>`), so the two patterns stay mutually exclusive.
function textCtaPattern(label: string): RegExp {
    return new RegExp(`>[^<]*${escapeRegExp(label)}[^<]*</a>`);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
