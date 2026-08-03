import {
    authoringPreviewConfigSchema,
    previewConfigSchema,
    validatePreviewConfigSemantics,
    zodIssuesToConfigIssues,
} from "@autonoma/types";
import { describe, expect, it } from "vitest";
import {
    NEW_VARIABLE_BUILD_TIME,
    dedupeSecretRows,
    diffAppSecrets,
    documentFromDraft,
    draftFromConfig,
    draftWithRepos,
    envRow,
    envRowsFromDotenv,
    fieldIssueKey,
    fieldIssueSummaries,
    hookFieldErrors,
    mapIssuesToDraft,
    nextDraftId,
    parseDotenv,
    validateDraftClientSide,
    withSecretRows,
    type HooksDraft,
    type TopologyRepoInput,
} from "./topology-draft";

const PRIMARY_REPO = "acme/web";
const PRIMARY_REPOS: TopologyRepoInput[] = [{ repo: PRIMARY_REPO, primary: true }];

describe("topology-draft hooks", () => {
    it("round-trips pre- and post-deploy hooks through draft and back", () => {
        const config = previewConfigSchema.parse({
            version: 2,
            apps: [{ name: "api", repository: PRIMARY_REPO, port: 4000 }],
            hooks: {
                pre_deploy: [{ app: "api", command: "npx prisma migrate deploy" }],
                post_deploy: [{ app: "api", command: "npm run seed" }],
            },
        });

        const draft = draftFromConfig(config, PRIMARY_REPOS, "saved");
        expect(draft.hooks.pre_deploy).toHaveLength(1);
        expect(draft.hooks.post_deploy).toHaveLength(1);

        const reparsed = previewConfigSchema.parse(documentFromDraft(draft).document);
        expect(reparsed.hooks.pre_deploy).toEqual([{ app: "api", command: "npx prisma migrate deploy" }]);
        expect(reparsed.hooks.post_deploy).toEqual([{ app: "api", command: "npm run seed" }]);
    });

    it("drops fully-empty hook rows when compiling", () => {
        const config = previewConfigSchema.parse({
            version: 2,
            apps: [{ name: "api", repository: PRIMARY_REPO, port: 4000 }],
            hooks: { post_deploy: [{ app: "api", command: "npm run seed" }] },
        });

        const draft = draftFromConfig(config, PRIMARY_REPOS, "saved");
        // A blank row the user added but never filled in must not reach the document.
        draft.hooks.post_deploy.push({ id: nextDraftId(), app: "", command: "" });

        const reparsed = previewConfigSchema.parse(documentFromDraft(draft).document);
        expect(reparsed.hooks.post_deploy).toEqual([{ app: "api", command: "npm run seed" }]);
    });

    it("omits the hooks block entirely when there are no hooks", () => {
        const config = previewConfigSchema.parse({
            version: 2,
            apps: [{ name: "api", repository: PRIMARY_REPO, port: 4000 }],
        });
        const draft = draftFromConfig(config, PRIMARY_REPOS, "saved");
        expect(documentFromDraft(draft).document).not.toHaveProperty("hooks");
    });

    it("flags a hook that references an unknown app", () => {
        const config = previewConfigSchema.parse({
            version: 2,
            apps: [{ name: "api", repository: PRIMARY_REPO, port: 4000 }],
            hooks: { post_deploy: [{ app: "web", command: "echo hi" }] },
        });

        const issues = validatePreviewConfigSemantics(config);
        expect(issues.some((issue) => issue.code === "unknown_hook_app")).toBe(true);
    });
});

describe("topology-draft multirepo round-trip", () => {
    const DEP_REPO = "acme/api";
    const TOPOLOGY_REPOS: TopologyRepoInput[] = [
        { repo: PRIMARY_REPO, primary: true, githubRepositoryId: 101 },
        { repo: DEP_REPO, primary: false, githubRepositoryId: 202 },
    ];

    /** One document spanning two repos: the dependency app owns the services it connects to. */
    function multirepoDocument() {
        return previewConfigSchema.parse({
            version: 2,
            repositories: [{ repo: DEP_REPO, fallback_branch: "develop" }],
            apps: [
                { name: "web", repository: PRIMARY_REPO, port: 80, primary: true },
                {
                    name: "api",
                    repository: DEP_REPO,
                    port: 3000,
                    connections: [
                        { key: "DATABASE_URL", value: "postgres://{{db.host}}:{{db.port}}/preview" },
                        { key: "REDIS_URL", value: "redis://{{cache.host}}:6379" },
                    ],
                },
            ],
            services: [
                { name: "db", recipe: "postgres", options: { image: "postgis/postgis:16-3.4" } },
                { name: "cache", recipe: "redis" },
            ],
            hooks: { pre_deploy: [{ app: "api", command: "bundle exec rails db:schema:load" }] },
        });
    }

    function draft() {
        return draftFromConfig(multirepoDocument(), TOPOLOGY_REPOS, "saved");
    }

    it("loads the topology: primary repo, dependency repo card, apps tagged by repository", () => {
        const loaded = draft();

        expect(loaded.primaryRepository).toBe(PRIMARY_REPO);
        expect(loaded.repos.map((repo) => [repo.repo, repo.fallbackBranch, repo.githubRepositoryId])).toEqual([
            [DEP_REPO, "develop", 202],
        ]);
        expect(loaded.apps.map((app) => [app.name, app.repository])).toEqual([
            ["web", PRIMARY_REPO],
            ["api", DEP_REPO],
        ]);
        expect(loaded.services.map((service) => service.name)).toEqual(["db", "cache"]);
        expect(loaded.hooks.pre_deploy.map((step) => step.command)).toEqual(["bundle exec rails db:schema:load"]);
    });

    it("round-trips the whole topology through one document", () => {
        const compiled = documentFromDraft(draft());
        const reparsed = previewConfigSchema.parse(compiled.document);

        expect(reparsed.apps.map((app) => [app.name, app.repository])).toEqual([
            ["web", PRIMARY_REPO],
            ["api", DEP_REPO],
        ]);
        expect(reparsed.repositories).toEqual([{ repo: DEP_REPO, fallback_branch: "develop" }]);
        expect(reparsed.services.map((service) => service.name)).toEqual(["db", "cache"]);
        expect(reparsed.hooks.pre_deploy).toEqual([{ app: "api", command: "bundle exec rails db:schema:load" }]);
        expect(reparsed.services[0]?.options).toMatchObject({ image: "postgis/postgis:16-3.4" });
    });

    it("leaves the topology free of blocking issues, so a save is accepted", () => {
        const issues = validateDraftClientSide(documentFromDraft(draft()));

        expect([...issues.fieldErrors]).toEqual([]);
        expect(issues.documentErrors).toEqual([]);
    });

    it("still flags a reference that matches nothing in the topology", () => {
        const broken = draft();
        const web = broken.apps.find((app) => app.name === "web");
        if (web == null) throw new Error("expected the primary app to be loaded");
        web.env.push(envRow("GHOST_URL", "{{ghost.url}}", false, "new", false));

        const issues = validateDraftClientSide(documentFromDraft(broken));

        expect([...issues.fieldErrors.values()].flat().join(" ")).toContain("{{ghost...}}");
    });

    it("drops a dependency repo's apps when the repo is removed; shared services stay", () => {
        const withoutRepo = draftWithRepos(draft(), []);

        expect(withoutRepo.apps.map((app) => app.name)).toEqual(["web"]);
        // Services and hooks live on the single document, not on a repo.
        expect(withoutRepo.services.map((service) => service.name)).toEqual(["db", "cache"]);
    });

    it("rewrites apps' repository when a repo's full name is edited", () => {
        const loaded = draft();
        const repo = loaded.repos[0];
        if (repo == null) throw new Error("expected the dependency repo to be loaded");
        const renamed = draftWithRepos(loaded, [{ ...repo, repo: "acme/backend" }]);

        expect(renamed.apps.map((app) => app.repository)).toEqual([PRIMARY_REPO, "acme/backend"]);
        const reparsed = previewConfigSchema.parse(documentFromDraft(renamed).document);
        expect(reparsed.repositories).toEqual([{ repo: "acme/backend", fallback_branch: "develop" }]);
    });

    it("keeps a settings-only repo (no app yet) editable instead of dropping it on load", () => {
        const document = previewConfigSchema.parse({
            version: 2,
            repositories: [{ repo: "acme/orphan", fallback_branch: "staging" }],
            apps: [{ name: "web", repository: PRIMARY_REPO, port: 80, primary: true }],
        });
        const loaded = draftFromConfig(document, PRIMARY_REPOS, "saved");
        expect(loaded.repos.map((repo) => [repo.repo, repo.fallbackBranch])).toEqual([["acme/orphan", "staging"]]);
    });

    /** A database whose setup task runs as a separate job out of `repo`. */
    function documentWithSetupTaskIn(repo: string) {
        return previewConfigSchema.parse({
            version: 2,
            repositories: [{ repo: DEP_REPO, fallback_branch: "main" }],
            apps: [
                { name: "web", repository: PRIMARY_REPO, port: 80, primary: true },
                { name: "api", repository: DEP_REPO, port: 3000 },
            ],
            services: [
                {
                    name: "appdb",
                    recipe: "postgres",
                    setup_tasks: [
                        {
                            frequency: "on_create",
                            command: "rails db:schema:load",
                            location: { type: "separate_job", repo },
                        },
                    ],
                },
            ],
        });
    }

    it("accepts a setup task that runs out of a repository an app builds from", () => {
        const issues = validateDraftClientSide(
            documentFromDraft(draftFromConfig(documentWithSetupTaskIn(DEP_REPO), TOPOLOGY_REPOS, "saved")),
        );

        expect(issues.documentErrors).toEqual([]);
        expect([...issues.fieldErrors]).toEqual([]);
    });

    it("still rejects a setup task that names a repo no app builds from", () => {
        const issues = validateDraftClientSide(
            documentFromDraft(draftFromConfig(documentWithSetupTaskIn("acme/ghost"), TOPOLOGY_REPOS, "saved")),
        );

        expect(issues.documentErrors.join(" ")).toContain('unknown repository "acme/ghost"');
    });
});

describe("topology-draft docker-image options", () => {
    function serviceOptions(options: Record<string, unknown>): unknown {
        const config = previewConfigSchema.parse({
            version: 2,
            apps: [{ name: "api", repository: PRIMARY_REPO, port: 4000 }],
            services: [{ name: "svc", recipe: "docker-image", options }],
        });
        const draft = draftFromConfig(config, PRIMARY_REPOS, "saved");
        const reparsed = previewConfigSchema.parse(documentFromDraft(draft).document);
        return reparsed.services[0]?.options;
    }

    it("round-trips the full custom-image option set", () => {
        const options = {
            image: "mailhog/mailhog:latest",
            port_definition: { name: "smtp", port: 1025 },
            additional_ports: [{ name: "web", port: 8025 }],
            command: ["MailHog"],
            args: ["-storage", "memory"],
            readiness: {
                http: { path: "/", port_definition: { port: 8025 } },
                initial_delay_seconds: 3,
                period_seconds: 5,
            },
        };
        expect(serviceOptions(options)).toEqual(options);
    });

    it("round-trips an exec readiness probe", () => {
        const options = {
            image: "redis:7",
            port_definition: { port: 6379 },
            readiness: { exec: { command: ["redis-cli", "ping"] } },
        };
        expect(serviceOptions(options)).toEqual(options);
    });

    it("falls back to the primary port for a tcp probe with no explicit port", () => {
        const draft = draftFromConfig(
            previewConfigSchema.parse({
                version: 2,
                apps: [{ name: "api", repository: PRIMARY_REPO, port: 4000 }],
                services: [
                    { name: "svc", recipe: "docker-image", options: { image: "x", port_definition: { port: 5432 } } },
                ],
            }),
            PRIMARY_REPOS,
            "saved",
        );
        const service = draft.services[0];
        if (service == null) throw new Error("expected a service draft");
        service.readiness = { ...service.readiness, kind: "tcp", port: "" };

        const reparsed = previewConfigSchema.parse(documentFromDraft(draft).document);
        expect(reparsed.services[0]?.options).toMatchObject({
            readiness: { tcp: { port_definition: { port: 5432 } } },
        });
    });

    it("emits no options block for a catalog recipe", () => {
        const draft = draftFromConfig(
            previewConfigSchema.parse({
                version: 2,
                apps: [{ name: "api", repository: PRIMARY_REPO, port: 4000 }],
                services: [{ name: "cache", recipe: "redis", version: "7" }],
            }),
            PRIMARY_REPOS,
            "saved",
        );
        const compiled = documentFromDraft(draft).document;
        const services = compiled.services;
        if (!Array.isArray(services)) throw new Error("expected services array");
        expect(services[0]).not.toHaveProperty("options");
    });

    it("round-trips postgres typed options the form does not model", () => {
        const options = {
            user: "app_role",
            database: "app_db",
            databases: ["reporting"],
            extensions: ["uuid-ossp", "pg_trgm"],
            ssl: true,
            storage: "5Gi",
            restore_from: { environment: "production", service: "db" },
        };
        const config = previewConfigSchema.parse({
            version: 2,
            apps: [{ name: "api", repository: PRIMARY_REPO, port: 4000 }],
            services: [{ name: "db", recipe: "postgres", options }],
        });
        // An unrelated edit + save must not drop any typed option.
        const draft = draftFromConfig(config, PRIMARY_REPOS, "saved");
        const reparsed = previewConfigSchema.parse(documentFromDraft(draft).document);
        const service = reparsed.services.find((candidate) => candidate.name === "db");
        expect(service?.options).toEqual(options);
    });
});

describe("hookFieldErrors", () => {
    function hooks(partial: Partial<HooksDraft>): HooksDraft {
        return { pre_deploy: [], post_deploy: [], ...partial };
    }

    it("returns no errors for valid and fully-blank rows", () => {
        const draft = hooks({
            post_deploy: [
                { id: 1, app: "api", command: "npm run seed" },
                { id: 2, app: "", command: "" },
            ],
        });
        expect(hookFieldErrors(draft, ["api"]).size).toBe(0);
    });

    it("keys a missing-command error by hook id and field", () => {
        const draft = hooks({ post_deploy: [{ id: 7, app: "api", command: "" }] });
        const errors = hookFieldErrors(draft, ["api"]);
        expect(errors.get("7:command")).toEqual(["Hook is missing a command"]);
        expect(errors.get("7:app")).toBeUndefined();
    });

    it("keys missing-app and unknown-app errors per row across both groups", () => {
        const draft = hooks({
            pre_deploy: [{ id: 3, app: "", command: "migrate" }],
            post_deploy: [{ id: 4, app: "worker", command: "seed" }],
        });
        const errors = hookFieldErrors(draft, ["api"]);
        expect(errors.get("3:app")).toEqual(["Hook is missing an app"]);
        expect(errors.get("4:app")).toEqual(['Hook references unknown app "worker"']);
    });
});

describe("parseDotenv", () => {
    it("parses KEY=VALUE, skips comments/blanks, strips quotes and the export prefix", () => {
        const entries = parseDotenv(
            [
                "# a comment",
                "",
                "DATABASE_URL=postgres://x",
                'export API_URL="https://api.test"',
                "TOKEN='sk_live_1'",
                "not a valid line",
                "123BAD=nope",
            ].join("\n"),
        );
        expect(entries).toEqual([
            { key: "DATABASE_URL", value: "postgres://x" },
            { key: "API_URL", value: "https://api.test" },
            { key: "TOKEN", value: "sk_live_1" },
        ]);
    });

    it("takes the value verbatim (a `#` inside a value is not a comment)", () => {
        expect(parseDotenv("PASSWORD=p@ss#word=1")).toEqual([{ key: "PASSWORD", value: "p@ss#word=1" }]);
    });

    it("keeps a multi-line quoted value (PEM key) intact and resumes parsing after it", () => {
        const input = [
            'PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----',
            "MIIEpAABC",
            "DEF/1+2=",
            '-----END RSA PRIVATE KEY-----"',
            "NEXT=after",
        ].join("\n");
        expect(parseDotenv(input)).toEqual([
            {
                key: "PRIVATE_KEY",
                value: "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAABC\nDEF/1+2=\n-----END RSA PRIVATE KEY-----",
            },
            { key: "NEXT", value: "after" },
        ]);
    });
});

describe("envRowsFromDotenv", () => {
    it("classifies a token value as a connection and a literal as a secret", () => {
        const rows = envRowsFromDotenv(
            [],
            [
                { key: "STRIPE_KEY", value: "sk_live_1" },
                { key: "MONGO_URI", value: "mongodb://{{db.host}}:{{db.port}}/preview" },
            ],
        );
        const byKey = new Map(rows.map((row) => [row.key, row]));
        expect(byKey.get("STRIPE_KEY")).toMatchObject({ value: "sk_live_1", sensitive: true });
        expect(byKey.get("MONGO_URI")).toMatchObject({
            value: "mongodb://{{db.host}}:{{db.port}}/preview",
            sensitive: false,
        });
    });

    it("defaults build-time on for an imported key, whatever it is called", () => {
        const rows = envRowsFromDotenv(
            [],
            [
                { key: "NEXT_PUBLIC_API_URL", value: "https://x" },
                { key: "STRIPE_KEY", value: "sk_live_1" },
            ],
        );
        expect(rows.map((row) => row.buildTime)).toEqual([NEW_VARIABLE_BUILD_TIME, NEW_VARIABLE_BUILD_TIME]);
    });

    it("updates an existing key in place (same id, keeps its build-time choice)", () => {
        // The import must not re-apply the default over a choice already made -
        // an off toggle is the only way to keep a value out of the image.
        const existing = [envRow("STRIPE_KEY", "old", true, "config", false)];
        const rows = envRowsFromDotenv(existing, [{ key: "STRIPE_KEY", value: "new" }]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: existing[0]!.id, value: "new", sensitive: true, buildTime: false });
    });
});

describe("dedupeSecretRows", () => {
    it("keeps the row being typed when the stored-secret merge already added that key", () => {
        // The variable list is editable before the stored key list arrives, so the merge
        // can land on a half-typed key it cannot match - and appends its own masked
        // row for the same stored secret.
        const typed = envRow("STRIPE_SECRET_K", "sk_live_new", true, "new", false);
        const merged = withSecretRows([typed], ["STRIPE_SECRET_KEY"]);
        expect(merged).toHaveLength(2);

        // The user finishes the key: both rows now hold STRIPE_SECRET_KEY.
        const edited = merged.map((row) => (row.id === typed.id ? { ...row, key: "STRIPE_SECRET_KEY" } : row));
        const rows = dedupeSecretRows(edited, typed.id);

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: typed.id, key: "STRIPE_SECRET_KEY", value: "sk_live_new" });
        // The surviving row still represents the stored secret, so the save overwrites
        // it instead of deleting it.
        expect(diffAppSecrets(rows, ["STRIPE_SECRET_KEY"])).toEqual({
            upserts: [{ key: "STRIPE_SECRET_KEY", value: "sk_live_new" }],
            deletes: [],
        });
    });

    it("keeps the edited row when the masked stored row sorts first", () => {
        const stored = envRow("STRIPE_SECRET_KEY", "", true, "secret", false);
        const typed = envRow("STRIPE_SECRET_KEY", "sk_live_new", true, "new", false);
        expect(dedupeSecretRows([stored, typed], typed.id).map((row) => row.id)).toEqual([typed.id]);
    });

    it("leaves a collision with a row holding a typed value for validation to report", () => {
        // Renaming a variable onto an occupied key must not silently delete the row -
        // and the value - it collided with; the drawer reports the duplicate instead.
        const occupied = envRow("DATABASE_URL", "postgres://x", true, "config", false);
        const renamed = envRow("DATABASE_URL", "postgres://y", true, "new", false);
        expect(dedupeSecretRows([occupied, renamed], renamed.id)).toHaveLength(2);
    });

    it("leaves blank-key rows alone", () => {
        const rows = [envRow("", "", true, "new", false), envRow("", "", true, "new", false)];
        expect(dedupeSecretRows(rows)).toHaveLength(2);
    });
});

describe("topology-draft retired build presets", () => {
    function configWithPreset() {
        return previewConfigSchema.parse({
            version: 2,
            apps: [
                {
                    name: "web",
                    repository: PRIMARY_REPO,
                    port: 3000,
                    build: { framework: "next", package_manager: "pnpm", node_version: "22" },
                },
            ],
        });
    }

    it("loads a stored preset without dropping it, so the current deploy is preserved", () => {
        const draft = draftFromConfig(configWithPreset(), PRIMARY_REPOS, "saved");
        // The selector cannot represent a preset, so the app sits in "auto" holding
        // the block verbatim - editing an unrelated field never rewrites the build.
        expect(draft.apps[0]?.buildMode).toBe("auto");
        expect(draft.apps[0]?.buildPassthrough).toMatchObject({ framework: "next" });
        const recompiled = previewConfigSchema.parse(documentFromDraft(draft).document);
        expect(recompiled.apps[0]?.build).toMatchObject({ framework: "next" });
    });

    it("blocks the save and points the error at the build-method selector", () => {
        const compiled = documentFromDraft(draftFromConfig(configWithPreset(), PRIMARY_REPOS, "saved"));
        const parsed = authoringPreviewConfigSchema.safeParse(compiled.document);
        expect(parsed.success).toBe(false);
        if (parsed.success) return;

        const issues = mapIssuesToDraft(zodIssuesToConfigIssues(parsed.error), compiled.indexToDraftId);
        const draftId = compiled.indexToDraftId.get(0);
        if (draftId == null) throw new Error("expected the first app to map to a draft");
        expect(issues.fieldErrors.get(fieldIssueKey(draftId, "buildMode"))?.[0]).toContain('"runtime"');
    });

    it("saves once the user picks a method", () => {
        const draft = draftFromConfig(configWithPreset(), PRIMARY_REPOS, "saved");
        const app = draft.apps[0];
        if (app == null) throw new Error("expected an app");
        const converted = {
            ...draft,
            apps: [{ ...app, buildMode: "runtime" as const, buildPassthrough: undefined, entrypoint: "npm start" }],
        };
        const document = documentFromDraft(converted).document;
        expect(authoringPreviewConfigSchema.safeParse(document).success).toBe(true);
    });
});

describe("fieldIssueSummaries", () => {
    it("names the app, field and tab of every blocking field error", () => {
        const draft = draftFromConfig(
            previewConfigSchema.parse({
                version: 2,
                apps: [
                    {
                        name: "web",
                        repository: PRIMARY_REPO,
                        port: 3000,
                        build: { framework: "next", package_manager: "pnpm" },
                    },
                    { name: "api", repository: PRIMARY_REPO, port: 8080, dockerfile: "Dockerfile" },
                ],
            }),
            PRIMARY_REPOS,
            "saved",
        );
        const issues = validateDraftClientSide(documentFromDraft(draft));
        expect(issues.fieldErrors.size).toBeGreaterThan(0);

        const summaries = fieldIssueSummaries(issues.fieldErrors, draft.apps);
        expect(summaries).toHaveLength(issues.fieldErrors.size);
        const buildMethod = summaries.find((summary) => summary.field === "Build method");
        expect(buildMethod?.app).toBe("web");
        expect(buildMethod?.tab).toBe("Overview");
        expect(buildMethod?.message).toContain('"runtime"');
    });

    it("files a variable error under the tab that edits variables", () => {
        const draft = draftFromConfig(
            previewConfigSchema.parse({
                version: 2,
                apps: [{ name: "web", repository: PRIMARY_REPO, port: 3000, dockerfile: "Dockerfile" }],
            }),
            PRIMARY_REPOS,
            "saved",
        );
        const app = draft.apps[0];
        if (app == null) throw new Error("expected an app");
        // A connection to a service that isn't declared - a semantics error filed
        // against `connections`, which no editor renders inline.
        const broken = { ...draft, apps: [{ ...app, env: [envRow("DATABASE_URL", "{{ghost.url}}", false)] }] };
        const issues = validateDraftClientSide(documentFromDraft(broken));

        const summaries = fieldIssueSummaries(issues.fieldErrors, broken.apps);
        expect(summaries[0]?.field).toBe("Variables");
        expect(summaries[0]?.tab).toBe("Variables");
    });
});
