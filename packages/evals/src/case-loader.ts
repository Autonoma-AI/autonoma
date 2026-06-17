import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import matter from "gray-matter";
import { z } from "zod";
import { CASE_SCHEMA_VERSION } from "./frontmatter";

/**
 * A single eval case loaded from disk: the frozen, assembled agent input plus
 * the authored `expected.md` (deterministic frontmatter + judge rubric body).
 */
export interface LoadedCase<TInput, TFrontmatter> {
    /** Case folder name, used as the vitest case label. */
    name: string;
    /** Absolute path to the case folder. */
    dir: string;
    /** Parsed `input.json` - the frozen `XxxAgentInput` with codebase coords + index arrays. */
    input: TInput;
    /** Parsed `expected.md` frontmatter (deterministic checks). */
    frontmatter: TFrontmatter;
    /** The `expected.md` body - the additive LLM-judge rubric. */
    rubric: string;
}

export interface CaseLoaderConfig<TInput, TFrontmatter> {
    /**
     * Directory containing one folder per case, or `undefined` when the corpus
     * root is unset - in which case zero cases load.
     */
    casesDir: string | undefined;
    /** Schema for `input.json`. */
    inputSchema: z.ZodType<TInput>;
    /** Schema for the `expected.md` frontmatter. */
    frontmatterSchema: z.ZodType<TFrontmatter>;
}

const INPUT_FILE = "input.json";
const EXPECTED_FILE = "expected.md";

/**
 * Load every case folder under `casesDir`. Each folder must contain
 * {@link INPUT_FILE} and {@link EXPECTED_FILE}; folders missing either are
 * skipped with a warning rather than throwing, so a half-captured case never
 * breaks the whole suite.
 *
 * A case whose files no longer parse against the current schema is handled by
 * its `skip` flag (see {@link loadCase}): an **active** (`skip: false`) case
 * throws - that is a real authoring error - while a **skipped** (`skip: true`)
 * case is dropped with a warning, since the author has parked it and it would
 * not run anyway. This means a stale skipped fixture in the private corpus can
 * never take down a whole suite at load time.
 */
export function loadCases<TInput, TFrontmatter>(
    config: CaseLoaderConfig<TInput, TFrontmatter>,
): LoadedCase<TInput, TFrontmatter>[] {
    const logger = rootLogger.child({ name: "loadCases" });
    const { casesDir, inputSchema, frontmatterSchema } = config;

    if (casesDir == null) {
        logger.info("No cases directory configured; loading zero cases");
        return [];
    }

    let entries: string[];
    try {
        entries = readdirSync(casesDir);
    } catch (err) {
        logger.warn("No cases directory found; loading zero cases", { extra: { casesDir, err } });
        return [];
    }

    const cases: LoadedCase<TInput, TFrontmatter>[] = [];

    for (const name of entries) {
        const dir = path.join(casesDir, name);
        if (!statSync(dir).isDirectory()) continue;

        const loaded = loadCase(name, dir, inputSchema, frontmatterSchema, logger);
        if (loaded != null) cases.push(loaded);
    }

    logger.info("Loaded eval cases", { extra: { casesDir, count: cases.length } });
    return cases;
}

/**
 * Load a single case folder, or return `undefined` to drop it. A folder missing
 * either file is dropped with a warning. Otherwise input + frontmatter are
 * parsed: on success the case is returned; on failure the case's `skip` flag
 * decides - a skipped case is dropped with a warning (it would not run anyway),
 * an active case throws with its name so the offending fixture is obvious.
 */
function loadCase<TInput, TFrontmatter>(
    name: string,
    dir: string,
    inputSchema: z.ZodType<TInput>,
    frontmatterSchema: z.ZodType<TFrontmatter>,
    logger: Logger,
): LoadedCase<TInput, TFrontmatter> | undefined {
    const inputPath = path.join(dir, INPUT_FILE);
    const expectedPath = path.join(dir, EXPECTED_FILE);

    if (!fileExists(inputPath) || !fileExists(expectedPath)) {
        logger.warn("Skipping incomplete case folder", {
            extra: { name, hasInput: fileExists(inputPath), hasExpected: fileExists(expectedPath) },
        });
        return undefined;
    }

    const { data, content } = matter(readFileSync(expectedPath, "utf-8"));
    warnOnSchemaDrift(name, data, logger);

    // `skip` is read leniently here (before the full frontmatter parse) so it can
    // protect a case even when the rest of its frontmatter no longer parses.
    const isSkipped = skipProbe.safeParse(data).data?.skip === true;

    try {
        const input = inputSchema.parse(JSON.parse(readFileSync(inputPath, "utf-8")));
        const frontmatter = frontmatterSchema.parse(data);
        return { name, dir, input, frontmatter, rubric: content.trim() };
    } catch (err) {
        if (isSkipped) {
            logger.warn("Dropping skipped case that no longer parses; re-capture or migrate it", {
                extra: { name, err },
            });
            return undefined;
        }
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`Eval case "${name}" has an invalid ${INPUT_FILE} or ${EXPECTED_FILE}: ${detail}`, {
            cause: err,
        });
    }
}

function fileExists(filePath: string): boolean {
    try {
        return statSync(filePath).isFile();
    } catch {
        return false;
    }
}

const skipProbe = z.object({ skip: z.boolean().optional() });

const schemaVersionProbe = z.object({ schemaVersion: z.number().int().positive().optional() });

/**
 * Surface corpus-vs-harness drift: the cases corpus lives in a separate private
 * repo, so a case authored against an older frontmatter schema can outlive a
 * change here. This warns (never throws) when a case declares a `schemaVersion`
 * different from {@link CASE_SCHEMA_VERSION}; a case with no declared version is
 * treated as current and ignored.
 */
function warnOnSchemaDrift(name: string, data: unknown, logger: Logger): void {
    const parsed = schemaVersionProbe.safeParse(data);
    if (!parsed.success) return;

    const declared = parsed.data.schemaVersion;
    if (declared != null && declared !== CASE_SCHEMA_VERSION) {
        logger.warn("Eval case schema version drift; re-capture or migrate the case", {
            extra: { name, declaredVersion: declared, currentVersion: CASE_SCHEMA_VERSION },
        });
    }
}
