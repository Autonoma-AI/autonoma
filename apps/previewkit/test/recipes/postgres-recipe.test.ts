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

    it("stores Postgres data in the mounted PVC subdirectory", () => {
        const result = recipe.generate(baseService(), "ns");
        const container = result.statefulSets[0]?.spec?.template?.spec?.containers?.[0];

        expect(container?.env).not.toContainEqual({ name: "PGDATA", value: "/var/lib/postgresql/data/pgdata" });
        expect(container?.volumeMounts).toContainEqual({
            name: "data",
            mountPath: "/var/lib/postgresql/data",
            subPath: "pgdata",
        });
    });

    it("connectionInfo returns the service name and Postgres port", () => {
        expect(recipe.connectionInfo(baseService())).toEqual({ host: "db", port: 5432 });
    });
});
