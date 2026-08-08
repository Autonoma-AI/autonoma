import type { PreviewkitConfigRowValues } from "@autonoma/types";
import type { Prisma } from "./generated/prisma/client";

/**
 * The include every reader of a preview config uses. The `orderBy`s are what make
 * the composed document match what was saved - hook order is execution order, and
 * app order feeds the editor and the primary-app fallback - so the include lives
 * here once rather than being retyped at each call site.
 */
export const previewkitConfigRowsInclude = {
    repositories: { orderBy: { position: "asc" } },
    apps: { orderBy: { position: "asc" }, include: { connections: { orderBy: { position: "asc" } } } },
    services: { orderBy: { position: "asc" }, include: { setupTasks: { orderBy: { position: "asc" } } } },
    hooks: { orderBy: { position: "asc" } },
} as const satisfies Prisma.PreviewkitConfigInclude;

export type PreviewkitConfigWithRows = Prisma.PreviewkitConfigGetPayload<{
    include: typeof previewkitConfigRowsInclude;
}>;

/** The topology children of a config being created, as one nested write. */
export function previewkitConfigCreateChildren(values: PreviewkitConfigRowValues) {
    return {
        domain: values.domain,
        registry: values.registry,
        branchConventionType: values.branchConventionType,
        branchConventionPattern: values.branchConventionPattern,
        branchConventionReplacement: values.branchConventionReplacement,
        repositories: { create: values.repositories },
        apps: { create: values.apps.map((app) => ({ ...app, connections: { create: app.connections } })) },
        services: {
            create: values.services.map((service) => ({ ...service, setupTasks: { create: service.setupTasks } })),
        },
        hooks: { create: values.hooks },
    } satisfies Prisma.PreviewkitConfigUpdateInput;
}

/**
 * The same children as a full replace. A save rewrites the whole document, so the
 * children are swapped wholesale rather than diffed; nothing outside the config
 * references these rows, so the delete cannot reach anything else. (Sibling tables
 * key on the app NAME as a plain string, deliberately not a foreign key.)
 */
export function previewkitConfigReplaceChildren(values: PreviewkitConfigRowValues) {
    const children = previewkitConfigCreateChildren(values);
    return {
        ...children,
        repositories: { deleteMany: {}, create: values.repositories },
        apps: {
            deleteMany: {},
            create: values.apps.map((app) => ({ ...app, connections: { create: app.connections } })),
        },
        services: {
            deleteMany: {},
            create: values.services.map((service) => ({ ...service, setupTasks: { create: service.setupTasks } })),
        },
        hooks: { deleteMany: {}, create: values.hooks },
    } satisfies Prisma.PreviewkitConfigUpdateInput;
}
