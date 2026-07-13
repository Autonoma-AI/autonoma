import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { debugLog } from "./debug";

/**
 * A project map is the very first thing the planner establishes: a partition of the
 * codebase into the frontend app(s) whose pages we test, the backend(s) that own the
 * data we seed, and the directories that are irrelevant to either. Every later step
 * scopes itself to this map instead of re-discovering (and re-scanning) the whole
 * tree - which is what let a large monorepo drown the page/knowledge/audit agents.
 *
 * Deliberately framework-agnostic (see apps/cli CLAUDE.md): a repo may be a single
 * fullstack app (frontend and backend the SAME path), a monorepo with many apps, or a
 * codebase that only ships one half (frontend-only or backend-only). Multiple backends
 * are first-class.
 */

const FrontendEntry = z.object({
    path: z.string().min(1).describe("Repo-relative path to the frontend app/directory (the UI surface)."),
    framework: z
        .string()
        .describe("Detected UI framework/stack, or 'unknown' if not obvious (e.g. next, react, vue, svelte)."),
    dependsOn: z
        .array(z.string())
        .describe(
            "Repo-relative paths (each matching a backend in this map) that THIS frontend needs in order to function - the " +
                "API/service(s) it calls and the data layer(s) that own the records it renders. These are pre-selected when the " +
                "user picks this frontend, so only list backends this frontend actually depends on. Empty if it needs none.",
        ),
    why: z.string().min(1).describe("One line: the evidence that made you classify this as a frontend."),
});

const BackendEntry = z.object({
    path: z
        .string()
        .min(1)
        .describe("Repo-relative path to the backend/API/service or the package that owns the data layer."),
    language: z.string().describe("Primary language, or 'unknown' (e.g. typescript, python, go, rust)."),
    framework: z
        .string()
        .describe("Web/service framework or ORM stack, or 'unknown' (e.g. express, hono, fastapi, rails)."),
    dataLayer: z
        .object({
            kind: z
                .string()
                .describe("How models are defined (e.g. prisma, drizzle, sqlalchemy, typeorm, raw-sql, unknown)."),
            schemaPath: z.string().optional().describe("Repo-relative path to the schema/models definition, if found."),
        })
        .optional()
        .describe("Where this backend's database models live. Omit if this backend owns no data layer."),
    why: z.string().min(1).describe("One line: the evidence that made you classify this as a backend."),
});

const IgnoreEntry = z.object({
    path: z.string().min(1).describe("Repo-relative path to a directory that is NOT relevant to testing this app."),
    why: z
        .string()
        .min(1)
        .describe("One line: why it is irrelevant (e.g. docs site, infra, tooling, examples, unrelated app)."),
});

export const ProjectMapSchema = z.object({
    frontends: z
        .array(FrontendEntry)
        .describe("The UI surface(s) whose pages/flows get tested. Usually 1; may be more."),
    backends: z
        .array(BackendEntry)
        .describe(
            "The API/service(s) and data layer(s) that own the models we seed. May be 0 (frontend-only), 1, or many.",
        ),
    ignore: z
        .array(IgnoreEntry)
        .describe("Directories judged irrelevant to this app's tests, so later steps skip them."),
});

export type ProjectMap = z.infer<typeof ProjectMapSchema>;

const PROJECT_MAP_FILE = "project-map.json";

export async function saveProjectMap(outputDir: string, map: ProjectMap): Promise<void> {
    await writeFile(join(outputDir, PROJECT_MAP_FILE), JSON.stringify(map, null, 2), "utf-8");
}

export async function loadProjectMap(outputDir: string): Promise<ProjectMap | undefined> {
    const path = join(outputDir, PROJECT_MAP_FILE);
    try {
        const raw = await readFile(path, "utf-8");
        const parsed = ProjectMapSchema.safeParse(JSON.parse(raw));
        if (parsed.success) return parsed.data;
        // A present-but-invalid map (e.g. a partial write after a crash) silently degrades
        // every downstream step to "no scope", so leave a breadcrumb rather than dropping it.
        debugLog("project-map.json failed schema validation, ignoring it", { path, issues: parsed.error.issues });
        return undefined;
    } catch (err) {
        const isMissingFile = err instanceof Error && "code" in err && err.code === "ENOENT";
        if (!isMissingFile) debugLog("Failed to read project-map.json, ignoring it", { path, err });
        return undefined;
    }
}

/** Human-readable rendering for the pipeline note / confirmation prompt. */
export function renderProjectMap(map: ProjectMap): string {
    const section = <T>(title: string, rows: T[], fmt: (row: T) => string): string => {
        if (rows.length === 0) return `${title}: (none)`;
        return `${title}:\n` + rows.map((r) => `  - ${fmt(r)}`).join("\n");
    };
    return [
        section("Frontend(s)", map.frontends, (f) => {
            const deps = f.dependsOn.length > 0 ? `  needs: ${f.dependsOn.join(", ")}` : "";
            return `${f.path}  [${f.framework}]${deps}  - ${f.why}`;
        }),
        section("Backend(s)", map.backends, (b) => {
            const dl =
                b.dataLayer != null
                    ? `  data: ${b.dataLayer.kind}${b.dataLayer.schemaPath != null ? ` @ ${b.dataLayer.schemaPath}` : ""}`
                    : "";
            return `${b.path}  [${b.language}/${b.framework}]${dl}  - ${b.why}`;
        }),
        section("Ignoring", map.ignore, (i) => `${i.path}  - ${i.why}`),
    ].join("\n\n");
}

/**
 * The scope hint appended to a downstream agent's task prompt so it confines its work
 * to the mapped surface instead of walking the whole tree. Passed as an extra message,
 * NOT baked into any tuned system prompt.
 */
export function formatFrontendScope(map: ProjectMap): string | undefined {
    if (map.frontends.length === 0) return undefined;
    const fronts = map.frontends.map((f) => f.path).join(", ");
    const ignore = map.ignore.map((i) => i.path);
    const ignoreLine =
        ignore.length > 0 ? ` Do NOT spend time in these irrelevant directories: ${ignore.join(", ")}.` : "";
    return (
        `The project has already been mapped. The frontend surface to focus on is: ${fronts}. ` +
        `Confine your exploration to that surface.${ignoreLine}`
    );
}

/**
 * A user's choice of what to actually plan tests for: exactly ONE frontend root and
 * the subset of backends needed for it to work. The mapper discovers every candidate;
 * this narrows the candidate map down to a single testable surface. On the CLI this is
 * a radio (frontend) plus checkboxes (backends); when driven by Claude the caller just
 * asks the user in natural language and hands the answer back.
 */
export interface ScopeSelection {
    frontend: string;
    backends: string[];
}

/**
 * Match a requested path against the paths a mapper run actually emitted. The mapper
 * is non-deterministic about how deep it names a path (a fullstack app's backend may
 * come back as `apps/main-app` on one run and `apps/main-app/app/api` on the next), so
 * a caller-supplied selection (flags / harness config) can't rely on an exact string.
 * Prefer an exact hit, then accept an ancestor/descendant relationship either way.
 */
function relatedPath(a: string, b: string): boolean {
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function matchMapPath(requested: string, candidates: string[]): string | undefined {
    if (candidates.includes(requested)) return requested;
    return candidates.find((c) => relatedPath(c, requested));
}

/**
 * Match a requested backend against the map, by path OR by the data layer it owns.
 * The schema path is far more stable across mapper runs than which backend the schema
 * gets attributed to: a shared data-layer package can come back attached to the
 * fullstack app, to the package itself, or to a sibling service that also reads it, on
 * different runs. So a caller that names the data-layer package (or its schema) still
 * resolves to whichever backend the mapper hung it on this time.
 */
function matchBackend(requested: string, backends: ProjectMap["backends"]): string | undefined {
    const byPath = backends.find((b) => relatedPath(b.path, requested));
    if (byPath != null) return byPath.path;
    const bySchema = backends.find(
        (b) => b.dataLayer?.schemaPath != null && relatedPath(b.dataLayer.schemaPath, requested),
    );
    return bySchema?.path;
}

/**
 * Resolve a caller-supplied selection to the exact paths present in the map, so a
 * hand-written `frontend`/`backends` still lines up after the mapper varied its path
 * depth or where it attributed a shared data layer. Frontends match by path; backends
 * match by path or by data-layer schema. Unmatched entries are passed through unchanged
 * so applySelection can throw a clear "not in the map" error listing the real candidates.
 */
export function resolveSelection(map: ProjectMap, requested: ScopeSelection): ScopeSelection {
    const frontendPaths = map.frontends.map((f) => f.path);
    return {
        frontend: matchMapPath(requested.frontend, frontendPaths) ?? requested.frontend,
        backends: requested.backends.map((b) => matchBackend(b, map.backends) ?? b),
    };
}

/**
 * The backends to seed for a frontend when the caller names none: its declared
 * dependencies, resolved to the real backend paths in this map with anything that does
 * not resolve dropped. dependsOn is LLM-emitted, so it can name a shared util or a path
 * no BackendEntry owns; keeping such an entry would make applySelection reject the whole
 * run. Resolution is tolerant (by path or data-layer schema, ancestor/descendant either
 * way) and de-duplicated, so the result is always exact backend paths applySelection accepts.
 */
export function defaultBackendsFor(map: ProjectMap, frontendPath: string): string[] {
    const declared = map.frontends.find((f) => f.path === frontendPath)?.dependsOn ?? [];
    const resolved = declared.map((dep) => matchBackend(dep, map.backends)).filter((p): p is string => p != null);
    return [...new Set(resolved)];
}

/**
 * When a candidate map has exactly one frontend, the choice is unambiguous: that
 * frontend plus the backends it declares it depends on. Returns undefined when the
 * user must pick (zero or multiple frontends), which is the "return and ask" path.
 */
export function pickDefaultSelection(map: ProjectMap): ScopeSelection | undefined {
    if (map.frontends.length !== 1) return undefined;
    const [only] = map.frontends;
    if (only == null) return undefined;
    return { frontend: only.path, backends: defaultBackendsFor(map, only.path) };
}

/**
 * Narrow a candidate map to the chosen frontend and backends. Every other frontend and
 * every unselected backend is folded into `ignore` so the downstream steps physically
 * skip them. Throws if the selection references paths the map does not contain, so a
 * bad hand-supplied choice fails loud instead of silently planning the wrong surface.
 */
export function applySelection(map: ProjectMap, selection: ScopeSelection): ProjectMap {
    const frontend = map.frontends.find((f) => f.path === selection.frontend);
    if (frontend == null) {
        const options = map.frontends.map((f) => f.path).join(", ") || "(none)";
        throw new Error(`Selected frontend "${selection.frontend}" is not in the map. Candidates: ${options}`);
    }
    const chosenBackends = map.backends.filter((b) => selection.backends.includes(b.path));
    const missing = selection.backends.filter((p) => !map.backends.some((b) => b.path === p));
    if (missing.length > 0) {
        const options = map.backends.map((b) => b.path).join(", ") || "(none)";
        throw new Error(`Selected backend(s) not in the map: ${missing.join(", ")}. Candidates: ${options}`);
    }

    const droppedFrontends = map.frontends
        .filter((f) => f.path !== selection.frontend)
        .map((f) => ({ path: f.path, why: "Another frontend in the monorepo; not the app under test." }));
    const droppedBackends = map.backends
        .filter((b) => !selection.backends.includes(b.path))
        .map((b) => ({ path: b.path, why: "Backend not required by the selected frontend." }));

    return {
        frontends: [frontend],
        backends: chosenBackends,
        ignore: [...map.ignore, ...droppedFrontends, ...droppedBackends],
    };
}

/** The scope hint for backend/data-layer-oriented steps (entity audit, recipe). */
export function formatBackendScope(map: ProjectMap): string | undefined {
    if (map.backends.length === 0) return undefined;
    const backs = map.backends
        .map((b) => (b.dataLayer?.schemaPath != null ? `${b.path} (models @ ${b.dataLayer.schemaPath})` : b.path))
        .join(", ");
    const ignore = map.ignore.map((i) => i.path);
    const ignoreLine = ignore.length > 0 ? ` Ignore these irrelevant directories: ${ignore.join(", ")}.` : "";
    return (
        `The project has already been mapped. The backend(s)/data layer(s) that own the models to seed are: ${backs}. ` +
        `Scope your data-model work to those backend(s).${ignoreLine}`
    );
}
