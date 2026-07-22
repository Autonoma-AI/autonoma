import matter from "gray-matter";
import { z } from "zod";
import { debugLog } from "../../core/debug";
import { theme } from "../theme";
import type { ContentKind } from "../types";

export interface Span {
    text: string;
    color?: string;
    bold?: boolean;
    dim?: boolean;
}

export type StyledLine = Span[];

/** Widest first column in frontmatter/pages tables before truncation. */
const TABLE_KEY_MAX = 34;

/**
 * Turn a file's contents into styled lines for the hero panel. Line-oriented on
 * purpose: it lets the panel slice to its viewport and only ever render ~40
 * lines regardless of file size.
 *
 * Known pipeline documents get document-aware rendering: markdown frontmatter
 * becomes a readable info card (scalars as key/value, arrays as tables) and
 * pages.json becomes a route table.
 *
 * Memoized on (text, kind, name): the dashboard repaints on every store change
 * and clock tick, and re-parsing a large document each frame is what makes the
 * UI crawl.
 */
export function renderContent(text: string, kind: ContentKind, name?: string): StyledLine[] {
    if (memo != null && memo.text === text && memo.kind === kind && memo.name === name) return memo.lines;
    const lines = renderUncached(text, kind, name);
    memo = { text, kind, name, lines };
    return lines;
}

let memo: { text: string; kind: ContentKind; name?: string; lines: StyledLine[] } | undefined;

/**
 * Wrapped variant for the viewer: long lines fold at `width` (word-aware,
 * falling back to a hard cut for unbroken runs). Separately memoized - the
 * viewer calls this every repaint.
 */
export function renderContentWrapped(
    text: string,
    kind: ContentKind,
    name: string | undefined,
    width: number,
): StyledLine[] {
    if (
        wrapMemo != null &&
        wrapMemo.text === text &&
        wrapMemo.kind === kind &&
        wrapMemo.name === name &&
        wrapMemo.width === width
    ) {
        return wrapMemo.lines;
    }
    const lines = wrapStyledLines(renderContent(text, kind, name), width);
    wrapMemo = { text, kind, name, width, lines };
    return lines;
}

let wrapMemo: { text: string; kind: ContentKind; name?: string; width: number; lines: StyledLine[] } | undefined;

/** Fold styled lines at `width`, preserving span styles across the fold. */
export function wrapStyledLines(lines: StyledLine[], width: number): StyledLine[] {
    if (width < 8) return lines;
    const out: StyledLine[] = [];
    for (const line of lines) {
        const total = line.reduce((n, s) => n + s.text.length, 0);
        if (total <= width) {
            out.push(line);
            continue;
        }
        // Flatten to a char stream so folds can cross span boundaries.
        const chars: { ch: string; span: Span }[] = [];
        for (const span of line) for (const ch of span.text) chars.push({ ch, span });
        let start = 0;
        while (start < chars.length) {
            let end = Math.min(start + width, chars.length);
            if (end < chars.length) {
                // Prefer breaking at the last space, unless it is too far back.
                let back = end;
                while (back > start && chars[back - 1]!.ch !== " ") back--;
                if (back > start + Math.floor(width / 2)) end = back;
            }
            const folded: StyledLine = [];
            for (let i = start; i < end; i++) {
                const { ch, span } = chars[i]!;
                const last = folded[folded.length - 1];
                if (last != null && chars[i - 1]?.span === span && i > start) last.text += ch;
                else folded.push({ text: ch, color: span.color, bold: span.bold, dim: span.dim });
            }
            out.push(folded.length ? folded : [{ text: "" }]);
            start = end;
            while (start < chars.length && chars[start]!.ch === " ") start++;
        }
    }
    return out;
}

function renderUncached(text: string, kind: ContentKind, name?: string): StyledLine[] {
    if (name === "pages.json") {
        const table = renderPagesJson(text);
        if (table != null) return table;
    }
    if (name === "project-map.json") {
        const sections = renderStructuredJson(text);
        if (sections != null) return sections;
    }
    if (name === "entity-audit.md") {
        const audit = renderEntityAudit(text);
        if (audit != null) return audit;
    }
    switch (kind) {
        case "json":
            return text.split("\n").map(jsonLine);
        case "markdown":
            return markdownDocument(text);
        default:
            return text.split("\n").map((l) => [{ text: l }]);
    }
}

/* ------------------------------------------------------------- frontmatter -- */

/**
 * Markdown with YAML frontmatter renders as an info card (the parsed data,
 * readable) followed by the styled body. Raw YAML - especially AUTONOMA.md's
 * pages/core_flows arrays - is noise when shown verbatim.
 */
function markdownDocument(text: string): StyledLine[] {
    if (!text.startsWith("---\n")) return markdownLines(text.split("\n"));

    let parsed: { data: Record<string, unknown>; content: string };
    try {
        parsed = matter(text);
    } catch (err) {
        debugLog("Frontmatter parse failed, rendering raw markdown", { err });
        return markdownLines(text.split("\n"));
    }

    const entries = Object.entries(parsed.data);
    if (entries.length === 0) return markdownLines(parsed.content.split("\n"));

    const out: StyledLine[] = [];
    const scalars = entries.filter(([, v]) => !Array.isArray(v));
    const arrays = entries.filter((e): e is [string, unknown[]] => Array.isArray(e[1]));

    for (const [key, value] of scalars) {
        out.push([{ text: `${key}  `, color: theme.accent }, { text: formatScalar(value) }]);
    }
    for (const [key, items] of arrays) {
        out.push([{ text: "" }]);
        out.push([
            { text: key, color: theme.accent, bold: true },
            { text: `  ${items.length} ${items.length === 1 ? "entry" : "entries"}`, color: theme.tertiary },
        ]);
        out.push(...renderArrayTable(items));
    }

    if (parsed.content.trim() !== "") {
        out.push([{ text: "" }]);
        out.push([{ text: "─".repeat(40), color: theme.border }]);
        out.push([{ text: "" }]);
        out.push(...markdownLines(parsed.content.replace(/^\n+/, "").split("\n")));
    }
    return out;
}

function formatScalar(value: unknown): string {
    if (value == null) return "";
    if (Array.isArray(value)) return value.map((v) => formatScalar(v)).join(", ");
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
}

/**
 * An array of objects renders as a two-column table: the identifying field
 * (page/feature/route/name/...) then the description; remaining fields become
 * a dim annotation line. Arrays of scalars render as a plain list.
 */
function renderArrayTable(items: unknown[]): StyledLine[] {
    const out: StyledLine[] = [];
    const KEY_FIELDS = ["page", "feature", "route", "path", "name", "model", "flow"];
    const TEXT_FIELDS = ["description", "mission", "summary", "why"];

    const keyWidth = Math.min(
        TABLE_KEY_MAX,
        Math.max(...items.map((item) => keyFieldOf(item, KEY_FIELDS)?.length ?? 0), 4),
    );

    for (const item of items) {
        if (item == null || typeof item !== "object") {
            out.push([{ text: "  - ", color: theme.secondary }, { text: formatScalar(item) }]);
            continue;
        }
        const record: Record<string, unknown> = { ...item };
        const key = keyFieldOf(item, KEY_FIELDS) ?? "";
        const textField = TEXT_FIELDS.find((f) => typeof record[f] === "string");
        const description = textField != null ? String(record[textField]) : "";
        const consumed = new Set([...KEY_FIELDS, ...(textField != null ? [textField] : [])]);
        const rest = Object.entries(record).filter(([k, v]) => !consumed.has(k) && v != null && v !== false);

        out.push([
            { text: "  ", color: theme.secondary },
            { text: pad(key, keyWidth), color: theme.sky },
            { text: "  " },
            { text: description, color: theme.text },
        ]);
        if (rest.length > 0) {
            const note = rest.map(([k, v]) => (v === true ? k : `${k}: ${formatScalar(v)}`)).join(" · ");
            out.push([{ text: " ".repeat(keyWidth + 4) }, { text: note, color: theme.tertiary }]);
        }
    }
    return out;
}

function keyFieldOf(item: unknown, fields: string[]): string | undefined {
    if (item == null || typeof item !== "object") return undefined;
    const record: Record<string, unknown> = { ...item };
    for (const f of fields) {
        if (typeof record[f] === "string") return String(record[f]);
    }
    return undefined;
}

function pad(s: string, w: number): string {
    if (s.length > w) return s.slice(0, w - 1) + "…";
    return s.padEnd(w, " ");
}

/**
 * A JSON document whose top-level values are arrays of objects (project-map:
 * frontends / backends / ignore) renders as labeled sections of the same
 * two-column tables the frontmatter card uses.
 */
function renderStructuredJson(text: string): StyledLine[] | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        debugLog("Structured JSON parse failed, falling back to raw view", { err });
        return undefined;
    }
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;

    const record: Record<string, unknown> = { ...parsed };
    const sections = Object.entries(record).filter((e): e is [string, unknown[]] => Array.isArray(e[1]));
    if (sections.length === 0) return undefined;

    const out: StyledLine[] = [];
    for (const [key, items] of sections) {
        if (out.length > 0) out.push([{ text: "" }]);
        out.push([
            { text: key, color: theme.accent, bold: true },
            { text: `  ${items.length} ${items.length === 1 ? "entry" : "entries"}`, color: theme.tertiary },
        ]);
        out.push(...renderArrayTable(items));
    }
    return out;
}

/* ---------------------------------------------------------- entity-audit.md -- */

const CreatedBySchema = z.object({
    owner: z.string(),
    via: z.string().optional(),
    why: z.string().optional(),
});

const AuditModelSchema = z.object({
    name: z.string(),
    independently_created: z.boolean().optional(),
    creation_file: z.string().optional(),
    creation_function: z.string().optional(),
    side_effects: z.array(z.string()).optional(),
    created_by: z.array(CreatedBySchema).optional(),
});

type AuditModel = z.infer<typeof AuditModelSchema>;

/** Column reserved for the FACTORY / via-owner badge. */
const AUDIT_BADGE_W = 12;

/**
 * entity-audit.md's frontmatter is one huge `models:` array - unreadable as raw
 * YAML and noisy through the generic card. Render it as a model table instead:
 * name, how the model comes into existence (own factory vs via an owner), and
 * where in the code that happens.
 */
function renderEntityAudit(text: string): StyledLine[] | undefined {
    if (!text.startsWith("---\n")) return undefined;
    let parsed: { data: Record<string, unknown>; content: string };
    try {
        parsed = matter(text);
    } catch (err) {
        debugLog("entity-audit.md frontmatter parse failed, falling back", { err });
        return undefined;
    }
    const raw = parsed.data.models;
    if (!Array.isArray(raw)) return undefined;

    const models: AuditModel[] = [];
    for (const item of raw) {
        const result = AuditModelSchema.safeParse(item);
        if (result.success) models.push(result.data);
    }
    if (models.length === 0) return undefined;

    const factories = models.filter((m) => m.independently_created === true).length;
    const out: StyledLine[] = [];
    out.push([
        { text: "models", color: theme.accent, bold: true },
        { text: `  ${models.length} total`, color: theme.tertiary },
        { text: "   ", color: theme.faint },
        { text: `● ${factories} with a factory`, color: theme.accent },
        { text: "   ", color: theme.faint },
        { text: `○ ${models.length - factories} created via owners`, color: theme.violet },
    ]);
    out.push([{ text: "" }]);

    const nameW = Math.min(TABLE_KEY_MAX, Math.max(...models.map((m) => m.name.length), 4));
    for (const m of models) {
        out.push(auditRow(m, nameW));
        const note = auditNote(m);
        if (note != null) out.push([{ text: " ".repeat(nameW + AUDIT_BADGE_W + 4) }, note]);
    }

    if (parsed.content.trim() !== "") {
        out.push([{ text: "" }]);
        out.push([{ text: "─".repeat(40), color: theme.border }]);
        out.push([{ text: "" }]);
        out.push(...markdownLines(parsed.content.replace(/^\n+/, "").split("\n")));
    }
    return out;
}

function auditRow(m: AuditModel, nameW: number): StyledLine {
    const root = m.independently_created === true;
    const badge = root ? "● factory" : "○ via";
    const owners = [...new Set((m.created_by ?? []).map((c) => c.owner))];
    const how = root ? (m.creation_function ?? m.creation_file ?? "") : owners.length > 0 ? owners.join(", ") : "-";
    return [
        { text: "  " },
        { text: pad(m.name, nameW), color: theme.sky },
        { text: "  " },
        { text: pad(badge, AUDIT_BADGE_W), color: root ? theme.accent : theme.violet },
        { text: how, color: root ? theme.text : theme.secondary },
    ];
}

/** The dim second line: where creation happens, its side effects, or the why. */
function auditNote(m: AuditModel): Span | undefined {
    const parts: string[] = [];
    if (m.independently_created === true) {
        if (m.creation_file != null && m.creation_function != null) parts.push(m.creation_file);
        if (m.side_effects != null && m.side_effects.length > 0) {
            parts.push(`side effects: ${m.side_effects.join(", ")}`);
        }
        const owners = [...new Set((m.created_by ?? []).map((c) => c.owner))];
        if (owners.length > 0) parts.push(`also created by ${owners.join(", ")}`);
    } else {
        const why = m.created_by?.find((c) => c.why != null)?.why;
        const via = m.created_by?.find((c) => c.via != null)?.via;
        if (why != null) parts.push(why);
        else if (via != null) parts.push(`via ${via}`);
    }
    if (parts.length === 0) return undefined;
    return { text: parts.join(" · "), color: theme.tertiary };
}

/* --------------------------------------------------------------- pages.json -- */

/** pages.json is a record of { route, path, description } - render a route table. */
function renderPagesJson(text: string): StyledLine[] | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        debugLog("pages.json parse failed, falling back to raw JSON view", { err });
        return undefined;
    }
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;

    const record: Record<string, unknown> = { ...parsed };
    const pages = Object.values(record).filter(
        (p): p is { route?: string; path?: string; description?: string } => p != null && typeof p === "object",
    );
    if (pages.length === 0) return undefined;

    const out: StyledLine[] = [];
    out.push([
        { text: "pages", color: theme.accent, bold: true },
        { text: `  ${pages.length} routes`, color: theme.tertiary },
    ]);
    out.push([{ text: "" }]);

    const routeWidth = Math.min(TABLE_KEY_MAX, Math.max(...pages.map((p) => p.route?.length ?? 0), 5));
    for (const page of pages) {
        out.push([
            { text: "  " },
            { text: pad(page.route ?? "", routeWidth), color: theme.sky },
            { text: "  " },
            { text: page.description ?? "", color: theme.text },
        ]);
        if (page.path != null && page.path !== "") {
            out.push([{ text: " ".repeat(routeWidth + 4) }, { text: page.path, color: theme.tertiary }]);
        }
    }
    return out;
}

/* ----------------------------------------------------------------- markdown -- */

function markdownLines(lines: string[]): StyledLine[] {
    const out: StyledLine[] = [];
    let inCode = false;

    lines.forEach((line) => {
        const trimmed = line.trimStart();

        // Fenced code blocks.
        if (trimmed.startsWith("```")) {
            inCode = !inCode;
            out.push([{ text: line, color: theme.faint }]);
            return;
        }
        if (inCode) {
            out.push([{ text: line, color: theme.sky }]);
            return;
        }

        // Headings.
        const heading = /^(#{1,6})\s/.exec(trimmed);
        if (heading) {
            out.push([{ text: line, color: theme.accent, bold: true }]);
            return;
        }

        // Blockquote.
        if (trimmed.startsWith(">")) {
            out.push([{ text: line, dim: true }]);
            return;
        }

        // List items: dim the marker, inline-style the rest.
        const list = /^(\s*(?:[-*+]|\d+\.)\s)(.*)$/.exec(line);
        if (list) {
            out.push([{ text: list[1]!, color: theme.secondary }, ...inlineSpans(list[2]!)]);
            return;
        }

        out.push(inlineSpans(line));
    });

    return out;
}

/** Inline `**bold**` and `` `code` ``; everything else is plain text. */
function inlineSpans(text: string): StyledLine {
    if (text === "") return [{ text: "" }];
    const spans: Span[] = [];
    const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
        if (m.index > last) spans.push({ text: text.slice(last, m.index) });
        if (m[1] != null) spans.push({ text: m[1], bold: true });
        else if (m[2] != null) spans.push({ text: m[2], color: theme.sky });
        last = m.index + m[0].length;
    }
    if (last < text.length) spans.push({ text: text.slice(last) });
    return spans.length ? spans : [{ text }];
}

/* --------------------------------------------------------------------- json -- */

function jsonLine(line: string): StyledLine {
    const spans: Span[] = [];
    const re =
        /("(?:[^"\\]|\\.)*"\s*:)|("(?:[^"\\]|\\.)*")|(\b(?:true|false|null)\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],])/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
        if (m.index > last) spans.push({ text: line.slice(last, m.index), color: theme.secondary });
        if (m[1] != null) spans.push({ text: m[1], color: theme.accent });
        else if (m[2] != null) spans.push({ text: m[2], color: theme.green });
        else if (m[3] != null) spans.push({ text: m[3], color: theme.amber });
        else if (m[4] != null) spans.push({ text: m[4], color: theme.sky });
        else if (m[5] != null) spans.push({ text: m[5], color: theme.secondary });
        last = m.index + m[0].length;
    }
    if (last < line.length) spans.push({ text: line.slice(last), color: theme.secondary });
    return spans.length ? spans : [{ text: "" }];
}
