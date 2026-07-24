import {
    type AuthoredBuild,
    authoringPreviewConfigSchema,
    type PreviewConfig,
    trustedPreviewConfigSchema,
} from "@autonoma/types";
import { z } from "zod";

/**
 * Pure transform for the turbo/railpack retirement: rewrite a stored
 * PreviewKit config document so every app carries an explicit `build` block,
 * moving it off the legacy build path (`monorepo: "turbo"`, a bare `dockerfile`
 * field, or nothing -> railpack autodetect).
 *
 * The migration is deterministic ONLY for the bare-`dockerfile` bucket
 * (`dockerfile` -> `{ framework: "dockerfile", ... }`). The turbo and railpack
 * buckets require a human framework/package-manager choice, so the caller
 * supplies those per app in `decisions`; an app in one of those buckets with no
 * decision is left untouched and reported as unresolved (never guessed).
 *
 * Idempotent: an app that already has a `build` block is skipped, so re-running
 * over a partially-migrated document is safe.
 */

// Legacy build-strategy keys the migration removes once an explicit `build`
// block replaces them. Nothing else in the document is touched.
const LEGACY_BUILD_KEYS = ["monorepo", "dockerfile", "build_context"] as const;

// The build classification of a single app before migration.
type LegacyBucket = "has_build" | "monorepo_turbo" | "bare_dockerfile" | "railpack_autodetect";

// What the migration did to one app.
export type AppMigrationAction = "skip_has_build" | "migrated_dockerfile" | "migrated_decision" | "unresolved";

export interface AppMigration {
    appName: string;
    from: LegacyBucket;
    action: AppMigrationAction;
}

/**
 * The result of migrating one document. `document` is the migrated, re-validated
 * config - present only when the migration produced a schema-valid document with
 * no unresolved apps. When apps remain unresolved (a turbo/railpack app without a
 * decision), `document` is omitted so the caller never writes a half-migrated row.
 */
export interface DocumentMigrationResult {
    changed: boolean;
    migrations: AppMigration[];
    unresolved: string[];
    document?: PreviewConfig;
    validationError?: string;
}

// A per-app decision for the turbo/railpack buckets: the explicit `build` block
// to apply, keyed by the app's `name` within the document. Typed as an
// `AuthoredBuild`, so a decision naming a retired framework preset fails to
// compile rather than writing a config no editor can reopen.
export type BuildDecisions = Map<string, AuthoredBuild>;

const legacyAppSchema = z
    .object({
        name: z.string(),
        dockerfile: z.string().optional(),
        build_context: z.string().optional(),
        monorepo: z.enum(["turbo"]).optional(),
        build: z.unknown().optional(),
    })
    .passthrough();

const migratableDocumentSchema = z
    .object({
        apps: z.array(legacyAppSchema),
    })
    .passthrough();

type LegacyApp = z.infer<typeof legacyAppSchema>;

export function migratePreviewConfigBuild(document: unknown, decisions: BuildDecisions): DocumentMigrationResult {
    const parsed = migratableDocumentSchema.safeParse(document);
    if (!parsed.success) {
        return {
            changed: false,
            migrations: [],
            unresolved: [],
            validationError: `document is not a migratable preview config: ${z.prettifyError(parsed.error)}`,
        };
    }

    const migrations: AppMigration[] = [];
    const unresolved: string[] = [];
    const migratedApps = parsed.data.apps.map((app) => {
        const result = migrateApp(app, decisions.get(app.name));
        migrations.push({ appName: app.name, from: result.from, action: result.action });
        if (result.action === "unresolved") unresolved.push(app.name);
        return result.app;
    });

    const changed = migrations.some((m) => m.action === "migrated_dockerfile" || m.action === "migrated_decision");
    const candidate = { ...parsed.data, apps: migratedApps };

    // Never hand back a document that still has unresolved apps or that no longer
    // validates - the caller must not write either.
    if (unresolved.length > 0) {
        return { changed, migrations, unresolved };
    }

    // Validity gate: this writes stored config, so it holds to the same bar as the
    // dashboard editor - the migrated document must be one an editor can reopen,
    // which rules out a retired framework preset. The document we return is
    // produced by the trusted schema so platform-authored `resources` overrides
    // survive the round-trip instead of being reset to the standard tier.
    const validation = authoringPreviewConfigSchema.safeParse(candidate);
    if (!validation.success) {
        return {
            changed,
            migrations,
            unresolved,
            validationError: z.prettifyError(validation.error),
        };
    }

    return { changed, migrations, unresolved, document: trustedPreviewConfigSchema.parse(candidate) };
}

function migrateApp(
    app: LegacyApp,
    decision: AuthoredBuild | undefined,
): { app: LegacyApp; from: LegacyBucket; action: AppMigrationAction } {
    const bucket = classifyApp(app);

    if (bucket === "has_build") {
        return { app, from: bucket, action: "skip_has_build" };
    }

    if (bucket === "bare_dockerfile" && app.dockerfile != null) {
        const build: AuthoredBuild = {
            framework: "dockerfile",
            dockerfile: app.dockerfile,
            build_context: mapDockerfileBuildContext(app),
        };
        return { app: applyBuild(app, build), from: bucket, action: "migrated_dockerfile" };
    }

    if (decision != null) {
        return { app: applyBuild(app, decision), from: bucket, action: "migrated_decision" };
    }

    return { app, from: bucket, action: "unresolved" };
}

function classifyApp(app: LegacyApp): LegacyBucket {
    if (app.build != null) return "has_build";
    if (app.monorepo === "turbo") return "monorepo_turbo";
    if (app.dockerfile != null) return "bare_dockerfile";
    return "railpack_autodetect";
}

/**
 * Maps a bare-dockerfile app's build context onto the new enum. The generic
 * `build` block only models `app` vs `root`; a legacy `build_context` that
 * normalizes to the repo root becomes `root`, anything else (including an
 * absent field) stays `app`.
 */
function mapDockerfileBuildContext(app: LegacyApp): "app" | "root" {
    const context = app.build_context;
    if (context == null) return "app";
    const normalized = context.replace(/^\.?\/*/, "").replace(/\/+$/, "");
    return normalized === "" ? "root" : "app";
}

// Returns a copy of the app with the explicit `build` block set and every legacy
// build key dropped.
function applyBuild(app: LegacyApp, build: AuthoredBuild): LegacyApp {
    const next: Record<string, unknown> = { ...app };
    for (const key of LEGACY_BUILD_KEYS) delete next[key];
    next["build"] = build;
    return legacyAppSchema.parse(next);
}
