import type { SuggestionServiceRef } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import {
    type AppEnvSignal,
    ensureServiceConnectionVars,
    heuristicEnvVars,
    heuristicServices,
    parseComposeImages,
    parseDotenv,
} from "../../../src/github/previewkit-suggestion.service";

describe("parseDotenv", () => {
    it("parses KEY=VALUE pairs and attaches preceding comments", () => {
        const entries = parseDotenv("# database connection\nDATABASE_URL=postgres://x\n\nPORT=3000");
        expect(entries).toEqual([
            { key: "DATABASE_URL", value: "postgres://x", comment: "database connection" },
            { key: "PORT", value: "3000" },
        ]);
    });

    it("strips surrounding quotes and the export prefix", () => {
        const entries = parseDotenv('export API_URL="http://localhost:3000"');
        expect(entries).toEqual([{ key: "API_URL", value: "http://localhost:3000" }]);
    });

    it("ignores blank lines and malformed keys", () => {
        expect(parseDotenv("\n=novalue\n123BAD=x\nGOOD=y")).toEqual([{ key: "GOOD", value: "y" }]);
    });
});

describe("parseComposeImages", () => {
    it("extracts service image strings", () => {
        const images = parseComposeImages({
            services: { db: { image: "postgres:16" }, cache: { image: "redis:7" }, web: { build: "." } },
        });
        expect(images).toEqual(["postgres:16", "redis:7"]);
    });

    it("returns [] for a doc without services", () => {
        expect(parseComposeImages({ version: "3" })).toEqual([]);
        expect(parseComposeImages("not a compose file")).toEqual([]);
    });
});

describe("heuristicServices", () => {
    it("maps a postgres dependency to a high-confidence postgres suggestion", () => {
        const [service, ...rest] = heuristicServices({ dependencies: ["pg"], composeImages: [], envKeys: [] });
        expect(rest).toHaveLength(0);
        expect(service).toMatchObject({ recipe: "postgres", name: "db", version: "16", confidence: "high" });
        expect(service?.evidence).toContain("dependency: pg");
    });

    it("prefers upstash over redis for @upstash/redis", () => {
        const services = heuristicServices({ dependencies: ["@upstash/redis"], composeImages: [], envKeys: [] });
        expect(services.map((service) => service.recipe)).toEqual(["upstash"]);
    });

    it("dedupes one suggestion per recipe and merges evidence", () => {
        const services = heuristicServices({
            dependencies: ["pg"],
            composeImages: ["postgres:16"],
            envKeys: ["POSTGRES_PASSWORD"],
        });
        expect(services).toHaveLength(1);
        expect(services[0]?.recipe).toBe("postgres");
        expect(services[0]?.evidence.length).toBeGreaterThanOrEqual(2);
    });

    it("treats an env-only signal as medium confidence", () => {
        const services = heuristicServices({ dependencies: [], composeImages: [], envKeys: ["REDIS_URL"] });
        expect(services).toEqual([expect.objectContaining({ recipe: "redis", confidence: "medium" })]);
    });

    it("returns nothing when there are no signals", () => {
        expect(heuristicServices({ dependencies: ["react"], composeImages: [], envKeys: ["NEXT_PUBLIC_URL"] })).toEqual(
            [],
        );
    });
});

describe("heuristicEnvVars", () => {
    const services: SuggestionServiceRef[] = [
        { name: "db", recipe: "postgres" },
        { name: "cache", recipe: "redis" },
    ];

    it("maps a DATABASE_URL to the postgres service url token", () => {
        const apps: AppEnvSignal[] = [
            { name: "web", entries: [{ key: "DATABASE_URL", value: "postgres://x" }], dependencies: [] },
        ];
        const result = heuristicEnvVars(apps, services);
        expect(result.services).toEqual([]);
        expect(result.apps[0]?.vars[0]).toMatchObject({ key: "DATABASE_URL", reference: "{{db.url}}" });
        // A referenced var carries no literal value.
        expect(result.apps[0]?.vars[0]?.value).toBeUndefined();
    });

    it("treats every non-connection value as a write-only secret (no literal value)", () => {
        const apps: AppEnvSignal[] = [
            {
                name: "web",
                entries: [
                    { key: "PORT", value: "3000" },
                    { key: "NODE_ENV", value: "production" },
                    { key: "STRIPE_SECRET_KEY", value: "sk_test_123" },
                ],
                dependencies: [],
            },
        ];
        const vars = heuristicEnvVars(apps, services).apps[0]?.vars ?? [];
        // Plain config (PORT, NODE_ENV) is now a secret, same as a credential - and none carry a value.
        for (const key of ["PORT", "NODE_ENV", "STRIPE_SECRET_KEY"]) {
            const entry = vars.find((v) => v.key === key);
            expect(entry?.sensitive).toBe(true);
            expect(entry?.reference).toBeUndefined();
            expect(entry?.value).toBeUndefined();
        }
    });

    it("flags framework client-bundle vars (NEXT_PUBLIC_*) as build_time", () => {
        const apps: AppEnvSignal[] = [
            { name: "web", entries: [{ key: "NEXT_PUBLIC_API_URL", value: "https://x" }], dependencies: [] },
        ];
        const vars = heuristicEnvVars(apps, services).apps[0]?.vars ?? [];
        const entry = vars.find((v) => v.key === "NEXT_PUBLIC_API_URL");
        expect(entry).toMatchObject({ key: "NEXT_PUBLIC_API_URL", build_time: true, sensitive: true });
    });

    it("composes host:port for a connection to a service with no url token (temporal)", () => {
        const apps: AppEnvSignal[] = [
            { name: "worker", entries: [{ key: "TEMPORAL_ADDRESS", value: "localhost:7233" }], dependencies: [] },
        ];
        const withTemporal: SuggestionServiceRef[] = [{ name: "temporal", recipe: "temporal" }];
        const vars = heuristicEnvVars(apps, withTemporal).apps[0]?.vars ?? [];
        const entry = vars.find((v) => v.key === "TEMPORAL_ADDRESS");
        expect(entry).toMatchObject({
            key: "TEMPORAL_ADDRESS",
            reference: "{{temporal.host}}:{{temporal.port}}",
            sensitive: false,
        });
    });

    it("omits apps with no env entries", () => {
        const apps: AppEnvSignal[] = [{ name: "web", entries: [], dependencies: [] }];
        expect(heuristicEnvVars(apps, services).apps).toEqual([]);
    });
});

describe("ensureServiceConnectionVars", () => {
    const postgres: SuggestionServiceRef = { name: "db", recipe: "postgres" };

    it("wires a connection var onto the primary app when no env group exists yet", () => {
        const apps: AppEnvSignal[] = [
            { name: "web", entries: [], dependencies: [], primary: false },
            { name: "api", entries: [], dependencies: [], primary: true },
        ];
        const result = ensureServiceConnectionVars({ apps: [], services: [] }, apps, [postgres]);

        const apiGroup = result.apps.find((group) => group.name === "api");
        expect(apiGroup?.vars).toEqual([
            expect.objectContaining({ key: "DATABASE_URL", reference: "{{db.url}}", sensitive: false }),
        ]);
        // Non-primary apps are never wired.
        expect(result.apps.find((group) => group.name === "web")).toBeUndefined();
    });

    it("falls back to the first app when none is flagged primary", () => {
        const apps: AppEnvSignal[] = [{ name: "web", entries: [], dependencies: [] }];
        const result = ensureServiceConnectionVars({ apps: [], services: [] }, apps, [postgres]);
        expect(result.apps[0]).toMatchObject({ name: "web" });
        expect(result.apps[0]?.vars[0]).toMatchObject({ key: "DATABASE_URL", reference: "{{db.url}}" });
    });

    it("does not duplicate a connection var the primary app already carries", () => {
        const apps: AppEnvSignal[] = [{ name: "api", entries: [], dependencies: [], primary: true }];
        const existing = {
            apps: [
                {
                    name: "api",
                    vars: [
                        {
                            key: "DATABASE_URL",
                            reference: "{{db.url}}",
                            sensitive: true,
                            confidence: "medium" as const,
                            evidence: [".env.example"],
                        },
                    ],
                },
            ],
            services: [],
        };
        const result = ensureServiceConnectionVars(existing, apps, [postgres]);
        expect(result.apps[0]?.vars).toHaveLength(1);
    });

    it("leaves a service the AI already wired onto another app untouched", () => {
        const apps: AppEnvSignal[] = [
            { name: "web", entries: [], dependencies: [], primary: true },
            { name: "api", entries: [], dependencies: [], primary: false },
        ];
        // The AI placed DATABASE_URL on the api app (the one that depends on the db).
        const existing = {
            apps: [
                {
                    name: "api",
                    vars: [
                        {
                            key: "DATABASE_URL",
                            reference: "{{db.url}}",
                            sensitive: false,
                            confidence: "high" as const,
                            evidence: ["managed service: db"],
                        },
                    ],
                },
            ],
            services: [],
        };
        const result = ensureServiceConnectionVars(existing, apps, [postgres]);
        // The primary (web) app is NOT given a redundant DATABASE_URL.
        expect(result.apps.find((group) => group.name === "web")).toBeUndefined();
        expect(result.apps).toHaveLength(1);
    });

    it("skips services that expose no url token", () => {
        const apps: AppEnvSignal[] = [{ name: "api", entries: [], dependencies: [], primary: true }];
        const result = ensureServiceConnectionVars({ apps: [], services: [] }, apps, [
            { name: "temporal", recipe: "temporal" },
        ]);
        expect(result.apps).toEqual([]);
    });

    it("maps redis and mongodb to their canonical keys", () => {
        const apps: AppEnvSignal[] = [{ name: "api", entries: [], dependencies: [], primary: true }];
        const result = ensureServiceConnectionVars({ apps: [], services: [] }, apps, [
            { name: "cache", recipe: "redis" },
            { name: "mongo", recipe: "mongodb" },
        ]);
        const keys = result.apps[0]?.vars.map((entry) => `${entry.key}=${entry.reference}`);
        expect(keys).toEqual(["REDIS_URL={{cache.url}}", "MONGO_URL={{mongo.url}}"]);
    });
});
