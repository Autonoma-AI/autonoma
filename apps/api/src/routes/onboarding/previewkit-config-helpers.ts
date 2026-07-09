import { Prisma } from "@autonoma/db";
import { BadRequestError } from "@autonoma/errors";
import { CURRENT_CONFIG_SCHEMA_VERSION, previewConfigSchema, type PreviewConfig } from "@autonoma/types";
import { z } from "zod";

/** The starter config used when an application has never saved a PreviewKit revision. */
export function defaultPreviewkitConfig(): PreviewConfig {
    return previewConfigSchema.parse({
        version: 1,
        apps: [
            {
                name: "web",
                path: ".",
                port: 3000,
                primary: true,
                health_check: "/",
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
 */
export function parseConfigShapeOrThrow(document: unknown): PreviewConfig {
    const validation = previewConfigSchema.safeParse(document);
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

/** A multirepo dependency's config, stored on the primary revision's `dependencyDocuments`. */
export interface DependencyRevisionDocument {
    /** Repo full name (`owner/repo`) declared in the primary's `config.multirepo.repos`. */
    repo: string;
    document: PreviewConfig;
}

const storedDependencyDocumentsSchema = z.array(z.object({ repo: z.string(), document: previewConfigSchema }));

/**
 * Parses the `dependencyDocuments` JSON stored on a config revision. Returns []
 * for null/absent (single-repo project); `invalid: true` when a present value no
 * longer validates, so the caller can log it rather than silently dropping
 * dependencies.
 */
export function parseStoredDependencyDocuments(value: unknown): {
    documents: DependencyRevisionDocument[];
    invalid: boolean;
} {
    if (value == null) return { documents: [], invalid: false };
    const parsed = storedDependencyDocumentsSchema.safeParse(value);
    if (!parsed.success) return { documents: [], invalid: true };
    return { documents: parsed.data, invalid: false };
}

/**
 * Creates the next config revision for an Application and points its active
 * revision at it. `dependencyDocuments` (primary-app saves only) carries the
 * multirepo dependency configs the deploy reads - dependency repos are not
 * separate Applications.
 */
export async function createAndActivateRevision(
    tx: Prisma.TransactionClient,
    applicationId: string,
    config: PreviewConfig,
    dependencyDocuments: DependencyRevisionDocument[] = [],
): Promise<{ id: string; revision: number }> {
    const savedDocument = JSON.parse(JSON.stringify(config));
    const savedDependencyDocuments =
        dependencyDocuments.length > 0 ? JSON.parse(JSON.stringify(dependencyDocuments)) : Prisma.DbNull;
    const last = await tx.previewkitConfigRevision.findFirst({
        where: { applicationId },
        orderBy: { revision: "desc" },
        select: { revision: true },
    });
    const revision = (last?.revision ?? 0) + 1;

    const row = await tx.previewkitConfigRevision.create({
        data: {
            applicationId,
            revision,
            schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
            document: savedDocument,
            dependencyDocuments: savedDependencyDocuments,
        },
        select: { id: true, revision: true },
    });

    await tx.application.update({
        where: { id: applicationId },
        data: { activeConfigRevisionId: row.id },
    });

    return row;
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
