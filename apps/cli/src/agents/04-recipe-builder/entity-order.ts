import { readFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import { z } from "zod";

export interface AuditedModel {
    name: string;
    independently_created: boolean;
    creation_file?: string;
    creation_function?: string;
    side_effects?: string[];
    created_by: { owner: string; via?: string; why?: string }[];
}

const createdBySchema = z.object({
    owner: z.string(),
    via: z.string().optional(),
    why: z.string().optional(),
});

const auditedModelSchema = z.object({
    name: z.string(),
    independently_created: z.coerce.boolean().default(false),
    creation_file: z.string().optional(),
    creation_function: z.string().optional(),
    side_effects: z.array(z.string()).optional(),
    // Tolerate a stray `created_by:` with no entries (parsed as null by YAML).
    created_by: z
        .array(createdBySchema)
        .nullish()
        .transform((v) => v ?? []),
});

const frontmatterSchema = z.object({
    models: z
        .array(auditedModelSchema)
        .nullish()
        .transform((v) => v ?? []),
});

/**
 * Parse entity-audit.md into structured models. The frontmatter (`models:`) is
 * the contract every downstream step depends on, so this is deliberately
 * forgiving: it first parses real YAML frontmatter (validated with zod), and
 * only if that yields nothing does it fall back to scanning the document line
 * by line. A malformed audit should degrade to partial data, never hard-crash
 * the recipe builder - earlier versions threw "no YAML frontmatter" here and
 * took the whole run down.
 */
export async function parseEntityAudit(outputDir: string): Promise<AuditedModel[]> {
    const raw = await readFile(join(outputDir, "entity-audit.md"), "utf-8");

    try {
        const parsed = frontmatterSchema.safeParse(matter(raw).data);
        if (parsed.success && parsed.data.models.length > 0) {
            return parsed.data.models.map((m) => ({
                name: m.name,
                independently_created: m.independently_created,
                creation_file: m.creation_file,
                creation_function: m.creation_function,
                side_effects: m.side_effects,
                created_by: m.created_by,
            }));
        }
    } catch {
        // gray-matter/js-yaml choked on malformed YAML - fall through to the
        // line scanner below, which copes with partial or non-standard output.
    }

    return parseAuditByLineScan(raw);
}

/**
 * Last-resort parser: walk the document and reconstruct models from `- name:`
 * blocks. Works even when the content isn't valid YAML or has no `---` fence.
 */
function parseAuditByLineScan(raw: string): AuditedModel[] {
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    // Prefer the fenced frontmatter when present, else scan the whole document.
    const yaml = fmMatch ? fmMatch[1]! : raw;
    const models: AuditedModel[] = [];
    let current: Partial<AuditedModel> | undefined;
    let inCreatedBy = false;
    let currentCreatedBy: { owner: string; via?: string; why?: string } | undefined;

    for (const line of yaml.split("\n")) {
        if (line.match(/^\s{2}- name:/)) {
            if (current?.name) {
                if (currentCreatedBy?.owner) {
                    (current.created_by ??= []).push(currentCreatedBy);
                    currentCreatedBy = undefined;
                }
                models.push({
                    name: current.name,
                    independently_created: current.independently_created ?? false,
                    creation_file: current.creation_file,
                    creation_function: current.creation_function,
                    side_effects: current.side_effects,
                    created_by: current.created_by ?? [],
                });
            }
            current = { name: line.match(/name:\s*"?([^"'\n]+)"?/)?.[1]?.trim() };
            inCreatedBy = false;
            currentCreatedBy = undefined;
            continue;
        }

        if (!current) continue;

        const kvMatch = line.match(/^\s{4}(\w+):\s*(.+)/);
        if (kvMatch && !inCreatedBy) {
            const [, key, val] = kvMatch;
            const v = val!.replace(/^["']|["']$/g, "").trim();
            switch (key) {
                case "independently_created":
                    current.independently_created = v === "true";
                    break;
                case "creation_file":
                    current.creation_file = v;
                    break;
                case "creation_function":
                    current.creation_function = v;
                    break;
            }
        }

        if (line.match(/^\s{4}side_effects:/)) {
            current.side_effects = [];
            continue;
        }
        if (current.side_effects !== undefined && line.match(/^\s{6}-\s/)) {
            const val = line
                .replace(/^\s{6}-\s*/, "")
                .replace(/^["']|["']$/g, "")
                .trim();
            if (val) current.side_effects.push(val);
            continue;
        }

        if (line.match(/^\s{4}created_by:/)) {
            current.created_by = [];
            current.side_effects = undefined;
            inCreatedBy = true;
            continue;
        }

        if (inCreatedBy) {
            if (line.match(/^\s{6}- owner:/)) {
                if (currentCreatedBy?.owner) {
                    current.created_by!.push(currentCreatedBy);
                }
                currentCreatedBy = { owner: line.match(/owner:\s*"?([^"'\n]+)"?/)?.[1]?.trim() ?? "" };
                continue;
            }
            if (currentCreatedBy && line.match(/^\s{8}via:/)) {
                currentCreatedBy.via = line.match(/via:\s*"?([^"'\n]+)"?/)?.[1]?.trim();
                continue;
            }
            if (currentCreatedBy && line.match(/^\s{8}why:/)) {
                currentCreatedBy.why = line.match(/why:\s*"?([^"'\n]+)"?/)?.[1]?.trim();
                continue;
            }
        }
    }

    if (current?.name) {
        if (currentCreatedBy?.owner) {
            (current.created_by ??= []).push(currentCreatedBy);
        }
        models.push({
            name: current.name,
            independently_created: current.independently_created ?? false,
            creation_file: current.creation_file,
            creation_function: current.creation_function,
            side_effects: current.side_effects,
            created_by: current.created_by ?? [],
        });
    }

    return models;
}

/**
 * Resolve the order entities are processed in: a topological sort of the
 * `created_by` dependency graph (owners before the entities they spawn). Among
 * entities that are simultaneously available (no unmet dependency), ties are
 * broken by `importanceRank` (lower index = more important, surfaced first) when
 * provided, otherwise alphabetically.
 */
export function resolveEntityOrder(models: AuditedModel[], importanceRank?: Map<string, number>): string[] {
    const rankOf = (name: string) => importanceRank?.get(name) ?? Number.MAX_SAFE_INTEGER;
    const compare = (a: string, b: string) => rankOf(a) - rankOf(b) || a.localeCompare(b);

    const factoryModels = models.filter((m) => m.independently_created);
    const nameSet = new Set(factoryModels.map((m) => m.name));

    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const m of factoryModels) {
        inDegree.set(m.name, 0);
        dependents.set(m.name, []);
    }

    for (const m of factoryModels) {
        for (const dep of m.created_by) {
            if (nameSet.has(dep.owner)) {
                inDegree.set(m.name, (inDegree.get(m.name) ?? 0) + 1);
                dependents.get(dep.owner)!.push(m.name);
            }
        }
    }

    const queue: string[] = [];
    for (const [name, deg] of inDegree) {
        if (deg === 0) queue.push(name);
    }
    queue.sort(compare);

    const result: string[] = [];
    while (queue.length > 0) {
        const name = queue.shift()!;
        result.push(name);
        for (const dep of dependents.get(name) ?? []) {
            const newDeg = (inDegree.get(dep) ?? 1) - 1;
            inDegree.set(dep, newDeg);
            if (newDeg === 0) {
                queue.push(dep);
                queue.sort(compare);
            }
        }
    }

    if (result.length !== factoryModels.length) {
        const missing = factoryModels.filter((m) => !result.includes(m.name)).map((m) => m.name);
        console.warn(
            `[recipe-builder] Circular dependency detected for: ${missing.join(", ")}. Appending in original order.`,
        );
        for (const m of missing) result.push(m);
    }

    return result;
}
