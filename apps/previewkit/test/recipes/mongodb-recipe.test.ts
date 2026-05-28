import { describe, expect, it } from "vitest";
import type { ServiceConfig } from "../../src/config/schema";
import { MongoDbRecipe } from "../../src/recipes/mongodb-recipe";

const baseService = (overrides: Partial<ServiceConfig> = {}): ServiceConfig => ({
    name: "db",
    recipe: "mongodb",
    env: {},
    options: {},
    resources: { cpu: "250m", memory: "256Mi" },
    ...overrides,
});

describe("MongoDbRecipe", () => {
    const recipe = new MongoDbRecipe();

    it("registers under the name 'mongodb'", () => {
        expect(recipe.name).toBe("mongodb");
    });

    it("returns the service name and 27017 as connection info", () => {
        expect(recipe.connectionInfo(baseService())).toEqual({ host: "db", port: 27017 });
    });

    it("generates a StatefulSet, headless Service, and PVC (no Deployments or ConfigMaps)", () => {
        const result = recipe.generate(baseService(), "ns");
        expect(result.statefulSets).toHaveLength(1);
        expect(result.services).toHaveLength(1);
        expect(result.persistentVolumeClaims).toHaveLength(1);
        expect(result.deployments).toEqual([]);
        expect(result.configMaps).toEqual([]);
    });

    it("uses the default mongo:7 image when no version is set", () => {
        const result = recipe.generate(baseService(), "ns");
        const container = result.statefulSets[0]?.spec?.template?.spec?.containers?.[0];
        expect(container?.image).toBe("mongo:7");
    });

    it("honors an explicit version", () => {
        const result = recipe.generate(baseService({ version: "8.0" }), "ns");
        const container = result.statefulSets[0]?.spec?.template?.spec?.containers?.[0];
        expect(container?.image).toBe("mongo:8.0");
    });

    it("starts mongod with --replSet rs0 and --bind_ip_all", () => {
        const result = recipe.generate(baseService(), "ns");
        const container = result.statefulSets[0]?.spec?.template?.spec?.containers?.[0];
        expect(container?.args).toEqual(["--replSet", "rs0", "--bind_ip_all"]);
    });

    it("exposes port 27017 on the container and on a headless Service", () => {
        const result = recipe.generate(baseService(), "ns");
        const container = result.statefulSets[0]?.spec?.template?.spec?.containers?.[0];
        expect(container?.ports).toEqual([{ containerPort: 27017 }]);

        const service = result.services[0];
        expect(service?.spec?.clusterIP).toBe("None");
        expect(service?.spec?.ports).toEqual([{ port: 27017, targetPort: 27017, name: "mongo" }]);
    });

    it("publishes the pod's address before readiness so clients connecting during startup get a routable IP", () => {
        // Bootstrap no longer depends on this (the member host is localhost);
        // it's defensive so a client connecting mid-startup gets a routable
        // IP and its driver retries, instead of an NXDOMAIN.
        const result = recipe.generate(baseService(), "ns");
        expect(result.services[0]?.spec?.publishNotReadyAddresses).toBe(true);
    });

    it("mounts a 1Gi PVC at /data/db", () => {
        const result = recipe.generate(baseService(), "ns");
        const container = result.statefulSets[0]?.spec?.template?.spec?.containers?.[0];
        expect(container?.volumeMounts).toEqual([{ name: "data", mountPath: "/data/db" }]);

        const pvc = result.persistentVolumeClaims[0];
        expect(pvc?.metadata?.name).toBe("db-data");
        expect(pvc?.spec?.resources?.requests).toEqual({ storage: "1Gi" });
    });

    it("forwards env vars from the service config into the container", () => {
        const result = recipe.generate(baseService({ env: { FOO: "bar", BAZ: "qux" } }), "ns");
        const container = result.statefulSets[0]?.spec?.template?.spec?.containers?.[0];
        expect(container?.env).toEqual([
            { name: "FOO", value: "bar" },
            { name: "BAZ", value: "qux" },
        ]);
    });

    it("uses mongosh ping for the readiness probe", () => {
        const result = recipe.generate(baseService(), "ns");
        const container = result.statefulSets[0]?.spec?.template?.spec?.containers?.[0];
        expect(container?.readinessProbe?.exec?.command).toEqual([
            "mongosh",
            "--quiet",
            "--eval",
            "db.adminCommand({ping:1}).ok",
        ]);
    });

    it("declares a postStart lifecycle hook that initializes the replicaset", () => {
        const result = recipe.generate(baseService(), "ns");
        const container = result.statefulSets[0]?.spec?.template?.spec?.containers?.[0];
        const cmd = container?.lifecycle?.postStart?.exec?.command;

        expect(cmd?.[0]).toBe("sh");
        expect(cmd?.[1]).toBe("-c");
        const script = cmd?.[2] ?? "";

        // Waits for mongod before initiating.
        expect(script).toContain('until mongosh --quiet --port 27017 --eval "db.adminCommand({ping:1}).ok"');
        // Idempotent: only initiates when rs.status() throws NotYetInitialized.
        expect(script).toContain("rs.status()");
        expect(script).toContain('e.codeName === "NotYetInitialized"');
        // Names the replicaset rs0 with one member at localhost.
        expect(script).toContain('rs.initiate({ _id: "rs0"');
        expect(script).toContain('host: "localhost:27017"');
    });

    it("advertises localhost as the member host so bootstrap needs no external DNS", () => {
        // Using the pod's own <pod>.<service> name deadlocks: the address
        // isn't published until the pod is ready, and readiness waits on
        // this script. localhost always resolves and isSelf passes at once.
        const result = recipe.generate(baseService({ name: "events-store" }), "ns");
        const script =
            result.statefulSets[0]?.spec?.template?.spec?.containers?.[0]?.lifecycle?.postStart?.exec?.command?.[2] ??
            "";
        expect(script).toContain('host: "localhost:27017"');
        // No dependency on the pod hostname or the service DNS name.
        expect(script).not.toContain("HOSTNAME");
        expect(script).not.toContain("getent");
        expect(script).not.toContain("events-store");
    });

    it("scopes resources to the requested namespace", () => {
        const result = recipe.generate(baseService(), "preview-ns");
        expect(result.statefulSets[0]?.metadata?.namespace).toBe("preview-ns");
        expect(result.services[0]?.metadata?.namespace).toBe("preview-ns");
        expect(result.persistentVolumeClaims[0]?.metadata?.namespace).toBe("preview-ns");
    });

    it("applies the previewkit ownership labels", () => {
        const result = recipe.generate(baseService(), "ns");
        expect(result.statefulSets[0]?.metadata?.labels).toMatchObject({
            "previewkit.dev/managed-by": "previewkit",
            "previewkit.dev/service": "db",
        });
    });

    it("requests cpu+memory and limits memory only (CPU throttling is the expensive failure mode)", () => {
        const result = recipe.generate(baseService({ resources: { cpu: "500m", memory: "512Mi" } }), "ns");
        const container = result.statefulSets[0]?.spec?.template?.spec?.containers?.[0];
        expect(container?.resources?.requests).toEqual({ cpu: "500m", memory: "512Mi" });
        expect(container?.resources?.limits).toEqual({ memory: "512Mi" });
    });
});
