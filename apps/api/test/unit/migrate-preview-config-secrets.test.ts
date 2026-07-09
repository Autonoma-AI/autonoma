import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
    isAlreadyMigratedShape,
    migrateApp,
    migrateService,
} from "../../src/scripts/migrate-preview-config-secrets.lib";

const connectionsSchema = z.array(z.object({ key: z.string(), value: z.string(), build_time: z.boolean() }));
const stringArray = z.array(z.string());

describe("migrateApp", () => {
    it("splits a homa-next-style app into secrets, connections (incl. composite), and build_secrets", () => {
        const result = migrateApp({
            name: "web-app",
            port: 3000,
            replicas: 2,
            build_secrets: ["CLERK_SECRET_KEY"],
            env: {
                // literals -> secrets
                MONGO_PASSWORD: "s3cret",
                NODE_ENV: "production",
                // single-token connection
                API_URL: "{{api.url}}",
                // composite connections (multiple tokens + literal text)
                MONGO_URI: "mongodb://{{db.host}}:{{db.port}}/preview?replicaSet=rs0",
                TEMPORAL_ADDRESS: "{{temporal.host}}:{{temporal.port}}",
            },
            build_args: {
                // literal build arg -> secret + build_secret
                NEXT_PUBLIC_ENV: "preview",
                // token build arg -> build-time connection
                NEXT_PUBLIC_API_URL: "{{api.url}}",
            },
        });

        // env/build_args/replicas are stripped from the document.
        expect(result.app.env).toBeUndefined();
        expect(result.app.build_args).toBeUndefined();
        expect(result.app.replicas).toBeUndefined();

        const connections = connectionsSchema.parse(result.app.connections);
        const byKey = new Map(connections.map((c) => [c.key, c]));
        // Composite templates survive verbatim as connections - the core fix.
        expect(byKey.get("MONGO_URI")).toEqual({
            key: "MONGO_URI",
            value: "mongodb://{{db.host}}:{{db.port}}/preview?replicaSet=rs0",
            build_time: false,
        });
        expect(byKey.get("TEMPORAL_ADDRESS")?.value).toBe("{{temporal.host}}:{{temporal.port}}");
        expect(byKey.get("API_URL")?.value).toBe("{{api.url}}");
        // A token build arg becomes a build-time connection.
        expect(byKey.get("NEXT_PUBLIC_API_URL")).toEqual({
            key: "NEXT_PUBLIC_API_URL",
            value: "{{api.url}}",
            build_time: true,
        });

        // Literals go to the AWS secret bundle; connections never do.
        expect(result.secrets).toEqual({
            MONGO_PASSWORD: "s3cret",
            NODE_ENV: "production",
            NEXT_PUBLIC_ENV: "preview",
        });

        // build_secrets = existing + literal build-arg keys, and never a connection key.
        expect(new Set(stringArray.parse(result.app.build_secrets))).toEqual(
            new Set(["CLERK_SECRET_KEY", "NEXT_PUBLIC_ENV"]),
        );
    });

    it("skips reserved built-in keys", () => {
        const result = migrateApp({ name: "web", port: 3000, env: { AUTONOMA_PREVIEWKIT: "true", FOO: "bar" } });
        expect(result.secrets).toEqual({ FOO: "bar" });
        expect(result.app.connections).toEqual([]);
    });
});

describe("migrateService", () => {
    it("moves postgres user/database into typed options and drops env", () => {
        const result = migrateService({
            name: "db",
            recipe: "postgres",
            env: { POSTGRES_USER: "app", POSTGRES_DB: "appdb", PGOPTIONS: "-c x=1" },
        });
        expect(result.env).toBeUndefined();
        expect(result.options).toEqual({ user: "app", database: "appdb" });
    });

    it("drops env for non-postgres services", () => {
        const result = migrateService({ name: "cache", recipe: "upstash", env: { LOG_LEVEL: "debug" } });
        expect(result.env).toBeUndefined();
        expect(result.options).toBeUndefined();
    });
});

describe("isAlreadyMigratedShape", () => {
    it("returns true for an onboarded new-model doc (connections, no env/build_args) so it is skipped", () => {
        const document = {
            apps: [{ name: "web", connections: [{ key: "DATABASE_URL", value: "{{db.url}}", build_time: false }] }],
            services: [{ name: "db", recipe: "postgres", options: { user: "app" } }],
        };
        expect(isAlreadyMigratedShape(document)).toBe(true);
    });

    it("returns false when any app still has env or build_args", () => {
        expect(isAlreadyMigratedShape({ apps: [{ name: "web", env: { PORT: "3000" } }], services: [] })).toBe(false);
        expect(
            isAlreadyMigratedShape({
                apps: [{ name: "web", build_args: { RAILPACK_APP_DIR: "apps/web" } }],
                services: [],
            }),
        ).toBe(false);
    });

    it("returns false when a service still carries the old env block", () => {
        expect(
            isAlreadyMigratedShape({ apps: [{ name: "web" }], services: [{ name: "db", env: { PGDATA: "/data" } }] }),
        ).toBe(false);
    });
});
