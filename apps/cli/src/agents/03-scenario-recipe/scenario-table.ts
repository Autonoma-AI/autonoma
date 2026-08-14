import { readFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "@11ty/gray-matter";
import { BUILT_IN_RECIPE_TOKEN_LIST, findUnknownRecipeTokens, isBuiltInRecipeToken } from "@autonoma/types";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

/**
 * Headers whose values a test never names on screen, so a run-unique {{token}} is safe to leave there.
 */
const IDENTIFIER_COLUMN_PATTERNS: readonly RegExp[] = [
    /\bids?\b/i,
    /email/i,
    /login/i,
    /\brefs?\b/i,
    /reference/i,
    /external/i,
    /\buuid\b/i,
    // Primary-/foreign-key abbreviations: schema identifiers, never a shown label.
    /\b[pf]ks?\b/i,
];

const RECIPE_TOKEN_PATTERN = /\{\{([a-zA-Z0-9_]+)\}\}/g;

export interface ScenarioEntityType {
    name: string;
    count: number;
}

export interface ParsedScenario {
    scenarioNames: string[];
    entityTypes: ScenarioEntityType[];
}

/** Parse scenarios.md frontmatter into the scenario names and entity types. */
export async function parseScenario(outputDir: string): Promise<ParsedScenario> {
    let raw: string;
    try {
        raw = await readFile(join(outputDir, "scenarios.md"), "utf-8");
    } catch {
        return { scenarioNames: [], entityTypes: [] };
    }

    try {
        const data: {
            scenarios?: { name?: unknown }[];
            entity_types?: { name?: unknown; count?: unknown }[];
        } = matter(raw).data;

        const entityTypes: ScenarioEntityType[] = (data.entity_types ?? [])
            .map((e) => {
                const name = e?.name != null ? String(e.name).trim() : "";
                const count = typeof e?.count === "number" ? e.count : Number(e?.count ?? 0) || 0;
                return { name, count };
            })
            .filter((e) => e.name.length > 0);

        const scenarioNames = (data.scenarios ?? [])
            .map((s) => (s?.name != null ? String(s.name).trim() : ""))
            .filter((n) => n.length > 0);

        return { scenarioNames, entityTypes };
    } catch {
        return { scenarioNames: [], entityTypes: [] };
    }
}

/**
 * Scenario data must be fully concrete apart from the run-identity tokens Autonoma
 * substitutes. Catch any other placeholder, or a leftover `variable_fields` block,
 * so it can be handed back for self-correction. This is a soft check: it returns one
 * human-readable error per problem (empty array = clean) and never throws, so a
 * stray placeholder is something the agent fixes, not a fatal failure.
 */
export function validateScenarioIsConcrete(content: string): string[] {
    const errors: string[] = findUnknownRecipeTokens(content).map(
        (token) =>
            `unknown token "{{${token}}}" - scenario values must be concrete. Replace it with the exact static ` +
            `value; the only tokens Autonoma substitutes are ${BUILT_IN_RECIPE_TOKEN_LIST}.`,
    );

    const checks: { pattern: RegExp; label: string }[] = [
        { pattern: /(?<!\{)\{[a-z][a-zA-Z]*\}(?!\})/g, label: "bare {variable} placeholder" },
        { pattern: /^\s*variable_fields\s*:/m, label: "variable_fields block" },
    ];

    for (const { pattern, label } of checks) {
        const match = content.match(pattern);
        if (match && match.length > 0) {
            errors.push(
                `${label}: "${match[0].trim()}" - scenario values must be concrete. ` +
                    `Replace it with the exact static value; the only tokens Autonoma substitutes are ` +
                    `${BUILT_IN_RECIPE_TOKEN_LIST}.`,
            );
        }
    }

    return errors;
}

export interface TokenisedDisplayField {
    /** The table header the token sat under - or `#N` for an unnamed column. */
    column: string;
    /** The offending cell value, token included. */
    value: string;
    /** The self-correcting message handed back to the agent. */
    message: string;
}

/**
 * A built-in {{token}} in a DISPLAY column corners step 5: it can't emit the token
 * (the test schema rejects it) nor read the real value (it changes every run), so it
 * fabricates a literal that was never seeded. `validateScenarioIsConcrete` lets the
 * built-ins through wherever they sit; this keeps them out of displayed columns. Soft:
 * empty array = clean, never throws - the finish tool hands the messages back to fix.
 *
 * A token-bearing cell is judged by its VALUE, not just its header: if the value (or,
 * for a comma list, every token-bearing element) exactly equals an id defined under an
 * identifier column elsewhere, it is a foreign-key reference - a test selects that row
 * by its display name, never this id string - and is accepted.
 */
export function findTokenisedDisplayFields(content: string): TokenisedDisplayField[] {
    const tables = parseTables(content);
    const knownIds = collectKnownIds(tables);

    const fields: TokenisedDisplayField[] = [];
    for (const { headers, rows } of tables) {
        for (const cells of rows) {
            fields.push(...rowDisplayTokenFields(headers, cells, knownIds));
        }
    }

    return fields;
}

/** Every value under an identifier column, across all tables - the known-id set references resolve against. */
function collectKnownIds(tables: ParsedTable[]): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const { headers, rows } of tables) {
        for (const cells of rows) {
            for (let col = 0; col < cells.length; col++) {
                if (!isIdentifierColumn(headers[col] ?? "")) continue;
                const value = cells[col]?.trim() ?? "";
                if (value.length > 0) ids.add(value);
            }
        }
    }
    return ids;
}

function rowDisplayTokenFields(
    headers: string[],
    cells: string[],
    knownIds: ReadonlySet<string>,
): TokenisedDisplayField[] {
    const fields: TokenisedDisplayField[] = [];

    for (let col = 0; col < cells.length; col++) {
        const cell = cells[col];
        if (cell == null || !cellHasBuiltInToken(cell)) continue;

        const header = headers[col] ?? "";
        if (isIdentifierColumn(header)) continue;
        if (isKnownReference(cell, knownIds)) continue;

        const column = header.length > 0 ? header : `#${col + 1}`;
        const columnLabel = header.length > 0 ? `"${header}"` : column;
        const message =
            `column ${columnLabel} carries a run-unique token in the displayed value "${cell}". ` +
            `A token is a different string every run, so a test cannot name this value on screen. ` +
            `Move the token to an id/email/external-reference field - uniqueness is usually per-scope, ` +
            `so the owning account/org id can carry it - and give this column a plain, token-free value ` +
            `a test can assert.`;
        fields.push({ column, value: cell, message });
    }

    return fields;
}

/**
 * A token-bearing cell is a reference (not a display literal) when the whole value is a
 * known id, or it is a comma list whose every token-bearing element is a known id.
 * Exact whole-value/whole-element equality only - no prefix or substring matching.
 */
function isKnownReference(cell: string, knownIds: ReadonlySet<string>): boolean {
    const trimmed = cell.trim();
    if (knownIds.has(trimmed)) return true;
    if (!trimmed.includes(",")) return false;

    const tokenElements = trimmed
        .split(",")
        .map((element) => element.trim())
        .filter((element) => cellHasBuiltInToken(element));
    return tokenElements.length > 0 && tokenElements.every((element) => knownIds.has(element));
}

function isIdentifierColumn(header: string): boolean {
    return IDENTIFIER_COLUMN_PATTERNS.some((pattern) => pattern.test(header));
}

function cellHasBuiltInToken(cell: string): boolean {
    for (const match of cell.matchAll(RECIPE_TOKEN_PATTERN)) {
        const tokenName = match[1];
        if (tokenName != null && isBuiltInRecipeToken(tokenName)) return true;
    }
    return false;
}

interface ParsedTable {
    headers: string[];
    rows: string[][];
}

/** Split markdown into its tables - a header row, a separator row, then data rows. */
function parseTables(content: string): ParsedTable[] {
    const tables: ParsedTable[] = [];
    const lines = content.split("\n");

    let i = 0;
    while (i < lines.length) {
        const headerLine = lines[i];
        const separatorLine = lines[i + 1];
        if (headerLine == null || separatorLine == null || !isTableRow(headerLine) || !isSeparatorRow(separatorLine)) {
            i++;
            continue;
        }

        const headers = splitTableRow(headerLine);
        const rows: string[][] = [];
        let row = i + 2;
        while (row < lines.length) {
            const dataLine = lines[row];
            if (dataLine == null || !isTableRow(dataLine) || isSeparatorRow(dataLine)) break;
            rows.push(splitTableRow(dataLine));
            row++;
        }

        tables.push({ headers, rows });
        i = row;
    }

    return tables;
}

function isTableRow(line: string): boolean {
    return line.trim().startsWith("|");
}

function isSeparatorRow(line: string): boolean {
    return line.includes("-") && /^\s*\|?[\s:|-]+\|?\s*$/.test(line);
}

function splitTableRow(line: string): string[] {
    return line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim());
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max - 1).trimEnd() + "…";
}

function pad(s: string, width: number): string {
    return s + " ".repeat(Math.max(0, width - s.length));
}

/**
 * Render the scenario as an aligned terminal table, mirroring the KB flows and
 * entity audit tables.
 */
export function renderScenarioTable(parsed: ParsedScenario): string {
    if (parsed.entityTypes.length === 0) return "";

    const NAME_MAX = 32;

    const rows = parsed.entityTypes.map((e, i) => ({
        num: String(i + 1),
        name: truncate(e.name, NAME_MAX),
        count: String(e.count),
    }));

    const numW = Math.max(1, ...rows.map((r) => r.num.length));
    const nameW = Math.max("Entity".length, ...rows.map((r) => r.name.length));
    const countW = Math.max("Count".length, ...rows.map((r) => r.count.length));

    const totalRecords = parsed.entityTypes.reduce((sum, e) => sum + e.count, 0);

    const header = `${BOLD}${pad("#", numW)}  ${pad("Entity", nameW)}  ${pad("Count", countW)}${RESET}`;
    const sep = `${DIM}${"─".repeat(numW + nameW + countW + 4)}${RESET}`;

    const body = rows.map((r) => `${pad(r.num, numW)}  ${pad(r.name, nameW)}  ${pad(r.count, countW)}`).join("\n");

    const scenarioLabel = parsed.scenarioNames.length ? `scenario: ${parsed.scenarioNames.join(", ")} · ` : "";
    const caption = `${DIM}${scenarioLabel}${parsed.entityTypes.length} entity types · ${totalRecords} records${RESET}`;

    return `${header}\n${sep}\n${body}\n${caption}`;
}
