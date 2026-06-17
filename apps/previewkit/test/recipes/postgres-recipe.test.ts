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
        { label: "the official postgres image", options: {} },
        { label: "AlloyDB Omni", options: { image: "google/alloydbomni:16.8.0" } },
    ])("pins PGDATA to a subdirectory and mounts the volume root for $label", ({ options }) => {
        const result = recipe.generate(baseService({ options }), "ns");
        const container = result.statefulSets[0]?.spec?.template?.spec?.containers?.[0];
        const dataMount = container?.volumeMounts?.find((mount) => mount.name === "data");

        expect(container?.env).toContainEqual({ name: "PGDATA", value: "/var/lib/postgresql/data/pgdata" });
        expect(dataMount?.mountPath).toBe("/var/lib/postgresql/data");
        expect(dataMount?.subPath).toBeUndefined();
    });

    it("connectionInfo returns the service name and Postgres port", () => {
        expect(recipe.connectionInfo(baseService())).toEqual({ host: "db", port: 5432 });
    });
});
