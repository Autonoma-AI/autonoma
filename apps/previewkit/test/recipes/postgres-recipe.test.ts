import { describe, expect, it } from "vitest";
import type { ServiceConfig } from "../../src/config/schema";
import { PostgresRecipe } from "../../src/recipes/postgres-recipe";

const baseService = (overrides: Partial<ServiceConfig> = {}): ServiceConfig => ({
    name: "db",
    recipe: "postgres",
    env: {},
    options: {},
    resources: { cpu: "1", memory: "1Gi" },
    ...overrides,
});

describe("PostgresRecipe", () => {
    const recipe = new PostgresRecipe();

    // The same data layout must hold for every allowed image: mount the volume
    // root and pin PGDATA to a subdirectory, so lost+found never collides with
    // initdb and AlloyDB Omni (whose default PGDATA is already that subdir)
    // needs no special-casing.
    it.each([
        { label: "the default image", options: {} },
        { label: "AlloyDB Omni", options: { image: "google/alloydbomni:16.8.0" } },
    ])("pins PGDATA to a subdirectory and mounts the volume root for $label", ({ options }) => {
        const result = recipe.generate(baseService({ options }), "ns");
        const container = result.statefulSets[0]?.spec?.template?.spec?.containers?.[0];
        const dataMount = container?.volumeMounts?.find((mount) => mount.name === "data");

        expect(container?.env).toContainEqual({ name: "PGDATA", value: "/var/lib/postgresql/data/pgdata" });
        expect(dataMount?.mountPath).toBe("/var/lib/postgresql/data");
        expect(dataMount?.subPath).toBeUndefined();
    });

    it("connectionInfo returns the service name, Postgres port and connection URL", () => {
        expect(recipe.connectionInfo(baseService())).toEqual({
            host: "db",
            port: 5432,
            url: "postgresql://preview:preview@db:5432/preview",
        });
    });

    const initScript = (config: ServiceConfig): string => {
        const result = recipe.generate(config, "ns");
        const configMap = result.configMaps.find((cm) => cm.metadata?.name === "db-initdb");
        return configMap?.data?.["01-init.sh"] ?? "";
    };

    it("enables requested extensions in the default database via an init ConfigMap", () => {
        const result = recipe.generate(baseService({ options: { extensions: ["uuid-ossp", "pgcrypto"] } }), "ns");
        const spec = result.statefulSets[0]?.spec?.template?.spec;
        const script = result.configMaps.find((cm) => cm.metadata?.name === "db-initdb")?.data?.["01-init.sh"] ?? "";

        expect(script).toContain('for database in "$POSTGRES_DB"; do');
        expect(script).toContain(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp" CASCADE;`);
        expect(script).toContain(`CREATE EXTENSION IF NOT EXISTS "pgcrypto" CASCADE;`);
        expect(spec?.volumes?.some((v) => v.name === "initdb")).toBe(true);
        expect(spec?.containers?.[0]?.volumeMounts?.some((m) => m.name === "initdb")).toBe(true);
    });

    it("creates extensions in every extra database as well as the default", () => {
        const script = initScript(baseService({ options: { databases: ["analytics"], extensions: ["citext"] } }));

        expect(script).toContain(`createdb --username "$POSTGRES_USER" "analytics" || true`);
        expect(script).toContain('for database in "$POSTGRES_DB" "analytics"; do');
        expect(script).toContain(`CREATE EXTENSION IF NOT EXISTS "citext" CASCADE;`);
    });

    it("omits the init ConfigMap and volume when no databases or extensions are requested", () => {
        const result = recipe.generate(baseService({ options: {} }), "ns");
        const spec = result.statefulSets[0]?.spec?.template?.spec;

        expect(result.configMaps).toHaveLength(0);
        expect(spec?.volumes?.some((v) => v.name === "initdb")).toBe(false);
    });

    it("enables any baked extension - there is no code-side allowlist", () => {
        const script = initScript(baseService({ options: { extensions: ["vector", "postgis", "timescaledb"] } }));

        expect(script).toContain(`CREATE EXTENSION IF NOT EXISTS "vector" CASCADE;`);
        expect(script).toContain(`CREATE EXTENSION IF NOT EXISTS "postgis" CASCADE;`);
        expect(script).toContain(`CREATE EXTENSION IF NOT EXISTS "timescaledb" CASCADE;`);
    });

    it("rejects malformed extension names so the init script stays well-formed", () => {
        expect(() => recipe.generate(baseService({ options: { extensions: ['vector"; DROP'] } }), "ns")).toThrow();
    });

    const containerImage = (config: ServiceConfig): string | undefined =>
        recipe.generate(config, "ns").statefulSets[0]?.spec?.template?.spec?.containers?.[0]?.image;

    it("defaults to the baked platform image", () => {
        expect(containerImage(baseService())).toBe("public.ecr.aws/autonoma/postgres:16");
    });

    it("uses the matching stock image for an explicit version", () => {
        expect(containerImage(baseService({ version: "17" }))).toBe("postgres:17");
    });

    const containerArgs = (config: ServiceConfig): string[] =>
        recipe.generate(config, "ns").statefulSets[0]?.spec?.template?.spec?.containers?.[0]?.args ?? [];

    it("preloads timescaledb, pg_cron and pgaudit (timescaledb first) when requested on the default image", () => {
        // Request order is intentionally scrambled; preload order follows the
        // recipe's own ordering, not the request.
        const args = containerArgs(
            baseService({ options: { extensions: ["pgaudit", "pg_cron", "vector", "timescaledb"] } }),
        );

        expect(args).toEqual([
            "-c",
            "max_connections=300",
            "-c",
            "shared_preload_libraries=timescaledb,pg_cron,pgaudit",
        ]);
    });

    it("omits shared_preload_libraries when no preload-required extension is requested", () => {
        const args = containerArgs(baseService({ options: { extensions: ["vector", "postgis"] } }));

        expect(args).toEqual(["-c", "max_connections=300"]);
    });

    it("does not preload for a non-default image, even if a preload extension is requested", () => {
        // A stock/custom image may not ship the library; preloading a missing one
        // would crash the server on startup instead of failing one CREATE EXTENSION.
        const args = containerArgs(baseService({ version: "17", options: { extensions: ["timescaledb"] } }));

        expect(args.some((arg) => arg.startsWith("shared_preload_libraries="))).toBe(false);
    });
});
