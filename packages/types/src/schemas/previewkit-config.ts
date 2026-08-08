import { z } from "zod";
import { isReservedPreviewkitEnvKey } from "./previewkit-builtins";
import { type BlueprintNodePm, PREVIEWKIT_NODE_PM_CATALOG } from "./previewkit-node-pm";
import {
    PREVIEWKIT_PRESET_IDS,
    previewkitPresetDefaultVersion,
    previewkitPresetSpec,
    type PreviewkitPresetSpec,
} from "./previewkit-presets";
import { PREVIEWKIT_RUNTIME_IDS, type PreviewkitRuntime } from "./previewkit-runtimes";
import { SecretKeySchema } from "./secrets";

export interface ContainerResources {
    cpu: string;
    memoryRequest: string;
    memoryLimit: string;
}

export const STANDARD_RESOURCES = {
    app: { cpu: "250m", memoryRequest: "512Mi", memoryLimit: "1Gi" },
    service: { cpu: "100m", memoryRequest: "256Mi", memoryLimit: "1Gi" },
} as const;

export type PreviewResourceRole = keyof typeof STANDARD_RESOURCES;

/**
 * The config document format every stored and authored document declares. Not
 * persisted as a column: the schema itself is the compatibility layer, so a
 * document composed from storage stamps this on the way out.
 */
export const PREVIEW_CONFIG_VERSION = 2;

const k8sNameRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

// A GitHub repository full name: `owner/repo`, exactly one slash, no whitespace.
const repoFullNameRegex = /^[^/\s]+\/[^/\s]+$/;

/**
 * Per-container `resources` input. `cpu` and `memory` are the client-facing
 * knobs; the normalized `memoryRequest` / `memoryLimit` keys are accepted too so
 * that re-parsing an already-resolved config is idempotent (the merged config is
 * re-validated at deploy time after crossing the Temporal activity boundary).
 *
 * Whether these values take effect is decided by the config's source, not the
 * field itself - see {@link buildResourcesSchema}.
 */
const resourcesInput = z
    .object({
        cpu: z.string().optional(),
        memory: z.string().optional(),
        memoryRequest: z.string().optional(),
        memoryLimit: z.string().optional(),
    })
    .optional();

/**
 * Builds the `resources` schema for one container tier. The trust boundary lives
 * here: per-app/service resource sizing is honored only for trusted,
 * platform-authored config, never for untrusted client input (so onboarding
 * users can't set unbounded budgets for their own preview).
 *
 * - `allowCustomResources === false` (untrusted client input): client input is
 *   discarded; every container gets the standard {@link STANDARD_RESOURCES} tier
 *   for its role. The field is still accepted so existing configs keep validating.
 * - `allowCustomResources === true` (trusted platform-authored config): client
 *   `cpu` / `memory` are honored, each missing field falling back to the tier standard.
 *   `memory` sets both the request and the limit unless the normalized
 *   `memoryRequest` / `memoryLimit` are present (the deploy-time re-parse).
 */
function buildResourcesSchema(role: PreviewResourceRole, allowCustomResources: boolean) {
    return resourcesInput.transform((input) => {
        if (!allowCustomResources || input == null) {
            return standardResources(role);
        }
        const tier = STANDARD_RESOURCES[role];
        return {
            cpu: input.cpu ?? tier.cpu,
            memoryRequest: input.memoryRequest ?? input.memory ?? tier.memoryRequest,
            memoryLimit: input.memoryLimit ?? input.memory ?? tier.memoryLimit,
        };
    });
}

// `appSchema` and `serviceSchema` are built inside `buildPreviewConfigSchema`
// (below) so their `resources` tier can be gated by `allowCustomResources`.

const branchConventionSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("same_branch_name") }),
    z.object({
        type: z.literal("regex"),
        pattern: z.string().refine((pattern) => {
            try {
                new RegExp(pattern);
                return true;
            } catch {
                return false;
            }
        }, "Invalid regular expression pattern"),
        replacement: z.string(),
    }),
    z.object({ type: z.literal("manual") }),
]);

/**
 * Per-repository deploy settings. The topology's repository set is derived from
 * the apps (`apps[].repository`) - an entry here is never what ADDS a repo, it
 * only overrides the defaults for one (today: which branch to clone when the
 * PR's branch does not exist there) and receives deploy provenance.
 */
const repositorySettingsSchema = z.object({
    repo: z.string().regex(repoFullNameRegex, "Must be an owner/repo full name"),
    fallback_branch: z.string().default("main"),
    /**
     * The concrete commit SHA the repository was deployed at. Absent in
     * user-authored config: previewkit resolves each dependency repo's branch to
     * a commit at deploy time and records it here by enriching the stored
     * `resolvedConfig` (deploy provenance, not authored input). Multi-repo
     * grounding reads this back to inspect the exact code that was live.
     */
    sha: z.string().optional(),
});

// A pre/post-deploy hook step. Every hook runs as a one-off Kubernetes Job
// built from the target app's image (see previewkit's hook-job-runner); there
// is no in-pod exec variant.
const hookStepSchema = z.object({
    app: z.string(),
    command: z.string(),
});

const hooksSchema = z
    .object({
        pre_deploy: z.array(hookStepSchema).default([]),
        post_deploy: z.array(hookStepSchema).default([]),
    })
    .default({ pre_deploy: [], post_deploy: [] });

/**
 * The database engines offered in the onboarding Database step. Each maps to a
 * service recipe of the same name (see apps/previewkit `recipes/`): a database
 * is stored as a `service` whose `recipe` is one of these, so it provisions
 * through the same tested recipe machinery as every other service and is a
 * `{{name.host}}` connection target for free. Valkey is its own recipe (a
 * drop-in Redis) rather than a variant of `redis`.
 */
export const PREVIEWKIT_DATABASE_ENGINES = ["postgres", "mysql", "mongodb", "redis", "valkey"] as const;
export type PreviewkitDatabaseEngine = (typeof PREVIEWKIT_DATABASE_ENGINES)[number];

export function isPreviewkitDatabaseEngine(recipe: string): recipe is PreviewkitDatabaseEngine {
    const engines: readonly string[] = PREVIEWKIT_DATABASE_ENGINES;
    return engines.includes(recipe);
}

/**
 * Where a database setup task runs. The repo is always checked out so the task
 * can read files that live in the repo (a `db/schema.sql`, a `migrate` script)
 * rather than in the production database image.
 * - `in_build`: rides an app's build container - the repo is already checked
 *   out there and the build output is available - running before or after that
 *   app's build step.
 * - `separate_job`: its own throwaway container with a fresh checkout of the
 *   chosen repo (`repo` is an `owner/repo` full name from the topology, i.e. an
 *   `apps[].repository` value; absent = the primary repo), independent of any
 *   app build.
 *
 * NOTE: the runner does not yet honor `type` / `position` / `repo` - every task
 * currently runs as a standalone job from the primary app's image between infra
 * and app deploy. These fields are persisted for when that wiring lands.
 */
const databaseSetupLocationSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("in_build"),
        app: z.string().min(1, "an app is required for an in-build task"),
        position: z.enum(["before", "after"]),
    }),
    z.object({
        type: z.literal("separate_job"),
        repo: z.string().optional(),
    }),
]);

/**
 * A single database setup command (schema creation, seed data, or a migration).
 * `frequency` separates one-time setup (`on_create`, e.g. table creation and
 * initial seed) from per-deploy setup (`every_commit`, e.g. migrations). Runs
 * with the repo checked out; see {@link databaseSetupLocationSchema} for where.
 */
const databaseSetupTaskSchema = z.object({
    command: z.string(),
    frequency: z.enum(["on_create", "every_commit"]),
    location: databaseSetupLocationSchema,
});

// `build` selects an app's build strategy, discriminated on `framework`. Two
// methods can be AUTHORED (they are the two the dashboard editor renders and the
// only two the onboarding MCP offers):
// - dockerfile: build a user-authored Dockerfile at the given path. `target`
//   selects a stage in a multi-stage Dockerfile (buildctl `--opt target=`),
//   matching `docker build --target`. Without it, buildkit builds the LAST
//   stage - which silently builds the wrong service when a Dockerfile ends with
//   a worker/sidecar stage instead of the deployable one.
// - runtime: the raw escape hatch (see previewkit-runtimes.ts). The user picks a
//   language runtime or bare base image and writes a bash `build_script` +
//   `entrypoint`; the generator emits `FROM <image>` / `RUN <build_script>` /
//   `CMD <entrypoint>` with a tiered toolbelt, skipping all autodetection.
// A third group - the node / next / vite / bun framework presets - is RETIRED
// from authoring and survives only so already-stored documents keep parsing and
// deploying; see {@link DEPRECATED_BUILD_FRAMEWORKS}.
// When `build` is omitted the app's bare `dockerfile` field (or a Dockerfile on
// disk at the app path) is built via the same BuildKit Dockerfile path; there is
// no autodetection, and an app with neither a `build` block nor any Dockerfile
// fails the deploy with an actionable error. `build_context: root` builds from
// the repository root so workspace dependencies resolve.
// Next.js `output: 'standalone'` is supported by setting an explicit
// `entrypoint` (e.g. `node apps/web/.next/standalone/server.js`); there is no
// autodetection of the next.config - the entrypoint is the single source of
// truth for how the container starts.
const nodeVersionRegex = /^\d+(\.\d+)?(\.\d+)?$/;
const buildContextSchema = z.enum(["app", "root"]).default("app");

/**
 * Delimiter the previewkit generator uses for the raw `build_script` heredoc. A
 * script line exactly equal to it would close the heredoc early (build breakage /
 * generated-Dockerfile injection), so the schema rejects that below and the
 * generator reads this same constant - one source of truth.
 */
export const PREVIEWKIT_BUILD_SCRIPT_HEREDOC = "AUTONOMA_BUILD_EOF";

// Shared safety guards for user-supplied values baked into the generated Dockerfile.
// The `runtime` build arm and the additive `blueprint` overrides feed the same
// generator, so they must enforce the same guards - defined once here, applied on both.

// A value rendered verbatim into a single-line `CMD` (an entrypoint, or a path
// interpolated into one): a line break would close the CMD and inject a bogus
// Dockerfile instruction (e.g. "npm start\nRUN rm -rf /").
function singleLineCommand(label: string) {
    return z
        .string()
        .min(1)
        .regex(/^[^\r\n]+$/, `${label} must be a single line (no line breaks)`);
}

// A value baked into the `build_script` heredoc: a line equal to the delimiter would
// close the heredoc early and inject the rest as Dockerfile instructions.
function heredocSafeScript(label: string) {
    return z
        .string()
        .min(1)
        .refine(
            (value) => !value.split("\n").includes(PREVIEWKIT_BUILD_SCRIPT_HEREDOC),
            `${label} cannot contain a line equal to "${PREVIEWKIT_BUILD_SCRIPT_HEREDOC}" (reserved heredoc delimiter)`,
        );
}

// A safe image-tag charset so a user-picked version can never break out of the
// generated `FROM` line.
const imageTagSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a valid image tag");

/**
 * Framework presets retired from the authoring surface. They generate a
 * Dockerfile from install / build / run commands defaulted per framework, which
 * the `runtime` escape hatch expresses more generally (same base image, the
 * commands written out). No editor can produce or render one, so they exist only
 * as a READ path: documents saved before the retirement keep parsing and keep
 * deploying exactly as they did. {@link authoringPreviewConfigSchema} rejects
 * them, so no new document can acquire one.
 */
export const DEPRECATED_BUILD_FRAMEWORKS = ["node", "next", "vite", "bun"] as const;
export type DeprecatedBuildFramework = (typeof DEPRECATED_BUILD_FRAMEWORKS)[number];

export function isDeprecatedBuildFramework(framework: string): framework is DeprecatedBuildFramework {
    const frameworks: readonly string[] = DEPRECATED_BUILD_FRAMEWORKS;
    return frameworks.includes(framework);
}

/**
 * What a caller sees when it authors a `build` block with an unknown or retired
 * `framework`. Names both supported methods, because the discriminated union's
 * default ("no matching discriminator") tells an agent nothing about what to do
 * instead - and a coding agent driving the MCP is the caller most likely to hit it.
 */
const UNSUPPORTED_BUILD_METHOD_MESSAGE =
    `Unsupported build method. Use "runtime" (pick a runtime, then write a bash build_script and a single-line ` +
    `entrypoint) or "dockerfile" (build a Dockerfile committed in the repo). The ` +
    `${DEPRECATED_BUILD_FRAMEWORKS.join(" / ")} framework presets are retired and can no longer be saved - express ` +
    `them as "runtime" with the install and build commands in build_script and the start command as entrypoint.`;

function nodeFrameworkBuildSchema<TFramework extends "node" | "next" | "vite">(framework: TFramework) {
    return z.object({
        framework: z.literal(framework),
        package_manager: z.enum(["npm", "pnpm", "yarn"]).default("pnpm"),
        node_version: z.string().regex(nodeVersionRegex, "must look like 22, 22.5, or 22.5.0").default("22"),
        install_command: z.string().min(1).optional(),
        build_command: z.string().min(1).optional(),
        run_command: z.string().min(1).optional(),
        build_context: buildContextSchema,
    });
}

/** Read-only compatibility arms - see {@link DEPRECATED_BUILD_FRAMEWORKS}. */
const deprecatedBuildArms = [
    nodeFrameworkBuildSchema("node"),
    nodeFrameworkBuildSchema("next"),
    nodeFrameworkBuildSchema("vite"),
    z.object({
        framework: z.literal("bun"),
        install_command: z.string().min(1).optional(),
        build_command: z.string().min(1).optional(),
        run_command: z.string().min(1).optional(),
        build_context: buildContextSchema,
    }),
] as const;

const authoredBuildArms = [
    z.object({
        framework: z.literal("dockerfile"),
        dockerfile: z.string().min(1, "dockerfile path is required"),
        target: z.string().min(1).optional(),
        build_context: buildContextSchema,
    }),
    z.object({
        framework: z.literal("runtime"),
        runtime: z.enum(PREVIEWKIT_RUNTIME_IDS),
        // Image tag version, e.g. "22" for node. Optional - defaults to the
        // catalog's default per runtime. The user picks it so a repo pinned to an
        // older toolchain is not forced onto our default (which would defeat the
        // escape hatch). Constrained to a safe tag charset so it can never break
        // out of the generated `FROM` line.
        version: imageTagSchema.optional(),
        // Both are raw bash. `build_script` bakes into the image (cached); the
        // entrypoint is the container start command. `build_script` is optional
        // (some apps need no build step); `entrypoint` is required - the
        // container has to start somehow. `app.command` still overrides it at
        // deploy time.
        build_script: heredocSafeScript("build script").optional(),
        entrypoint: singleLineCommand("entrypoint"),
        build_context: buildContextSchema,
    }),
] as const;

/**
 * The build contract for every AUTHORING surface (the dashboard config editor and
 * the onboarding/debug MCP `apply_config` tools). Only the two methods an editor
 * can render, so a saved document is always representable in the UI - and the
 * JSON Schema an MCP client reads offers nothing else. A retired framework preset
 * is rejected here with {@link UNSUPPORTED_BUILD_METHOD_MESSAGE}.
 */
export const authoredBuildSchema = z.discriminatedUnion("framework", authoredBuildArms, {
    error: () => UNSUPPORTED_BUILD_METHOD_MESSAGE,
});

/**
 * The build contract for STORED documents: everything {@link authoredBuildSchema}
 * accepts, plus the retired framework presets so pre-retirement documents keep
 * reading and deploying.
 */
const storedBuildSchema = z.discriminatedUnion("framework", [...authoredBuildArms, ...deprecatedBuildArms]);

/**
 * The `blueprint` deploy model: the additive way to deploy an app, an alternative to
 * hand-authoring a `build` block. It is a SEPARATE app property from `build`, and the
 * two are mutually exclusive (see the appSchema superRefine). A blueprint is EITHER:
 * - a preset selection (from the catalog in packages/types previewkit-presets.ts) plus
 *   optional overrides - lowered to an equivalent `runtime` Build and built by the
 *   existing single-stage generator (interim; the uniform-builder migration retargets
 *   it later), or
 * - a bring-your-own `dockerfile` - built as-is with no generation (the blueprint
 *   counterpart of build.framework "dockerfile").
 * Both routes go through {@link blueprintToBuild}. Each variant is `.strict()` so a
 * config that mixes the two (e.g. `preset` + `dockerfile`) is a clear error rather than
 * a silently-stripped field.
 */
const presetBlueprintSchema = z
    .object({
        preset: z.enum(PREVIEWKIT_PRESET_IDS),
        // Overridable per app; each defaults from the preset (version from the runtime catalog).
        version: imageTagSchema.optional(),
        // These overrides flow into the generated Dockerfile via blueprintToBuild, so they
        // carry the same guards as the `runtime` build arm: install/build concatenate into
        // the build_script heredoc; run_command and output_directory reach the single-line CMD.
        install_command: heredocSafeScript("install_command").optional(),
        build_command: heredocSafeScript("build_command").optional(),
        run_command: singleLineCommand("run_command").optional(),
        // For static presets: the built output directory to serve (defaults to the preset's).
        output_directory: singleLineCommand("output_directory").optional(),
        // Monorepo: `root` builds from the repo root so sibling workspace packages resolve.
        // Works for every preset: commands run in the app directory; node installs at the
        // repo root (workspace linking) and builds through turbo's `--filter` when the repo
        // has turbo. Absent = app context; no default is stamped in.
        build_context: buildContextSchema.removeDefault().optional(),
    })
    .strict()
    .superRefine((blueprint, ctx) => {
        const toolchain = previewkitPresetSpec(blueprint.preset).toolchain;
        // A node preset's version becomes the node image tag (node:<version>-bookworm-slim), so it
        // must be a bare node version - the same nodeVersionRegex the node build arm enforces.
        // imageTagSchema alone would let a value like "20-alpine" through to an un-pullable tag
        // that only fails at image-pull time.
        if (toolchain === "node" && blueprint.version != null && !nodeVersionRegex.test(blueprint.version)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "version must look like 22, 22.5, or 22.5.0 for a node preset",
                path: ["version"],
            });
        }
    });

const dockerfileBlueprintSchema = z
    .object({
        // Path to a committed Dockerfile, built as-is - ALWAYS relative to the app dir,
        // whatever the build context (the pipeline resolves it against the context).
        // `target` selects a stage in a multi-stage build.
        dockerfile: z.string().min(1, "dockerfile path is required"),
        target: z.string().min(1).optional(),
        // Monorepo: `root` builds from the repo root (so a workspace-aware Dockerfile can reach
        // sibling packages); `app` (absent) builds from the app dir.
        build_context: buildContextSchema.removeDefault().optional(),
    })
    .strict();

const blueprintSchema = z.union([presetBlueprintSchema, dockerfileBlueprintSchema]);

type PresetBlueprint = z.infer<typeof presetBlueprintSchema>;
export type Blueprint = z.infer<typeof blueprintSchema>;

/**
 * Facts about the checked-out repo that the pure blueprint lowering cannot read
 * itself - detected by the previewkit pipeline (which has the clone on disk) and
 * passed into {@link blueprintToBuild}, so this module stays filesystem-free.
 */
export interface BlueprintFacts {
    /**
     * Node package manager for the build context - from the `packageManager` field
     * or the lockfile; npm when neither exists. bun is excluded (the node runtime
     * image does not ship it; bun apps use the `build` model's bun framework).
     */
    packageManager: BlueprintNodePm;
    /** Whether the build context has that manager's lockfile (strict installs require one). */
    hasLockfile: boolean;
    /** Repo-relative app path; "." when the app is the build context itself (all app-context builds). */
    appPath: string;
    /** Resolved turbo `--filter=<spec>`; present only for a root build of a turbo repo. */
    turboFilter?: string;
}

// Interim install command per non-node toolchain, prepended to the generated build
// script (node's is derived from the detected package manager). python uses uv,
// ruby bundler.
const BLUEPRINT_TOOLCHAIN_INSTALL: Partial<Record<PreviewkitRuntime, string>> = {
    python: "uv sync",
    ruby: "bundle install",
};

// Preset build/run commands are package-manager script fragments ("run build") built
// for the future uniform-builder model; the interim generator runs raw bash, so a
// node fragment gets the detected CLI as a prefix. Full commands (e.g. "node build")
// pass through.
function materializeNodeCommand(command: string, cli: string): string {
    return command.startsWith("run ") ? `${cli} ${command}` : command;
}

/** The install lines for a node build: PM bootstrap (corepack) plus the lockfile-appropriate install. */
function nodeInstallLines(facts: BlueprintFacts): string[] {
    const tool = PREVIEWKIT_NODE_PM_CATALOG[facts.packageManager];
    const install = facts.hasLockfile ? tool.install : tool.installNoLockfile;
    return tool.bootstrap != null ? [tool.bootstrap, install] : [install];
}

/**
 * Composes the bash build script for a preset blueprint: dependency install plus the
 * build command. The script starts at the build context root and commands run in the
 * app directory, so a root (monorepo) build `cd`s into the app - except that node
 * installs at the repo root (workspace linking) and builds through turbo's `--filter`
 * when the repo has turbo (topological dependency builds). uv/bundler resolve their
 * workspace from a member directory natively, so non-node toolchains just `cd` first.
 */
function blueprintBuildScript(
    blueprint: PresetBlueprint,
    spec: PreviewkitPresetSpec,
    facts: BlueprintFacts,
): string | undefined {
    const needsCd = blueprint.build_context === "root" && facts.appPath !== ".";
    const lines: string[] = [];

    if (spec.toolchain === "node") {
        lines.push(...(blueprint.install_command != null ? [blueprint.install_command] : nodeInstallLines(facts)));
        const rawBuild = blueprint.build_command ?? spec.buildCommand;
        if (rawBuild.length > 0) {
            const tool = PREVIEWKIT_NODE_PM_CATALOG[facts.packageManager];
            if (facts.turboFilter != null && blueprint.build_command == null) {
                lines.push(`${tool.turbo} run build ${facts.turboFilter}`);
            } else {
                if (needsCd) lines.push(`cd ${facts.appPath}`);
                lines.push(materializeNodeCommand(rawBuild, tool.cli));
            }
        }
    } else {
        if (needsCd) lines.push(`cd ${facts.appPath}`);
        const install = blueprint.install_command ?? BLUEPRINT_TOOLCHAIN_INSTALL[spec.toolchain];
        if (install != null) lines.push(install);
        const rawBuild = blueprint.build_command ?? spec.buildCommand;
        if (rawBuild.length > 0) lines.push(rawBuild);
    }
    return lines.length > 0 ? lines.join("\n") : undefined;
}

function blueprintEntrypoint(
    blueprint: PresetBlueprint,
    spec: PreviewkitPresetSpec,
    port: number,
    cli: string,
): string {
    if (blueprint.run_command != null) return blueprint.run_command;
    if (spec.output.mode === "static") {
        const dir = blueprint.output_directory ?? spec.output.dir;
        return `npx --yes serve ${dir} -s -l ${port}`;
    }
    return spec.toolchain === "node" ? materializeNodeCommand(spec.runCommand, cli) : spec.runCommand;
}

/**
 * Lowers a `blueprint` into a `build` the pipeline can build. A bring-your-own
 * `dockerfile` blueprint becomes a `dockerfile` Build (used as-is); a preset blueprint
 * always becomes a `runtime` Build for the existing single-stage generator - one
 * lowering target for app and root (monorepo) contexts alike. The container starts in
 * the app directory (the generator WORKDIRs a root build into `facts.appPath`), so the
 * entrypoint never needs path scoping.
 */
export function blueprintToBuild(
    blueprint: Blueprint,
    port: number,
    facts: BlueprintFacts,
): Extract<Build, { framework: "runtime" | "dockerfile" }> {
    if ("dockerfile" in blueprint) {
        return {
            framework: "dockerfile",
            dockerfile: blueprint.dockerfile,
            target: blueprint.target,
            build_context: blueprint.build_context ?? "app",
        };
    }
    const spec = previewkitPresetSpec(blueprint.preset);
    return {
        framework: "runtime",
        runtime: spec.toolchain,
        version: blueprint.version ?? previewkitPresetDefaultVersion(blueprint.preset),
        build_script: blueprintBuildScript(blueprint, spec, facts),
        entrypoint: blueprintEntrypoint(blueprint, spec, port, PREVIEWKIT_NODE_PM_CATALOG[facts.packageManager].cli),
        build_context: blueprint.build_context ?? "app",
    };
}

/**
 * A runtime environment variable whose value is wired to the topology. Unlike a
 * secret, a connection has no static value: its `value` is a template that
 * references other apps/services via `{{name.property}}` tokens and is resolved
 * at deploy time by the EnvInjector. It is never sensitive and never stored in
 * AWS. The value can combine multiple tokens and literal text, e.g.
 * `mongodb://{{db.host}}:{{db.port}}/preview` or `{{temporal.host}}:{{temporal.port}}` -
 * which a single service/property pair could not express. `build_time` also
 * passes the resolved value as a Docker build arg.
 */
const connectionSchema = z.object({
    key: SecretKeySchema.superRefine((key, ctx) => {
        if (isReservedPreviewkitEnvKey(key)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `${key} is a reserved built-in variable and cannot be set.`,
            });
        }
    }).describe("The env var name to inject into the app at runtime (e.g. DATABASE_URL)."),
    value: z
        .string()
        .min(1, "value is required")
        .describe(
            "Template resolved at deploy time. {{name.property}} tokens reference apps/services in this " +
                "config by name. For a service: {{db.url}} = the full canonical connection string (postgres -> " +
                "postgresql://preview:preview@<host>:<port>/preview; redis -> redis://...; mongodb -> " +
                "mongodb://...), {{db.host}} = in-cluster DNS name, {{db.port}}. For an app: {{api.url}} = its " +
                "public HTTPS URL, {{api.hostname}}. Also available: {{pr}}, {{namespace}}, {{owner}}. Tokens can " +
                "mix with literal text ('postgresql://user:pass@{{db.host}}:5432/mydb'), or be a plain literal " +
                "('production'). Prefer {{db.url}} to wire a database.",
        ),
    build_time: z.boolean().default(false).describe("Also pass the resolved value as a Docker build arg."),
});

/**
 * Builds the preview config schema. Two knobs, both about what the caller is
 * trusted to send:
 * - `build` is the app build contract: {@link authoredBuildSchema} for anything a
 *   client authors (so it can only produce a document an editor renders), or
 *   {@link storedBuildSchema} when reading a document back out of storage.
 * - `allowCustomResources` decides whether per-app/service `resources` overrides
 *   are honored (trusted, platform-authored config) or discarded in favor of the
 *   standard tier (untrusted client input). See {@link buildResourcesSchema}.
 *
 * Every other validation rule is identical across the variants.
 */
function buildPreviewConfigSchema<TBuild extends z.ZodType>(build: TBuild, allowCustomResources: boolean) {
    const appSchema = z
        .object({
            name: z.string().regex(k8sNameRegex, "Must be a valid Kubernetes name"),
            repository: z
                .string()
                .regex(repoFullNameRegex, "Must be an owner/repo full name")
                .describe(
                    "The owner/repo full name of the GitHub repository this app builds from. Mandatory even in " +
                        "single-repo setups. Any value other than the application's own repository makes this app a " +
                        "multirepo dependency: that repo is cloned at the branch the branch_convention (or its " +
                        "repositories[] fallback_branch) resolves to.",
                ),
            path: z.string().default("."),
            build_context: z.string().optional(),
            dockerfile: z.string().optional(),
            build: build.optional(),
            // The preset-based deploy model, mutually exclusive with `build` (enforced
            // by the superRefine below). Lowered to a `runtime` Build by the generator.
            blueprint: blueprintSchema.optional(),
            // The AWS-secret keys to also inject at build time (Docker build args).
            // Runtime secret values live in AWS Secrets Manager, never in this document.
            build_secrets: z.array(z.string()).default([]),
            port: z.number().int().positive(),
            // Non-secret variables wired to the topology, resolved at deploy time.
            // All user-typed values are secrets (AWS), so they never appear here.
            connections: z.array(connectionSchema).default([]),
            command: z.string().optional(),
            health_check: z.string().optional(),
            primary: z.boolean().optional(),
            // This app serves the Environment Factory handler (`/api/autonoma`), so
            // scenario up/down calls go to its preview URL. Independent of `primary`:
            // a full-stack app (Next.js, Rails) is both the browsed frontend and the
            // SDK host, while a split topology mounts the handler on its API service.
            sdk_implemented: z.boolean().optional(),
            resources: buildResourcesSchema("app", allowCustomResources),
            depends_on: z.array(z.string()).optional(),
        })
        .superRefine((app, ctx) => {
            if (app.build != null && app.blueprint != null) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message:
                        "an app cannot set both `build` and `blueprint` - `blueprint` is the preset-based deploy model, `build` is the manual one",
                    path: ["blueprint"],
                });
            }
        });

    const serviceSchema = z.object({
        name: z.string().regex(k8sNameRegex, "Must be a valid Kubernetes name"),
        recipe: z.string(),
        version: z.string().optional(),
        // Recipe-functional knobs (e.g. postgres user/database, or a docker-image
        // service's image/ports/env) live in `options`, validated per-recipe.
        options: z.record(z.string(), z.unknown()).default({}),
        // Guided setup for database-recipe services (schema, seed, migrations),
        // run with the repo checked out. Empty for non-database services.
        setup_tasks: z.array(databaseSetupTaskSchema).default([]),
        resources: buildResourcesSchema("service", allowCustomResources),
        s3: z.boolean().optional(),
        sqs: z.boolean().optional(),
        sns: z.boolean().optional(),
    });

    return z
        .object({
            version: z.literal(PREVIEW_CONFIG_VERSION),
            domain: z.string().optional(),
            registry: z.string().optional(),
            // Per-repository overrides + deploy provenance; the repo set itself
            // is derived from `apps[].repository`. See repositorySettingsSchema.
            repositories: z
                .array(repositorySettingsSchema)
                .default([])
                .describe(
                    "Optional per-repository settings. The topology's repositories are derived from " +
                        "apps[].repository - an entry here only overrides defaults (fallback_branch: which branch " +
                        "to clone when the PR's branch does not exist in that repo; default main).",
                ),
            // Topology-wide: how a dependency repo's branch is derived from the
            // PR's branch. Defaults to same_branch_name behavior when absent.
            branch_convention: branchConventionSchema
                .optional()
                .describe(
                    "How a dependency repo's branch is derived from the PR branch: same_branch_name (default), " +
                        "regex (pattern + replacement rewrite), or manual (always the fallback_branch).",
                ),
            apps: z.array(appSchema).min(1, "At least one app is required"),
            services: z.array(serviceSchema).default([]),
            hooks: hooksSchema,
        })
        .superRefine((cfg, ctx) => {
            const seen = new Map<string, "app" | "service">();
            const check = (name: string, kind: "app" | "service") => {
                const existing = seen.get(name);
                if (existing != null) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message: `Name "${name}" is used by both a ${existing} and an ${kind} - names must be unique across apps and services`,
                    });
                    return;
                }
                seen.set(name, kind);
            };
            for (const app of cfg.apps) check(app.name, "app");
            for (const service of cfg.services) check(service.name, "service");

            // Repository identity is case-insensitive, so case-only variants of
            // the same repo count as duplicates (they would collapse
            // unpredictably in the runner's per-repo maps otherwise).
            const seenRepos = new Set<string>();
            cfg.repositories.forEach((settings, index) => {
                const key = settings.repo.toLowerCase();
                if (seenRepos.has(key)) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        path: ["repositories", index, "repo"],
                        message: `Repository "${settings.repo}" has more than one settings entry`,
                    });
                }
                seenRepos.add(key);
            });
        });
}

/**
 * The untrusted client-config contract (e.g. the dashboard authoring form).
 * Per-app/service `resources` overrides are accepted but ignored here (every
 * container gets the standard tier); untrusted input cannot size its own
 * preview. Accepts a retired framework preset so the dashboard can load, round-trip
 * and re-save a pre-retirement document without rewriting a build it can't render.
 */
export const previewConfigSchema = buildPreviewConfigSchema(storedBuildSchema, false);

/**
 * Variant that honors per-app/service `resources` overrides. Use ONLY for
 * trusted, platform-authored config: the stored DB config document and the
 * deploy-time re-parse of an already-resolved merged config. NEVER parse
 * untrusted client input with this - that path must use {@link previewConfigSchema}.
 */
export const trustedPreviewConfigSchema = buildPreviewConfigSchema(storedBuildSchema, true);

/**
 * The contract for a config an outside caller AUTHORS from scratch - today the
 * onboarding and debug MCP `apply_config` tools, whose JSON Schema is the menu a
 * coding agent picks from. Identical to {@link previewConfigSchema} except that an
 * app's `build` must be one of the two methods the dashboard editor renders, so a
 * saved document can never be one the user cannot open and edit. Retired framework
 * presets neither appear in the generated JSON Schema nor validate.
 */
export const authoringPreviewConfigSchema = buildPreviewConfigSchema(authoredBuildSchema, false);

// Both variants produce the same shape (resources is always the normalized
// `{ cpu, memoryRequest, memoryLimit }`); only the source of the values differs.
export type PreviewConfig = z.infer<typeof previewConfigSchema>;
export type AppConfig = PreviewConfig["apps"][number];
export type Connection = z.infer<typeof connectionSchema>;

/**
 * The minimum an app entry has to expose to answer "which app is the primary /
 * the SDK host?" - so the resolvers below work on a full {@link AppConfig} and on
 * the projections (the API's manifest view) alike.
 */
export interface AppRole {
    name: string;
    primary?: boolean | null;
    sdk_implemented?: boolean | null;
}

/**
 * The app a reviewer opens and the agents browse: the one marked `primary`, else the first declared. That fallback
 * is a GUESS, defensible only when there is nothing to choose between - ask {@link isPrimaryAppAmbiguous} first.
 */
export function resolvePrimaryAppName(apps: readonly AppRole[]): string | undefined {
    const primary = apps.find((app) => app.primary === true) ?? apps[0];
    return primary?.name;
}

/**
 * Whether {@link resolvePrimaryAppName} is about to guess: several apps, none marked `primary`, so declaration
 * order alone decides. A wrong guess points the browsing agents at the wrong application, and whatever they report
 * is filed on the customer's PR and billed. #2062 makes it a config error instead.
 */
export function isPrimaryAppAmbiguous(apps: readonly AppRole[]): boolean {
    return apps.length > 1 && !apps.some((app) => app.primary === true);
}

/**
 * The app that explicitly declares itself the SDK host, or undefined when none
 * does. Callers that must distinguish "the config says so" from "we guessed"
 * (an endpoint persisted from an older deploy is worth overruling only in the
 * first case) ask this; everyone else wants {@link resolveSdkAppName}.
 */
export function declaredSdkAppName(apps: readonly AppRole[]): string | undefined {
    return apps.find((app) => app.sdk_implemented === true)?.name;
}

/**
 * The app that hosts the Environment Factory handler, and therefore the app a
 * scenario up/down is sent to: the one flagged `sdk_implemented`, falling back to
 * the primary app. The fallback is what every pre-flag document relies on, and it
 * is right for a full-stack app; a split topology (front + separate API) must set
 * the flag or the up lands on the frontend, which has no handler.
 */
export function resolveSdkAppName(apps: readonly AppRole[]): string | undefined {
    return declaredSdkAppName(apps) ?? resolvePrimaryAppName(apps);
}

/**
 * Whether {@link resolveSdkAppName} is about to guess: several apps, none marked `sdk_implemented`, so the
 * handler's address comes from the primary app - which may itself have been guessed. A wrong answer sends scenario
 * up/down to an app with no handler. Tracked with the primary-app guess in #2062.
 */
export function isSdkAppAmbiguous(apps: readonly AppRole[]): boolean {
    return apps.length > 1 && !apps.some((app) => app.sdk_implemented === true);
}

/** A `{{target.property}}` connection token parsed into its parts. */
export interface ConnectionToken {
    target: string;
    property: string;
}

// Matches a value that is EXACTLY one `{{target.property}}` reference token.
const CONNECTION_TOKEN_PATTERN = /^\{\{\s*([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+)\s*\}\}$/;

/**
 * Parses a value that is exactly one `{{target.property}}` connection token, or
 * undefined when the value is anything else.
 */
export function parseConnectionToken(value: string): ConnectionToken | undefined {
    const match = CONNECTION_TOKEN_PATTERN.exec(value.trim());
    const target = match?.[1];
    const property = match?.[2];
    if (target == null || property == null) return undefined;
    return { target, property };
}

// Finds every `{{target.property}}` token anywhere in a value (a connection
// value may combine several tokens plus literal text).
const CONNECTION_TOKEN_GLOBAL = /\{\{\s*([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+)\s*\}\}/g;

/** The distinct app/service names a connection value references via `{{name.property}}`. */
export function connectionTargets(value: string): string[] {
    const targets = new Set<string>();
    for (const match of value.matchAll(CONNECTION_TOKEN_GLOBAL)) {
        if (match[1] != null) targets.add(match[1]);
    }
    return [...targets];
}

/** Every `{{target.property}}` token in a connection value, in order (duplicates kept). */
export function connectionTokens(value: string): ConnectionToken[] {
    const tokens: ConnectionToken[] = [];
    for (const match of value.matchAll(CONNECTION_TOKEN_GLOBAL)) {
        if (match[1] != null && match[2] != null) tokens.push({ target: match[1], property: match[2] });
    }
    return tokens;
}

/** Whether a connection value contains at least one `{{name.property}}` token. */
export function hasConnectionToken(value: string): boolean {
    return connectionTargets(value).length > 0;
}

/**
 * An app's build strategy as it can appear in a STORED document - the two
 * authorable methods plus the retired framework presets. Discriminated on
 * `framework`. Deploy-side code must handle every arm; anything that produces a
 * build block should use {@link AuthoredBuild}.
 */
export type Build = z.infer<typeof storedBuildSchema>;
export type BuildFramework = Build["framework"];

/** An app's build strategy as any authoring surface may write it: `dockerfile` or `runtime`. */
export type AuthoredBuild = z.infer<typeof authoredBuildSchema>;

export type ConfigIssueSeverity = "error" | "warning";

export type ConfigIssueCode =
    | "schema"
    | "unknown_depends_on"
    | "self_depends_on"
    | "unknown_hook_app"
    | "empty_hook_app"
    | "empty_hook_command"
    | "no_primary"
    | "multiple_primary"
    | "multiple_sdk_implemented"
    | "duplicate_name"
    | "unknown_connection_target"
    | "duplicate_connection_key"
    | "unreferenced_database_service"
    | "unreferenced_repository"
    | "primary_repository_not_referenced"
    | "primary_repository_unresolved"
    | "repository_not_accessible"
    | "empty_setup_task_command"
    | "unknown_setup_task_app"
    | "unknown_setup_task_repo"
    | "path_not_found"
    | "dockerfile_not_found";

export type HookGroupKey = "pre_deploy" | "post_deploy";

/**
 * A single validation finding on a PreviewKit config document. `path` is a Zod-style
 * path into the document (e.g. `["apps", 0, "depends_on", 1]`) so UIs can map the
 * issue back to the exact form field. `error`-severity issues block save/deploy;
 * `warning`-severity issues are surfaced but never block.
 */
export interface ConfigIssue {
    severity: ConfigIssueSeverity;
    code: ConfigIssueCode;
    path: Array<string | number>;
    message: string;
}

/** Maps Zod parse issues onto {@link ConfigIssue}s so schema and semantic findings share one shape. */
export function zodIssuesToConfigIssues(error: z.ZodError): ConfigIssue[] {
    return error.issues.map((issue) => ({
        severity: "error",
        code: "schema",
        // Zod types path segments as PropertyKey; symbols never occur in JSON documents.
        path: issue.path.filter((segment): segment is string | number => typeof segment !== "symbol"),
        message: issue.message,
    }));
}

/**
 * The distinct repositories the topology builds from - derived from the apps,
 * which are the only config entries with source. `repositories[]` entries and
 * setup-task `repo` references must point into this set. Deduped
 * case-insensitively (repository identity is case-insensitive - see
 * {@link isSameRepository}); the first-seen casing is kept for display.
 */
export function topologyRepositories(config: Pick<PreviewConfig, "apps">): ReadonlySet<string> {
    const byLowercase = new Map<string, string>();
    for (const app of config.apps) {
        const key = app.repository.toLowerCase();
        if (!byLowercase.has(key)) byLowercase.set(key, app.repository);
    }
    return new Set(byLowercase.values());
}

/**
 * Whether two `owner/repo` full names identify the same repository. GitHub
 * treats full names case-insensitively, and webhook payloads / installation
 * listings / user-authored config can disagree on casing.
 */
export function isSameRepository(a: string, b: string): boolean {
    return a.toLowerCase() === b.toLowerCase();
}

/** Case-insensitive membership test against a collection of repo full names. */
export function hasRepository(repos: Iterable<string>, repo: string): boolean {
    for (const candidate of repos) {
        if (isSameRepository(candidate, repo)) return true;
    }
    return false;
}

/**
 * Semantic checks layered on top of `previewConfigSchema` (which already enforces
 * shape, ports, and name uniqueness within one document). Pure - safe to run on
 * both the API and the dashboard. Returns an empty array for a clean config.
 */
export function validatePreviewConfigSemantics(config: PreviewConfig): ConfigIssue[] {
    const issues: ConfigIssue[] = [];
    const names = new Set<string>([
        ...config.apps.map((app) => app.name),
        ...config.services.map((service) => service.name),
    ]);
    const appNames = new Set(config.apps.map((app) => app.name));

    config.apps.forEach((app, appIndex) => {
        (app.depends_on ?? []).forEach((dependency, depIndex) => {
            if (dependency === app.name) {
                issues.push({
                    severity: "error",
                    code: "self_depends_on",
                    path: ["apps", appIndex, "depends_on", depIndex],
                    message: `App "${app.name}" cannot depend on itself`,
                });
                return;
            }
            if (!names.has(dependency)) {
                issues.push({
                    severity: "error",
                    code: "unknown_depends_on",
                    path: ["apps", appIndex, "depends_on", depIndex],
                    message: `"${dependency}" does not match any app or service in this config`,
                });
            }
        });

        const seenConnectionKeys = new Set<string>();
        app.connections.forEach((connection, connectionIndex) => {
            for (const target of connectionTargets(connection.value)) {
                if (!names.has(target)) {
                    issues.push({
                        severity: "error",
                        code: "unknown_connection_target",
                        path: ["apps", appIndex, "connections", connectionIndex, "value"],
                        message: `"{{${target}...}}" does not match any app or service in this config`,
                    });
                }
            }
            if (seenConnectionKeys.has(connection.key)) {
                issues.push({
                    severity: "error",
                    code: "duplicate_connection_key",
                    path: ["apps", appIndex, "connections", connectionIndex, "key"],
                    message: `Connection "${connection.key}" is defined more than once`,
                });
            }
            seenConnectionKeys.add(connection.key);
        });
    });

    const primaryIndexes = config.apps.flatMap((app, index) => (app.primary === true ? [index] : []));
    if (primaryIndexes.length === 0) {
        issues.push({
            severity: "warning",
            code: "no_primary",
            path: ["apps"],
            message: "No app is marked as primary - the first app will be treated as the primary preview URL",
        });
    } else if (primaryIndexes.length > 1) {
        for (const index of primaryIndexes.slice(1)) {
            issues.push({
                severity: "error",
                code: "multiple_primary",
                path: ["apps", index, "primary"],
                message: "Only one app can be marked as primary",
            });
        }
    }

    // No warning for zero: an app without the flag falls back to the primary,
    // which is correct for a full-stack app and for every pre-flag document.
    const sdkIndexes = config.apps.flatMap((app, index) => (app.sdk_implemented === true ? [index] : []));
    for (const index of sdkIndexes.slice(1)) {
        issues.push({
            severity: "error",
            code: "multiple_sdk_implemented",
            path: ["apps", index, "sdk_implemented"],
            message: "Only one app can host the Autonoma SDK endpoint",
        });
    }

    const repoNames = topologyRepositories(config);
    config.services.forEach((service, serviceIndex) => {
        issues.push(...validateSetupTasks(service.setup_tasks, appNames, repoNames, serviceIndex));
    });

    // A `repositories[]` entry for a repo no app builds from is stale: the repo
    // set is derived from the apps, so the entry's overrides never apply. Warn -
    // never block - so removing a repo's last app doesn't dead-end a save.
    config.repositories.forEach((settings, index) => {
        if (hasRepository(repoNames, settings.repo)) return;
        issues.push({
            severity: "warning",
            code: "unreferenced_repository",
            path: ["repositories", index],
            message:
                `Repository "${settings.repo}" has settings but no app builds from it - ` +
                `set \`repository: "${settings.repo}"\` on an app or remove the entry`,
        });
    });

    // A database service no app connection references is almost always a wiring
    // gap: the database provisions and comes up healthy, but the apps have no env
    // pointing at it, so the first runtime query fails ("DATABASE_URL not found")
    // AFTER the deploy reports ready. Warn - never block - since an app could
    // reach the service through a channel this validation can't see.
    const referencedTargets = new Set(
        config.apps.flatMap((app) => app.connections.flatMap((connection) => connectionTargets(connection.value))),
    );
    config.services.forEach((service, serviceIndex) => {
        if (!isPreviewkitDatabaseEngine(service.recipe) || referencedTargets.has(service.name)) return;
        issues.push({
            severity: "warning",
            code: "unreferenced_database_service",
            path: ["services", serviceIndex],
            message:
                `Service "${service.name}" (${service.recipe}) is not referenced by any app connection - ` +
                `your apps have no env pointing at it. Add a connection like ` +
                `{ key: "DATABASE_URL", value: "{{${service.name}.url}}" } to the app that uses it.`,
        });
    });

    issues.push(...validateHookSteps(config.hooks.pre_deploy, appNames, "pre_deploy"));
    issues.push(...validateHookSteps(config.hooks.post_deploy, appNames, "post_deploy"));

    return issues;
}

/**
 * Validates one service's database setup tasks. A task is invalid when it has no
 * command, an `in_build` task names an app that isn't declared, or a
 * `separate_job` task names a repository no app of the topology builds from.
 * Shared by the semantic validator and the dashboard's database editor so client
 * and server apply the same rules.
 */
export function validateSetupTasks(
    tasks: ReadonlyArray<z.infer<typeof databaseSetupTaskSchema>>,
    appNames: ReadonlySet<string>,
    repoNames: ReadonlySet<string>,
    serviceIndex: number,
): ConfigIssue[] {
    const issues: ConfigIssue[] = [];
    tasks.forEach((task, index) => {
        const base = ["services", serviceIndex, "setup_tasks", index];
        if (task.command.trim() === "") {
            issues.push({
                severity: "error",
                code: "empty_setup_task_command",
                path: [...base, "command"],
                message: "Setup task is missing a command",
            });
        }
        if (task.location.type === "in_build" && !appNames.has(task.location.app)) {
            issues.push({
                severity: "error",
                code: "unknown_setup_task_app",
                path: [...base, "location", "app"],
                message: `Setup task references unknown app "${task.location.app}"`,
            });
        }
        if (
            task.location.type === "separate_job" &&
            task.location.repo != null &&
            !hasRepository(repoNames, task.location.repo)
        ) {
            issues.push({
                severity: "error",
                code: "unknown_setup_task_repo",
                path: [...base, "location", "repo"],
                message: `Setup task references unknown repository "${task.location.repo}"`,
            });
        }
    });
    return issues;
}

/**
 * Validates one group of deploy hooks. A hook is invalid when it is missing its
 * target app, names an app that isn't declared in the config, or is missing the
 * command to run. A fully-blank row (no app and no command) is ignored - the
 * authoring UI drops those before save, and they carry no intent. Shared by the
 * semantic validator above and the dashboard's hooks editor so client and server
 * apply the exact same rules.
 */
export function validateHookSteps(
    steps: ReadonlyArray<{ app: string; command: string }>,
    appNames: ReadonlySet<string>,
    group: HookGroupKey,
): ConfigIssue[] {
    const issues: ConfigIssue[] = [];
    steps.forEach((step, index) => {
        const app = step.app.trim();
        const command = step.command.trim();
        if (app === "" && command === "") return;

        if (app === "") {
            issues.push({
                severity: "error",
                code: "empty_hook_app",
                path: ["hooks", group, index, "app"],
                message: "Hook is missing an app",
            });
        } else if (!appNames.has(app)) {
            issues.push({
                severity: "error",
                code: "unknown_hook_app",
                path: ["hooks", group, index, "app"],
                message: `Hook references unknown app "${app}"`,
            });
        }

        if (command === "") {
            issues.push({
                severity: "error",
                code: "empty_hook_command",
                path: ["hooks", group, index, "command"],
                message: "Hook is missing a command",
            });
        }
    });
    return issues;
}

function standardResources(role: PreviewResourceRole): ContainerResources {
    const standard = STANDARD_RESOURCES[role];
    return {
        cpu: standard.cpu,
        memoryRequest: standard.memoryRequest,
        memoryLimit: standard.memoryLimit,
    };
}
export type ServiceConfig<TOptions = Record<string, unknown>> = Omit<PreviewConfig["services"][number], "options"> & {
    options: TOptions;
};
export type DatabaseSetupTask = z.infer<typeof databaseSetupTaskSchema>;
export type DatabaseSetupLocation = z.infer<typeof databaseSetupLocationSchema>;
export type BranchConvention = z.infer<typeof branchConventionSchema>;
export type RepositorySettings = z.infer<typeof repositorySettingsSchema>;
