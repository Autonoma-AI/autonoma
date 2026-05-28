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
 * Apps connect via `mongodb://<name>:27017/?replicaSet=rs0`. The Mongo
 * driver topology-discovers the pod's stable DNS through the seed host.
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
        return { host: config.name, port: PORT };
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
                                        memory: config.resources.memory,
                                    },
                                    limits: {
                                        memory: config.resources.memory,
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
                                            command: ["sh", "-c", buildReplicaSetInitScript(config.name)],
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
                // Headless so each StatefulSet pod gets a stable DNS entry
                // (`<name>-0.<name>`). The replicaset member host string must
                // resolve identically from inside the pod and from any app
                // pod in the namespace; clusterIP-backed Services do not
                // guarantee that.
                clusterIP: "None",
                // Publish pod DNS as soon as the pod has an IP, not waiting
                // for readiness. Required so `postStart` can resolve its own
                // `<pod>.<service>` hostname when it calls `rs.initiate()` -
                // without this, readiness waits on rs.initiate, rs.initiate
                // waits on DNS, DNS waits on readiness, and the container
                // CrashLoopBackOffs.
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
 * Idempotent replicaset init. Waits for mongod to accept pings AND for
 * the pod's own DNS entry (`<pod>.<service>`) to resolve, then calls
 * `rs.initiate()` only if the replicaset is not yet initialized. On a pod
 * restart `rs.status()` succeeds and we skip the init.
 *
 * The DNS wait is critical: `rs.initiate()` validates that the configured
 * member host resolves to "this node", which requires the headless Service
 * to have already published this pod's DNS A record. Pairs with
 * `publishNotReadyAddresses: true` on the Service - without that flag, the
 * pod's DNS is gated on readiness, which is gated on this script
 * succeeding (circular). With the flag, DNS appears within a second or
 * two of the pod getting its IP, so this loop almost always exits on the
 * first iteration.
 *
 * Quoting note: `mongosh --eval` takes its JS argument inside shell single
 * quotes; we break out of the single quotes around `"$HOSTNAME"` so bash
 * expands it to the pod's hostname before mongosh sees the final string.
 */
function buildReplicaSetInitScript(serviceName: string): string {
    return [
        "set -e",
        `MEMBER_HOST="\${HOSTNAME}.${serviceName}"`,
        `until mongosh --quiet --port ${PORT} --eval "db.adminCommand({ping:1}).ok" 2>/dev/null | grep -q 1; do`,
        "  sleep 1",
        "done",
        `until getent hosts "$MEMBER_HOST" >/dev/null 2>&1; do`,
        "  sleep 1",
        "done",
        `mongosh --quiet --port ${PORT} --eval '`,
        "  try {",
        "    rs.status();",
        "  } catch (e) {",
        '    if (e.codeName === "NotYetInitialized") {',
        `      rs.initiate({ _id: "${REPLICA_SET}", members: [{ _id: 0, host: "'"$MEMBER_HOST:${PORT}"'" }] });`,
        "    }",
        "  }",
        "'",
    ].join("\n");
}
