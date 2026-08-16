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

/** The config's own columns, without any of its children. */
function configScalars(values: PreviewkitConfigRowValues) {
    return {
        domain: values.domain,
        registry: values.registry,
        branchConventionType: values.branchConventionType,
        branchConventionPattern: values.branchConventionPattern,
        branchConventionReplacement: values.branchConventionReplacement,
    };
}

/**
 * Writes a saved topology over whatever is already stored.
 *
 * Apps are DIFFED, matched by name, so an app that survives a save keeps its row
 * id - that id is what the secrets, instances and builds hang off, and replacing
 * the rows wholesale would detach every one of them on every save. An app the
 * save no longer names is deleted, which is the only way its dependents are meant
 * to go.
 *
 * The other children have nothing pointing at them and are swapped wholesale.
 *
 * Written as ordered statements rather than one nested write because the order is
 * load-bearing for the replaced children: repositories, services and hooks are
 * delete-then-create and each is unique on `(configId, position)`, so a create
 * landing before the delete collides on a position that is about to be freed.
 */
export async function writePreviewkitConfigTopology(
    tx: Prisma.TransactionClient,
    configId: string,
    values: PreviewkitConfigRowValues,
): Promise<void> {
    const existing = await tx.previewkitApp.findMany({ where: { configId }, select: { id: true, name: true } });
    const idByName = new Map(existing.map((app) => [app.name, app.id]));

    const keptIds = values.apps.map((app) => idByName.get(app.name)).filter((id) => id != null);
    // An empty `notIn` is not the same question as "delete everything", so the two
    // cases are separate filters rather than one with an empty list in it.
    const doomed: Prisma.PreviewkitAppWhereInput =
        keptIds.length > 0 ? { configId, id: { notIn: keptIds } } : { configId };
    await tx.previewkitApp.deleteMany({ where: doomed });

    for (const app of values.apps) {
        const id = idByName.get(app.name);
        const { connections, ...columns } = app;
        if (id == null) {
            await tx.previewkitApp.create({
                data: { ...columns, configId, connections: { create: connections } },
            });
            continue;
        }
        await tx.previewkitApp.update({
            where: { id },
            data: { ...columns, connections: { deleteMany: {}, create: connections } },
        });
    }

    await tx.previewkitConfigRepository.deleteMany({ where: { configId } });
    await tx.previewkitConfigService.deleteMany({ where: { configId } });
    await tx.previewkitConfigHook.deleteMany({ where: { configId } });
    await tx.previewkitConfig.update({
        where: { id: configId },
        data: {
            ...configScalars(values),
            repositories: { create: values.repositories },
            services: {
                create: values.services.map((service) => ({ ...service, setupTasks: { create: service.setupTasks } })),
            },
            hooks: { create: values.hooks },
        },
    });
}
