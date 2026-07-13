import { describe, expect, test } from "vitest";
import {
    applySelection,
    defaultBackendsFor,
    pickDefaultSelection,
    type ProjectMap,
    resolveSelection,
} from "../../src/core/project-map";

// A monorepo whose single frontend declares three deps: one real backend by path, one
// shared package that owns no data layer (must be dropped), and one named by the data-layer
// schema path rather than the backend's own path (must resolve to that backend).
function monorepo(): ProjectMap {
    return {
        frontends: [
            {
                path: "apps/web",
                framework: "next",
                dependsOn: ["apps/api", "packages/shared-utils", "packages/db/schema.prisma"],
                why: "has pages",
            },
        ],
        backends: [
            { path: "apps/api", language: "typescript", framework: "hono", why: "http api" },
            {
                path: "packages/db",
                language: "typescript",
                framework: "prisma",
                dataLayer: { kind: "prisma", schemaPath: "packages/db/schema.prisma" },
                why: "owns the models",
            },
        ],
        ignore: [],
    };
}

describe("project-map scope resolution", () => {
    test("defaultBackendsFor resolves real deps and drops ones that own no backend", () => {
        expect(defaultBackendsFor(monorepo(), "apps/web")).toEqual(["apps/api", "packages/db"]);
    });

    test("defaultBackendsFor de-duplicates when two deps resolve to the same backend", () => {
        const map = monorepo();
        map.frontends[0]!.dependsOn = ["packages/db", "packages/db/schema.prisma"];
        expect(defaultBackendsFor(map, "apps/web")).toEqual(["packages/db"]);
    });

    test("the defaulted selection applies cleanly even though a declared dep was unresolvable", () => {
        const map = monorepo();
        const selection = pickDefaultSelection(map);
        expect(selection).toEqual({ frontend: "apps/web", backends: ["apps/api", "packages/db"] });
        // The unresolvable "packages/shared-utils" must not have reached applySelection.
        expect(() => applySelection(map, selection!)).not.toThrow();
    });

    test("an explicitly named non-existent backend still fails loud", () => {
        const map = monorepo();
        expect(() => applySelection(map, { frontend: "apps/web", backends: ["packages/shared-utils"] })).toThrow(
            /not in the map/,
        );
    });

    test("resolveSelection maps a data-layer schema path back to its owning backend", () => {
        const map = monorepo();
        const resolved = resolveSelection(map, { frontend: "apps/web", backends: ["packages/db/schema.prisma"] });
        expect(resolved.backends).toEqual(["packages/db"]);
    });

    test("pickDefaultSelection returns undefined when the frontend is ambiguous", () => {
        const map = monorepo();
        map.frontends.push({ path: "apps/admin", framework: "next", dependsOn: [], why: "second ui" });
        expect(pickDefaultSelection(map)).toBeUndefined();
    });
});
