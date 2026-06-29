import { previewConfigSchema, validatePreviewConfigSemantics } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import { documentsFromDraft, draftFromConfig, hookFieldErrors, nextDraftId, type HooksDraft } from "./topology-draft";

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
        draft.hooks.post_deploy.push({ id: nextDraftId(), app: "", command: "" });

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
