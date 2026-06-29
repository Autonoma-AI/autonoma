import type * as k8s from "@kubernetes/client-node";
import type { ServiceConfig } from "../config/schema";
import { BaseRecipe, passthroughOptionsSchema, type RecipeConnectionInfo, type RecipeResources } from "./recipe";

const DEFAULT_VERSION = "7";
const PORT = 27017;
const REPLICA_SET = "rs0";

/**
 * Single-node replicaset MongoDB for preview environments.
 *
 * Replicaset mode is the prerequisite for Change Streams, the in-app CDC
 * mechanism most callers actually use. A single member is enough here
 * because HA is not a goal in preview environments; fast spin-up and
 * minimal resource cost are.
 *
 * The single member advertises `localhost:27017` (not the pod's external
 * DNS name). This sidesteps a bootstrap deadlock: a pod cannot reliably
 * resolve its OWN `<pod>.<service>` DNS name during startup (the address
 * isn't in the EndpointSlice yet, and CoreDNS negative-caches the early
 * miss), so `rs.initiate()` with an external host either hangs or fails
 * its `isSelf` check. `localhost` always resolves and `isSelf` passes
 * immediately. MongoDB permits localhost member hosts only when every
 * member is localhost - true for a single-node set.
 *
 * Apps MUST connect with `directConnection=true`, e.g.
 * `mongodb://<name>:27017/?directConnection=true`. directConnection talks
 * straight to the seed host and ignores the advertised member host, so
 * `localhost` never leaks to clients. Change Streams still work because
 * the server is a genuine replicaset member. (Replica-set DISCOVERY
 * clients - those omitting directConnection - are intentionally not
 * supported; they'd try to dial the advertised `localhost` and fail.)
 *
 * Replicaset init runs as a postStart lifecycle hook so it can call
 * `rs.initiate()` once mongod is accepting connections. The standard
 * `docker-entrypoint-initdb.d` directory is not usable for this because
 * those scripts run before mongod is ready for replicaset commands.
 */
export class MongoDbRecipe extends BaseRecipe {
    readonly name = "mongodb";
    readonly schema = passthroughOptionsSchema;

    connectionInfo(config: ServiceConfig): RecipeConnectionInfo {
        return {
            host: config.name,
            port: PORT,
            url: `mongodb://${config.name}:${PORT}/?directConnection=true`,
        };
    }

    typedGenerate(config: ServiceConfig, namespace: string): RecipeResources {
        const version = config.version ?? DEFAULT_VERSION;
        const image = `mongo:${version}`;
        const labels = {
            "previewkit.dev/managed-by": "previewkit",
            "previewkit.dev/service": config.name,
        };

        const pvc: k8s.V1PersistentVolumeClaim = {
            apiVersion: "v1",
            kind: "PersistentVolumeClaim",
            metadata: { name: `${config.name}-data`, namespace, labels },
            spec: {
                accessModes: ["ReadWriteOnce"],
                resources: { requests: { storage: "1Gi" } },
            },
        };

        const statefulSet: k8s.V1StatefulSet = {
            apiVersion: "apps/v1",
            kind: "StatefulSet",
            metadata: { name: config.name, namespace, labels },
            spec: {
                serviceName: config.name,
                replicas: 1,
                selector: { matchLabels: { app: config.name } },
                template: {
                    metadata: { labels: { app: config.name, ...labels } },
                    spec: {
                        containers: [
                            {
                                name: config.name,
                                image,
                                args: ["--replSet", REPLICA_SET, "--bind_ip_all"],
                                ports: [{ containerPort: PORT }],
                                env: Object.entries(config.env).map(([name, value]) => ({ name, value })),
                                resources: {
                                    requests: {
                                        cpu: config.resources.cpu,
                                        memory: config.resources.memoryRequest,
                                    },
                                    limits: {
                                        memory: config.resources.memoryLimit,
                                    },
                                },
                                volumeMounts: [{ name: "data", mountPath: "/data/db" }],
                                readinessProbe: {
                                    exec: {
                                        command: ["mongosh", "--quiet", "--eval", "db.adminCommand({ping:1}).ok"],
                                    },
                                    initialDelaySeconds: 10,
                                    periodSeconds: 5,
                                },
                                lifecycle: {
                                    postStart: {
                                        exec: {
                                            command: ["sh", "-c", buildReplicaSetInitScript()],
                                        },
                                    },
                                },
                            },
                        ],
                        volumes: [
                            {
                                name: "data",
                                persistentVolumeClaim: { claimName: `${config.name}-data` },
                            },
                        ],
                    },
                },
            },
        };

        const service: k8s.V1Service = {
            apiVersion: "v1",
            kind: "Service",
            metadata: { name: config.name, namespace, labels },
            spec: {
                // Headless so the service name resolves directly to the pod
                // IP, which is what clients connect to with
                // `directConnection=true`.
                clusterIP: "None",
                // Publish the pod's address before it's Ready so a client
                // (db-api, temporal-worker) that connects during mongod
                // startup gets a routable IP and lets its driver retry,
                // rather than an NXDOMAIN. Bootstrap no longer depends on
                // this (the member host is `localhost`), so it's purely
                // defensive for client connect timing.
                publishNotReadyAddresses: true,
                selector: { app: config.name },
                ports: [{ port: PORT, targetPort: PORT, name: "mongo" }],
            },
        };

        return {
            deployments: [],
            statefulSets: [statefulSet],
            services: [service],
            configMaps: [],
            persistentVolumeClaims: [pvc],
        };
    }
}

/**
 * Idempotent replicaset init. Waits for mongod to accept pings, then calls
 * `rs.initiate()` only if the replicaset is not yet initialized. On a pod
 * restart `rs.status()` succeeds and we skip the init.
 *
 * The member host is `localhost:27017` - no dependency on external DNS, so
 * there's no bootstrap deadlock and `isSelf` passes immediately. See the
 * class doc for why clients must use `directConnection=true`.
 *
 * No shell variables or single-quote gymnastics are needed since the host
 * is a literal; the whole mongosh program is a single-quoted string.
 */
function buildReplicaSetInitScript(): string {
    return [
        "set -e",
        `until mongosh --quiet --port ${PORT} --eval "db.adminCommand({ping:1}).ok" 2>/dev/null | grep -q 1; do`,
        "  sleep 1",
        "done",
        `mongosh --quiet --port ${PORT} --eval '`,
        "  try {",
        "    rs.status();",
        "  } catch (e) {",
        '    if (e.codeName === "NotYetInitialized") {',
        `      rs.initiate({ _id: "${REPLICA_SET}", members: [{ _id: 0, host: "localhost:${PORT}" }] });`,
        "    }",
        "  }",
        "'",
    ].join("\n");
}
