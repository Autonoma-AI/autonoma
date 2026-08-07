import { readFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "@11ty/gray-matter";
import { BUILT_IN_RECIPE_TOKEN_LIST, findUnknownRecipeTokens } from "@autonoma/types";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

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
