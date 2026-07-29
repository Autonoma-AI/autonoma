import {
    authoringPreviewConfigSchema,
    previewConfigSchema,
    validatePreviewConfigSemantics,
    zodIssuesToConfigIssues,
} from "@autonoma/types";
import { describe, expect, it } from "vitest";
import {
    documentsFromDraft,
    draftFromConfig,
    draftWithRepos,
    envRow,
    envRowsFromDotenv,
    fieldIssueKey,
    hookFieldErrors,
    mapIssuesToDraft,
    nextDraftId,
    parseDotenv,
    validateDraftClientSide,
    PRIMARY_REPO_KEY,
    type HooksDraft,
} from "./topology-draft";

describe("topology-draft hooks", () => {
    it("round-trips pre- and post-deploy hooks through draft and back", () => {
        const config = previewConfigSchema.parse({
            version: 1,
            apps: [{ name: "api", port: 4000 }],
            hooks: {
                pre_deploy: [{ app: "api", command: "npx prisma migrate deploy" }],
                post_deploy: [{ app: "api", command: "npm run seed" }],
            },
        });

        const draft = draftFromConfig(config, [], "saved");
        expect(draft.hooks.pre_deploy).toHaveLength(1);
        expect(draft.hooks.post_deploy).toHaveLength(1);

        const reparsed = previewConfigSchema.parse(documentsFromDraft(draft).primary.document);
        expect(reparsed.hooks.pre_deploy).toEqual([{ app: "api", command: "npx prisma migrate deploy" }]);
        expect(reparsed.hooks.post_deploy).toEqual([{ app: "api", command: "npm run seed" }]);
    });

    it("drops fully-empty hook rows when compiling", () => {
        const config = previewConfigSchema.parse({
            version: 1,
            apps: [{ name: "api", port: 4000 }],
            hooks: { post_deploy: [{ app: "api", command: "npm run seed" }] },
        });

        const draft = draftFromConfig(config, [], "saved");
        // A blank row the user added but never filled in must not reach the document.
        draft.hooks.post_deploy.push({ id: nextDraftId(), repoKey: PRIMARY_REPO_KEY, app: "", command: "" });

        const reparsed = previewConfigSchema.parse(documentsFromDraft(draft).primary.document);
        expect(reparsed.hooks.post_deploy).toEqual([{ app: "api", command: "npm run seed" }]);
    });

    it("omits the hooks block entirely when there are no hooks", () => {
        const config = previewConfigSchema.parse({ version: 1, apps: [{ name: "api", port: 4000 }] });
        const draft = draftFromConfig(config, [], "saved");
        expect(documentsFromDraft(draft).primary.document).not.toHaveProperty("hooks");
    });

    it("flags a hook that references an unknown app", () => {
        const config = previewConfigSchema.parse({
            version: 1,
            apps: [{ name: "api", port: 4000 }],
            hooks: { post_deploy: [{ app: "web", command: "echo hi" }] },
        });

        const issues = validatePreviewConfigSemantics(config);
        expect(issues.some((issue) => issue.code === "unknown_hook_app")).toBe(true);
    });
});

describe("topology-draft multirepo round-trip", () => {
    const DEP_ALIAS = "be";
    const DEP_REPO = "acme/api";

    /** A primary document that declares one dependency repo and owns nothing else. */
    function primaryDocument() {
        return previewConfigSchema.parse({
            version: 1,
            config: { multirepo: { repos: [{ name: DEP_ALIAS, repo: DEP_REPO, fallback_branch: "main" }] } },
            apps: [{ name: "web", port: 80, primary: true }],
            services: [],
        });
    }

    /**
     * A dependency document that owns its app, the services that app connects to, and
     * a pre-deploy hook: everything the merged deploy topology sees but the primary
     * document cannot express.
     */
    function dependencyDocument() {
        return previewConfigSchema.parse({
            version: 1,
            apps: [
                {
                    name: "api",
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
        return draftFromConfig(
            primaryDocument(),
            [{ name: DEP_ALIAS, repo: DEP_REPO, document: dependencyDocument() }],
            "saved",
        );
    }

    it("loads a dependency repo's services and hooks, tagged with that repo", () => {
        const loaded = draft();

        // Without these the editor shows no services at all for a project whose
        // database lives in the dependency repo, and every {{db.*}} token reads as
        // pointing at something that does not exist.
        expect(loaded.services.map((service) => [service.name, service.repoKey])).toEqual([
            ["db", DEP_ALIAS],
            ["cache", DEP_ALIAS],
        ]);
        expect(loaded.hooks.pre_deploy.map((step) => [step.command, step.repoKey])).toEqual([
            ["bundle exec rails db:schema:load", DEP_ALIAS],
        ]);
    });

    it("writes each service and hook back to the document that declared it", () => {
        const compiled = documentsFromDraft(draft());
        const primary = previewConfigSchema.parse(compiled.primary.document);
        const dependency = previewConfigSchema.parse(compiled.dependencies[0]?.document);

        // The dependency keeps its own topology instead of losing it (which deletes
        // the database the api needs) or having it hoisted onto the primary document
        // (which moves it into the wrong repo).
        expect(dependency.services.map((service) => service.name)).toEqual(["db", "cache"]);
        expect(dependency.hooks.pre_deploy).toEqual([{ app: "api", command: "bundle exec rails db:schema:load" }]);
        expect(dependency.apps.map((app) => app.name)).toEqual(["api"]);
        expect(primary.services).toEqual([]);
        expect(primary.apps.map((app) => app.name)).toEqual(["web"]);
        expect(compiled.primary.document).not.toHaveProperty("hooks");
    });

    it("preserves a service's recipe options through the round-trip", () => {
        const compiled = documentsFromDraft(draft());
        const dependency = previewConfigSchema.parse(compiled.dependencies[0]?.document);

        expect(dependency.services[0]?.options).toMatchObject({ image: "postgis/postgis:16-3.4" });
    });

    it("leaves the merged topology free of blocking issues, so a save is accepted", () => {
        const compiled = documentsFromDraft(draft());
        const primary = previewConfigSchema.parse(compiled.primary.document);
        const dependencies = compiled.dependencies.map((entry) => previewConfigSchema.parse(entry.document));

        // Mirrors how the save validates: semantics run on the concatenation of every
        // document. Dropping the dependency's services made the api's {{db.*}} and
        // {{cache.*}} connections unresolvable and the save failed with a 400.
        const issues = validatePreviewConfigSemantics({
            ...primary,
            apps: [...primary.apps, ...dependencies.flatMap((entry) => entry.apps)],
            services: [...primary.services, ...dependencies.flatMap((entry) => entry.services)],
            hooks: {
                pre_deploy: [...primary.hooks.pre_deploy, ...dependencies.flatMap((entry) => entry.hooks.pre_deploy)],
                post_deploy: [
                    ...primary.hooks.post_deploy,
                    ...dependencies.flatMap((entry) => entry.hooks.post_deploy),
                ],
            },
        });

        expect(issues.filter((issue) => issue.severity === "error")).toEqual([]);
    });

    it("does not flag a reference that crosses into another repo's document", () => {
        // The primary app wires itself to the dependency app's URL, and the dependency
        // app wires itself to services its own document declares. Judging either
        // document alone reads those as dangling and disables Save for the project.
        const withCrossReference = draftFromConfig(
            previewConfigSchema.parse({
                version: 1,
                config: { multirepo: { repos: [{ name: DEP_ALIAS, repo: DEP_REPO, fallback_branch: "main" }] } },
                apps: [
                    {
                        name: "web",
                        port: 80,
                        primary: true,
                        connections: [{ key: "API_URL", value: "{{api.url}}/api" }],
                    },
                ],
                services: [],
            }),
            [{ name: DEP_ALIAS, repo: DEP_REPO, document: dependencyDocument() }],
            "saved",
        );

        const issues = validateDraftClientSide(documentsFromDraft(withCrossReference));

        expect([...issues.fieldErrors]).toEqual([]);
        expect(issues.documentErrors).toEqual([]);
    });

    it("still flags a reference that matches no document", () => {
        const broken = draft();
        const web = broken.apps.find((app) => app.name === "web");
        if (web == null) throw new Error("expected the primary app to be loaded");
        web.env.push(envRow("GHOST_URL", "{{ghost.url}}", false, "new", false));

        const issues = validateDraftClientSide(documentsFromDraft(broken));

        expect([...issues.fieldErrors.values()].flat().join(" ")).toContain("{{ghost...}}");
    });

    it("drops a dependency's services and hooks when its repo is removed", () => {
        const withoutRepo = draftWithRepos(draft(), []);

        expect(withoutRepo.services).toEqual([]);
        expect(withoutRepo.hooks.pre_deploy).toEqual([]);
        expect(withoutRepo.apps.map((app) => app.name)).toEqual(["web"]);
    });

    it("carries a dependency's services and hooks along when its alias is renamed", () => {
        const loaded = draft();
        const repo = loaded.repos[0];
        if (repo == null) throw new Error("expected the dependency repo to be loaded");
        const renamed = draftWithRepos(loaded, [{ ...repo, name: "backend" }]);

        expect(renamed.services.map((service) => service.repoKey)).toEqual(["backend", "backend"]);
        expect(renamed.hooks.pre_deploy.map((step) => step.repoKey)).toEqual(["backend"]);
        // And they still compile into that repo's document under the new alias.
        const compiled = documentsFromDraft(renamed);
        const dependency = previewConfigSchema.parse(compiled.dependencies[0]?.document);
        expect(compiled.dependencies[0]?.alias).toBe("backend");
        expect(dependency.services.map((service) => service.name)).toEqual(["db", "cache"]);
    });

    /**
     * A primary document whose own database runs its setup task out of `repo`, as a
     * separate job. Named `appdb` so it does not collide with the dependency's `db`.
     */
    function primaryWithSetupTaskIn(repo: string) {
        return previewConfigSchema.parse({
            version: 1,
            config: { multirepo: { repos: [{ name: DEP_ALIAS, repo: DEP_REPO, fallback_branch: "main" }] } },
            apps: [{ name: "web", port: 80, primary: true }],
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

    function gateFor(primaryDoc: ReturnType<typeof primaryDocument>) {
        return validateDraftClientSide(
            documentsFromDraft(
                draftFromConfig(
                    primaryDoc,
                    [{ name: DEP_ALIAS, repo: DEP_REPO, document: dependencyDocument() }],
                    "saved",
                ),
            ),
        );
    }

    it("accepts a setup task that runs out of a declared dependency repo", () => {
        // The merged document has to carry `config.multirepo`, or the declared repo reads
        // as unknown and Save is blocked for exactly the projects this PR is meant to fix.
        const issues = gateFor(primaryWithSetupTaskIn(DEP_ALIAS));

        expect(issues.documentErrors).toEqual([]);
        expect([...issues.fieldErrors]).toEqual([]);
    });

    it("still rejects a setup task that names a repo nobody declares", () => {
        const issues = gateFor(primaryWithSetupTaskIn("ghost"));

        expect(issues.documentErrors.join(" ")).toContain('unknown repository "ghost"');
    });

    it("names the repo when one document is left with no apps", () => {
        const emptied = draft();
        emptied.apps = emptied.apps.filter((app) => app.repoKey !== DEP_ALIAS);

        const issues = validateDraftClientSide(documentsFromDraft(emptied));

        // "At least one app is required" alone is baffling when the primary repo
        // visibly has apps; the message has to say which document is empty.
        expect(issues.documentErrors.join(" ")).toContain(DEP_REPO);
        expect(issues.documentErrors.join(" ")).toContain("At least one app is required");
    });
});

describe("topology-draft docker-image options", () => {
    function serviceOptions(options: Record<string, unknown>): unknown {
        const config = previewConfigSchema.parse({
            version: 1,
            apps: [{ name: "api", port: 4000 }],
            services: [{ name: "svc", recipe: "docker-image", options }],
        });
        const draft = draftFromConfig(config, [], "saved");
        const reparsed = previewConfigSchema.parse(documentsFromDraft(draft).primary.document);
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
                version: 1,
                apps: [{ name: "api", port: 4000 }],
                services: [
                    { name: "svc", recipe: "docker-image", options: { image: "x", port_definition: { port: 5432 } } },
                ],
            }),
            [],
            "saved",
        );
        const service = draft.services[0];
        if (service == null) throw new Error("expected a service draft");
        service.readiness = { ...service.readiness, kind: "tcp", port: "" };

        const reparsed = previewConfigSchema.parse(documentsFromDraft(draft).primary.document);
        expect(reparsed.services[0]?.options).toMatchObject({
            readiness: { tcp: { port_definition: { port: 5432 } } },
        });
    });

    it("emits no options block for a catalog recipe", () => {
        const draft = draftFromConfig(
            previewConfigSchema.parse({
                version: 1,
                apps: [{ name: "api", port: 4000 }],
                services: [{ name: "cache", recipe: "redis", version: "7" }],
            }),
            [],
            "saved",
        );
        const compiled = documentsFromDraft(draft).primary.document;
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
            version: 1,
            apps: [{ name: "api", port: 4000 }],
            services: [{ name: "db", recipe: "postgres", options }],
        });
        // An unrelated edit + save must not drop any typed option.
        const draft = draftFromConfig(config, [], "saved");
        const reparsed = previewConfigSchema.parse(documentsFromDraft(draft).primary.document);
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
                { id: 1, repoKey: PRIMARY_REPO_KEY, app: "api", command: "npm run seed" },
                { id: 2, repoKey: PRIMARY_REPO_KEY, app: "", command: "" },
            ],
        });
        expect(hookFieldErrors(draft, ["api"]).size).toBe(0);
    });

    it("keys a missing-command error by hook id and field", () => {
        const draft = hooks({ post_deploy: [{ id: 7, repoKey: PRIMARY_REPO_KEY, app: "api", command: "" }] });
        const errors = hookFieldErrors(draft, ["api"]);
        expect(errors.get("7:command")).toEqual(["Hook is missing a command"]);
        expect(errors.get("7:app")).toBeUndefined();
    });

    it("keys missing-app and unknown-app errors per row across both groups", () => {
        const draft = hooks({
            pre_deploy: [{ id: 3, repoKey: PRIMARY_REPO_KEY, app: "", command: "migrate" }],
            post_deploy: [{ id: 4, repoKey: PRIMARY_REPO_KEY, app: "worker", command: "seed" }],
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

    it("defaults build-time on for framework client-bundle keys", () => {
        const rows = envRowsFromDotenv([], [{ key: "NEXT_PUBLIC_API_URL", value: "https://x" }]);
        expect(rows[0]).toMatchObject({ key: "NEXT_PUBLIC_API_URL", buildTime: true });
    });

    it("updates an existing key in place (same id, keeps its build-time choice)", () => {
        const existing = [envRow("STRIPE_KEY", "old", true, "config", true)];
        const rows = envRowsFromDotenv(existing, [{ key: "STRIPE_KEY", value: "new" }]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: existing[0]!.id, value: "new", sensitive: true, buildTime: true });
    });
});

describe("topology-draft retired build presets", () => {
    function configWithPreset() {
        return previewConfigSchema.parse({
            version: 1,
            apps: [
                {
                    name: "web",
                    port: 3000,
                    build: { framework: "next", package_manager: "pnpm", node_version: "22" },
                },
            ],
        });
    }

    it("loads a stored preset without dropping it, so the current deploy is preserved", () => {
        const draft = draftFromConfig(configWithPreset(), [], "saved");
        // The selector cannot represent a preset, so the app sits in "auto" holding
        // the block verbatim - editing an unrelated field never rewrites the build.
        expect(draft.apps[0]?.buildMode).toBe("auto");
        expect(draft.apps[0]?.buildPassthrough).toMatchObject({ framework: "next" });
        const recompiled = previewConfigSchema.parse(documentsFromDraft(draft).primary.document);
        expect(recompiled.apps[0]?.build).toMatchObject({ framework: "next" });
    });

    it("blocks the save and points the error at the build-method selector", () => {
        const compiled = documentsFromDraft(draftFromConfig(configWithPreset(), [], "saved")).primary;
        const parsed = authoringPreviewConfigSchema.safeParse(compiled.document);
        expect(parsed.success).toBe(false);
        if (parsed.success) return;

        const issues = mapIssuesToDraft(zodIssuesToConfigIssues(parsed.error), compiled.indexToDraftId);
        const draftId = compiled.indexToDraftId.get(0);
        if (draftId == null) throw new Error("expected the first app to map to a draft");
        expect(issues.fieldErrors.get(fieldIssueKey(draftId, "buildMode"))?.[0]).toContain('"runtime"');
    });

    it("saves once the user picks a method", () => {
        const draft = draftFromConfig(configWithPreset(), [], "saved");
        const app = draft.apps[0];
        if (app == null) throw new Error("expected an app");
        const converted = {
            ...draft,
            apps: [{ ...app, buildMode: "runtime" as const, buildPassthrough: undefined, entrypoint: "npm start" }],
        };
        const document = documentsFromDraft(converted).primary.document;
        expect(authoringPreviewConfigSchema.safeParse(document).success).toBe(true);
    });
});
