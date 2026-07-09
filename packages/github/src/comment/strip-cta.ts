// The two ways a CTA renders on its line (see `renderCta` in ./markdown), both now inline <a> anchors:
//   - asset form:  <a href="HREF" target="_blank" ...><img src="ASSET" alt="LABEL" width="150" /></a>
//   - text form:   <a href="HREF" target="_blank" ...>PREFIX LABEL</a>
// and CTAs on a line are joined by `renderCtas` with either "&nbsp;&nbsp;" (assets) or " | " (text).
// This matches whichever separator the line actually used so both styles rebuild cleanly.
const CTA_SEPARATOR = /(?:&nbsp;){2}| \| /;

/**
 * Removes a single CTA (identified by its label, e.g. "See preview") from an already-rendered
 * comment body, preserving every other CTA and the rest of the comment. Used by the previewkit
 * teardown path to drop the now-dead preview link from the runs comment without re-rendering it.
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
    const separator = line.includes("&nbsp;&nbsp;") ? "&nbsp;&nbsp;" : " | ";
    const kept = line.split(CTA_SEPARATOR).filter((part) => !partIsCta(part, label));
    if (kept.length === 0) return undefined;
    return kept.join(separator);
}

function bodyContainsCta(body: string, label: string): boolean {
    return assetCtaPattern(label).test(body) || textCtaPattern(label).test(body);
}

function lineContainsCta(line: string, label: string): boolean {
    return partIsCta(line, label);
}

function partIsCta(part: string, label: string): boolean {
    return assetCtaPattern(label).test(part) || textCtaPattern(label).test(part);
}

// alt="LABEL" uniquely identifies the asset-anchor CTA for this label (alt carries the escaped label).
function assetCtaPattern(label: string): RegExp {
    return new RegExp(`alt="${escapeRegExp(label)}"`);
}

// >...LABEL...</a> - the text-link fallback anchor; the label may carry an emoji prefix. The asset form
// never matches (its anchor text is empty: `/></a>`), so the two patterns stay mutually exclusive.
function textCtaPattern(label: string): RegExp {
    return new RegExp(`>[^<]*${escapeRegExp(label)}[^<]*</a>`);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
