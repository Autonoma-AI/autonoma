import { Prisma, type PrismaClient } from "@autonoma/db";
import { BadRequestError } from "@autonoma/errors";
import {
    authoringPreviewConfigSchema,
    PREVIEWKIT_RUNTIME_CATALOG,
    previewConfigSchema,
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
 */
export function defaultPreviewkitConfig(applicationName?: string): PreviewConfig {
    return previewConfigSchema.parse({
        version: 1,
        apps: [
            {
                name: kebabCaseAppName(applicationName),
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
 * errors. Semantic checks run separately on the merged multi-repo topology
 * (see `mergeConfigsForValidation`), because references like `depends_on` may
 * legitimately cross repo documents.
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

/** Concatenates apps/services/hooks across documents, mirroring the pipeline's mergeConfigs. */
export function mergeConfigsForValidation(primary: PreviewConfig, dependencies: PreviewConfig[]): PreviewConfig {
    return {
        ...primary,
        apps: [...primary.apps, ...dependencies.flatMap((dependency) => dependency.apps)],
        services: [...primary.services, ...dependencies.flatMap((dependency) => dependency.services)],
        hooks: {
            pre_deploy: [...primary.hooks.pre_deploy, ...dependencies.flatMap((d) => d.hooks.pre_deploy)],
            post_deploy: [...primary.hooks.post_deploy, ...dependencies.flatMap((d) => d.hooks.post_deploy)],
        },
    };
}

/** A multirepo dependency's config, stored on the primary config's `dependencyDocuments`. */
export interface DependencyDocument {
    /** Repo full name (`owner/repo`) declared in the primary's `config.multirepo.repos`. */
    repo: string;
    document: PreviewConfig;
}

const storedDependencyDocumentsSchema = z.array(z.object({ repo: z.string(), document: previewConfigSchema }));

/**
 * Parses the `dependencyDocuments` JSON stored on a config. Returns []
 * for null/absent (single-repo project); `invalid: true` when a present value no
 * longer validates, so the caller can log it rather than silently dropping
 * dependencies.
 */
export function parseStoredDependencyDocuments(value: unknown): {
    documents: DependencyDocument[];
    invalid: boolean;
} {
    if (value == null) return { documents: [], invalid: false };
    const parsed = storedDependencyDocumentsSchema.safeParse(value);
    if (!parsed.success) return { documents: [], invalid: true };
    return { documents: parsed.data, invalid: false };
}

/**
 * Saves an Application's preview config - latest-only, so this overwrites the
 * single `PreviewkitConfig` row in place (creating it on first save).
 * `dependencyDocuments` (primary-app saves only) carries the multirepo
 * dependency configs the deploy reads - dependency repos are not separate
 * Applications.
 */
export async function upsertConfig(
    db: PrismaClient,
    applicationId: string,
    config: PreviewConfig,
    dependencyDocuments: DependencyDocument[] = [],
): Promise<void> {
    const savedDocument = JSON.parse(JSON.stringify(config));
    const savedDependencyDocuments =
        dependencyDocuments.length > 0 ? JSON.parse(JSON.stringify(dependencyDocuments)) : Prisma.DbNull;

    await db.previewkitConfig.upsert({
        where: { applicationId },
        create: {
            applicationId,
            document: savedDocument,
            dependencyDocuments: savedDependencyDocuments,
        },
        update: {
            document: savedDocument,
            dependencyDocuments: savedDependencyDocuments,
        },
    });
}

/**
 * Accumulates app/service/addon names across a multi-repo topology, throwing when
 * two documents claim the same name. Within-document duplicates are already
 * schema errors; this guards the merged deploy (which concatenates all docs).
 */
export function collectTopologyNames(config: PreviewConfig, sourceLabel: string, seen: Map<string, string>): void {
    const names = [
        ...config.apps.map((app) => app.name),
        ...config.services.map((service) => service.name),
        ...config.addons.map((addon) => addon.name),
    ];
    for (const name of names) {
        const existing = seen.get(name);
        if (existing != null && existing !== sourceLabel) {
            throw new BadRequestError(
                `Name "${name}" is used by both ${existing} and ${sourceLabel} - names must be unique across the merged preview topology`,
            );
        }
        seen.set(name, sourceLabel);
    }
}

/** Strips leading "./" / "/" and trailing "/" so config paths compare against git tree paths. */
export function normalizeRepoPath(value: string): string {
    return value
        .replace(/^\.?\//, "")
        .replace(/^\.$/, "")
        .replace(/\/+$/, "");
}
