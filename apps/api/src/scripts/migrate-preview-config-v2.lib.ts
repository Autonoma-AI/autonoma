import { previewConfigSchema } from "@autonoma/types";
import { z } from "zod";

/**
 * Pure v1 -> v2 preview-config document transform (see the CLI shell in
 * `migrate-preview-config-v2.ts`). What changes between the shapes:
 *
 * - `version: 1` -> `version: 2`;
 * - every app gains a mandatory `repository` (`owner/repo` full name): primary
 *   apps get the Application's repo, sidecar-dependency apps get their entry's;
 * - the `dependencyDocuments` sidecar's apps/services/hooks fold into the one
 *   document (their other root fields - domain, registry - were always ignored
 *   by the merge and are dropped);
 * - `config.multirepo.repos` -> top-level `repositories[]` (the k8s-safe alias
 *   is retired; entries keep `fallback_branch` and any recorded `sha`), and
 *   `config.multirepo.branch_convention` hoists to top-level `branch_convention`;
 * - setup-task `location.repo` alias references map to full names.
 *
 * Everything else passes through verbatim - the transform restructures, it
 * never normalizes (so authored resource overrides etc. survive byte-for-byte).
 */

const v1RepoSchema = z.looseObject({
    name: z.string(),
    repo: z.string(),
    fallback_branch: z.string().optional(),
    sha: z.string().optional(),
});

const v1AppSchema = z.looseObject({ name: z.string() });

const v1SetupTaskSchema = z.looseObject({
    location: z.looseObject({ type: z.string(), repo: z.string().optional() }).optional(),
});

const v1ServiceSchema = z.looseObject({
    name: z.string(),
    setup_tasks: z.array(v1SetupTaskSchema).optional(),
});

const v1HooksSchema = z.looseObject({
    pre_deploy: z.array(z.unknown()).optional(),
    post_deploy: z.array(z.unknown()).optional(),
});

const v1DocumentSchema = z.looseObject({
    version: z.literal(1),
    config: z
        .looseObject({
            multirepo: z
                .looseObject({
                    branch_convention: z.unknown().optional(),
                    repos: z.array(v1RepoSchema).optional(),
                })
                .optional(),
        })
        .optional(),
    apps: z.array(v1AppSchema),
    services: z.array(v1ServiceSchema).optional(),
    hooks: v1HooksSchema.optional(),
});

const sidecarSchema = z.array(z.object({ repo: z.string(), document: v1DocumentSchema }));

const versionProbeSchema = z.looseObject({ version: z.number() });

type V1Document = z.infer<typeof v1DocumentSchema>;

export interface MigrateV2Input {
    /** The stored v1 `document` JSON (primary document, or an already-merged resolvedConfig). */
    document: unknown;
    /** The raw `dependencyDocuments` sidecar JSON (`[{repo, document}]` or null/absent). */
    dependencyDocuments?: unknown;
    /** The Application's repo full name (`owner/repo`) - stamped on primary apps. */
    primaryRepository: string;
    /**
     * app name -> repository overrides for documents whose apps are already
     * merged across repos (resolvedConfig rows). An app without an override is
     * attributed to the primary repository.
     */
    appRepositories?: ReadonlyMap<string, string>;
}

export type MigrateV2Result =
    | { status: "migrated"; document: Record<string, unknown> }
    | { status: "already_v2" }
    | { status: "invalid"; reason: string };

export function migratePreviewConfigToV2(input: MigrateV2Input): MigrateV2Result {
    const probe = versionProbeSchema.safeParse(input.document);
    if (probe.success && probe.data.version === 2) return { status: "already_v2" };

    const primary = v1DocumentSchema.safeParse(input.document);
    if (!primary.success) {
        return { status: "invalid", reason: `document does not parse as v1: ${z.prettifyError(primary.error)}` };
    }

    const sidecar = parseSidecar(input.dependencyDocuments);
    if (sidecar.status === "invalid") return sidecar;

    const multirepo = primary.data.config?.multirepo;
    const aliasToRepo = new Map((multirepo?.repos ?? []).map((repo) => [repo.name, repo.repo]));

    const document: Record<string, unknown> = { ...primary.data };
    delete document["config"];
    document["version"] = 2;

    const repositories = (multirepo?.repos ?? []).map((repo) => {
        const entry: Record<string, unknown> = { repo: repo.repo };
        if (repo.fallback_branch != null) entry["fallback_branch"] = repo.fallback_branch;
        if (repo.sha != null) entry["sha"] = repo.sha;
        return entry;
    });
    if (repositories.length > 0) document["repositories"] = repositories;
    if (multirepo?.branch_convention != null) document["branch_convention"] = multirepo.branch_convention;

    document["apps"] = [
        ...primary.data.apps.map((app) => stampRepository(app, input.primaryRepository, input.appRepositories)),
        ...sidecar.entries.flatMap((entry) => entry.document.apps.map((app) => stampRepository(app, entry.repo))),
    ];

    const services = [
        ...(primary.data.services ?? []),
        ...sidecar.entries.flatMap((entry) => entry.document.services ?? []),
    ];
    if (services.length > 0 || primary.data.services != null) {
        document["services"] = services.map((service) => mapSetupTaskRepos(service, aliasToRepo));
    }

    const hooks = mergeHooks(primary.data, sidecar.entries);
    if (hooks != null) document["hooks"] = hooks;

    const validation = previewConfigSchema.safeParse(document);
    if (!validation.success) {
        return {
            status: "invalid",
            reason: `migrated document does not validate: ${z.prettifyError(validation.error)}`,
        };
    }
    return { status: "migrated", document };
}

function parseSidecar(
    value: unknown,
): { status: "ok"; entries: Array<{ repo: string; document: V1Document }> } | { status: "invalid"; reason: string } {
    if (value == null) return { status: "ok", entries: [] };
    const parsed = sidecarSchema.safeParse(value);
    if (!parsed.success) {
        return { status: "invalid", reason: `dependencyDocuments do not parse: ${z.prettifyError(parsed.error)}` };
    }
    return { status: "ok", entries: parsed.data };
}

function stampRepository(
    app: { name: string },
    fallbackRepository: string,
    overrides?: ReadonlyMap<string, string>,
): Record<string, unknown> {
    return { ...app, repository: overrides?.get(app.name) ?? fallbackRepository };
}

/** Rewrites a service's setup-task `location.repo` alias references to full names. */
function mapSetupTaskRepos(
    service: z.infer<typeof v1ServiceSchema>,
    aliasToRepo: ReadonlyMap<string, string>,
): Record<string, unknown> {
    if (service.setup_tasks == null || service.setup_tasks.length === 0) return service;
    const setupTasks = service.setup_tasks.map((task) => {
        const repoAlias = task.location?.repo;
        if (task.location == null || repoAlias == null) return task;
        // An alias with no declaration was already dangling in v1; left as-is.
        const repo = aliasToRepo.get(repoAlias) ?? repoAlias;
        return { ...task, location: { ...task.location, repo } };
    });
    return { ...service, setup_tasks: setupTasks };
}

function mergeHooks(
    primary: V1Document,
    dependencies: Array<{ repo: string; document: V1Document }>,
): Record<string, unknown> | undefined {
    const dependencyHooks = dependencies.map((entry) => entry.document.hooks);
    if (primary.hooks == null && dependencyHooks.every((hooks) => hooks == null)) return undefined;
    return {
        ...primary.hooks,
        pre_deploy: [
            ...(primary.hooks?.pre_deploy ?? []),
            ...dependencyHooks.flatMap((hooks) => hooks?.pre_deploy ?? []),
        ],
        post_deploy: [
            ...(primary.hooks?.post_deploy ?? []),
            ...dependencyHooks.flatMap((hooks) => hooks?.post_deploy ?? []),
        ],
    };
}
