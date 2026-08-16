import { type PrismaClient, writePreviewkitConfigTopology } from "@autonoma/db";
import { BadRequestError } from "@autonoma/errors";
import {
    authoringPreviewConfigSchema,
    PREVIEWKIT_RUNTIME_CATALOG,
    previewConfigSchema,
    previewkitConfigRowValues,
    type PreviewConfig,
} from "@autonoma/types";
import { z } from "zod";

const FALLBACK_APP_NAME = "web";
const MAX_K8S_NAME_LENGTH = 63;
// A path is a Dockerfile when its basename carries `Dockerfile` as its name or
// as a name/extension affix (`Dockerfile`, `web.Dockerfile`, `Dockerfile.prod`).
const DOCKERFILE_BASENAME = /dockerfile/i;

/**
 * Narrows a repo file tree to just its Dockerfiles, sorted alphabetically. Used
 * by the config editor's Dockerfile picker so the whole tree never crosses the
 * wire - only the handful of paths the picker can actually offer.
 */
export function filterDockerfilePaths(paths: readonly string[]): string[] {
    return paths
        .filter((path) => DOCKERFILE_BASENAME.test(path.split("/").pop() ?? path))
        .sort((a, b) => a.localeCompare(b));
}
// The starter app opens in Manual mode on the Node runtime - the most common
// stack - so the seeded config is complete and immediately deployable. The
// runtime catalog is the single source for these defaults (UI tiles + generator).
const STARTER_RUNTIME = PREVIEWKIT_RUNTIME_CATALOG.node;

/**
 * Turns an application name into a Kubernetes-safe, kebab-case app name: lowercase
 * alphanumeric segments joined by single hyphens, trimmed to a leading/trailing
 * alphanumeric, capped at 63 chars. Falls back to `web` when nothing usable
 * remains - the k8s name schema requires at least two characters, so an empty or
 * single-character slug (e.g. a name with no ASCII alphanumerics) uses the
 * fallback rather than producing an invalid name.
 */
export function kebabCaseAppName(value: string | undefined): string {
    const slug = (value ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, MAX_K8S_NAME_LENGTH)
        .replace(/-+$/g, "");
    return slug.length < 2 ? FALLBACK_APP_NAME : slug;
}

/**
 * The starter config used when an application has never saved a PreviewKit
 * config. The single starter app is named after the application (kebab-cased)
 * so it lands as a sensible, Kubernetes-safe default instead of a generic `web`,
 * and carries a complete Manual (runtime) build block so the config is valid and
 * deployable as-is - what the user sees in the form is exactly what deploys.
 * `repository` is the Application's repo full name, resolved by the caller.
 */
export function defaultPreviewkitConfig(applicationName: string | undefined, repository: string): PreviewConfig {
    return previewConfigSchema.parse({
        version: 2,
        apps: [
            {
                name: kebabCaseAppName(applicationName),
                repository,
                path: ".",
                port: 3000,
                primary: true,
                health_check: "/",
                build: {
                    framework: "runtime",
                    runtime: STARTER_RUNTIME.id,
                    version: STARTER_RUNTIME.defaultVersion,
                    build_script: STARTER_RUNTIME.defaultBuildScript,
                    entrypoint: STARTER_RUNTIME.defaultEntrypoint,
                },
            },
        ],
        services: [{ name: "db", recipe: "postgres", version: "16" }],
    });
}

/**
 * Schema-validates a config document, throwing `BadRequestError` on shape
 * errors. Semantic checks (depends_on, hooks, repository membership) run
 * separately in `PreviewkitConfigService`.
 *
 * This is the shared write path, so it accepts a retired framework preset: the
 * debug surfaces read a stored document, patch one field and save it back, and
 * must not be blocked by a build block they never touched. Onboarding holds
 * itself to the stricter {@link parseAuthoredConfigShapeOrThrow}.
 */
export function parseConfigShapeOrThrow(document: unknown): PreviewConfig {
    return parseOrThrow(previewConfigSchema, document);
}

/**
 * Schema-validates a config document against the AUTHORING contract - everything
 * {@link parseConfigShapeOrThrow} enforces, plus the rule that an app's build must
 * be one of the two methods the config editor renders. Onboarding validates every
 * write through this, so it can never introduce a build the user cannot open and
 * edit; a document that already carries a retired preset has to convert that app
 * before it saves again.
 */
export function parseAuthoredConfigShapeOrThrow(document: unknown): PreviewConfig {
    return parseOrThrow(authoringPreviewConfigSchema, document);
}

function parseOrThrow(schema: z.ZodType<PreviewConfig>, document: unknown): PreviewConfig {
    const validation = schema.safeParse(document);
    if (!validation.success) {
        throw new BadRequestError(`Invalid PreviewKit config: ${z.prettifyError(validation.error)}`);
    }
    return validation.data;
}

/**
 * Saves an Application's preview config - latest-only, so this overwrites the
 * single `PreviewkitConfig` row in place (creating it on first save). The config
 * is the whole topology: multirepo dependency apps are part of it too, each
 * tagged with its `repository` - dependency repos are not separate Applications.
 *
 * Written to the normalized topology rows only. The retired `document` column is
 * left alone - readers compose the config from these rows, so writing it would
 * only maintain a copy nothing consults. The nested writes keep a save atomic, and
 * the children are replaced wholesale rather than diffed: a save rewrites the whole
 * topology, and nothing outside the config references those rows.
 */
export async function upsertConfig(db: PrismaClient, applicationId: string, config: PreviewConfig): Promise<void> {
    const rows = previewkitConfigRowValues(config);

    await db.$transaction(async (tx) => {
        const { id } = await tx.previewkitConfig.upsert({
            where: { applicationId },
            create: { applicationId },
            update: {},
            select: { id: true },
        });
        await writePreviewkitConfigTopology(tx, id, rows);
    });
}

/** Strips leading "./" / "/" and trailing "/" so config paths compare against git tree paths. */
export function normalizeRepoPath(value: string): string {
    return value
        .replace(/^\.?\//, "")
        .replace(/^\.$/, "")
        .replace(/\/+$/, "");
}
