import type * as k8s from "@kubernetes/client-node";
import { z } from "zod";
import type { ServiceConfig } from "../config/schema";
import { BaseRecipe, passthroughOptionsSchema, type RecipeConnectionInfo, type RecipeResources } from "./recipe";

// Allowlist of accepted image prefixes for options.image.
const ALLOWED_IMAGE_PREFIXES = ["postgres:", "postgis/postgis:", "pgvector/pgvector:", "google/alloydbomni"];

const optionsSchema = z.object({
    databases: z.array(z.string()).default([]),
    image: z
        .string()
        .refine((img) => ALLOWED_IMAGE_PREFIXES.some((prefix) => img.startsWith(prefix)), {
            message: `Image is not allowed. Accepted prefixes: ${ALLOWED_IMAGE_PREFIXES.join(", ")}`,
        })
        .optional(),
    restore_from: z
        .object({
            bucket: z.string(),
            key: z.string(),
            region: z.string().optional(),
        })
        .optional(),
    storage: z.string().optional(),
});

export type PostgresRestoreOptions = {
    serviceName: string;
    bucket: string;
    key: string;
    region?: string;
};

const DEFAULT_VERSION = "16-alpine";
const PORT = 5432;
const DATA_MOUNT_PATH = "/var/lib/postgresql/data";

// Pin PGDATA to a subdirectory of the mounted volume for every allowed image. A
// freshly formatted ext4 PVC has a lost+found dir at its root and initdb refuses
// to initialize into a non-empty directory, so the cluster must live one level
// down. This is the layout the official postgres image documents for a mounted
// data dir, and it is already AlloyDB Omni's default PGDATA - so a single root
// mount plus an explicit PGDATA works for all images with no per-image branching.
const PGDATA_PATH = `${DATA_MOUNT_PATH}/pgdata`;

export class PostgresRecipe extends BaseRecipe {
    readonly name = "postgres";
    readonly schema = passthroughOptionsSchema;

    connectionInfo(config: ServiceConfig): RecipeConnectionInfo {
        return { host: config.name, port: PORT };
    }

    typedGenerate(config: ServiceConfig, namespace: string): RecipeResources {
        const options = optionsSchema.parse(config.options);
        const version = config.version ?? DEFAULT_VERSION;
        const image = options.image ?? `postgres:${version}`;
        const labels = {
            "previewkit.dev/managed-by": "previewkit",
            "previewkit.dev/service": config.name,
        };
        const hasExtraDatabases = options.databases.length > 0;
        const initConfigMapName = `${config.name}-initdb`;

        const pvc: k8s.V1PersistentVolumeClaim = {
            apiVersion: "v1",
            kind: "PersistentVolumeClaim",
            metadata: {
                name: `${config.name}-data`,
                namespace,
                labels,
            },
            spec: {
                accessModes: ["ReadWriteOnce"],
                resources: {
                    requests: { storage: options.storage ?? "1Gi" },
                },
            },
        };

        const statefulSet: k8s.V1StatefulSet = {
            apiVersion: "apps/v1",
            kind: "StatefulSet",
            metadata: {
                name: config.name,
                namespace,
                labels,
            },
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
                                ports: [{ containerPort: PORT }],
                                args: ["-c", "max_connections=300"],
                                env: [
                                    { name: "POSTGRES_USER", value: "preview" },
                                    { name: "POSTGRES_PASSWORD", value: "preview" },
                                    { name: "POSTGRES_DB", value: "preview" },
                                    { name: "PGDATA", value: PGDATA_PATH },
                                    ...Object.entries(config.env).map(([name, value]) => ({
                                        name,
                                        value,
                                    })),
                                ],
                                resources: {
                                    requests: {
                                        cpu: config.resources.cpu,
                                        memory: config.resources.memoryRequest,
                                    },
                                    limits: {
                                        memory: config.resources.memoryLimit,
                                    },
                                },
                                volumeMounts: [
                                    {
                                        name: "data",
                                        // Mount the volume root; PGDATA (set above) points the
                                        // cluster at the pgdata subdirectory. See PGDATA_PATH for
                                        // why this single layout is used for every allowed image.
                                        mountPath: DATA_MOUNT_PATH,
                                    },
                                    ...(hasExtraDatabases
                                        ? [
                                              {
                                                  name: "initdb",
                                                  mountPath: "/docker-entrypoint-initdb.d",
                                              },
                                          ]
                                        : []),
                                ],
                                readinessProbe: {
                                    exec: {
                                        // Use -h 127.0.0.1 to force TCP rather than a unix
                                        // socket. The postgres Docker image runs init scripts
                                        // in socket-only mode; without -h the probe succeeds
                                        // during init while external TCP connections still fail.
                                        command: ["pg_isready", "-U", "preview", "-h", "127.0.0.1"],
                                    },
                                    initialDelaySeconds: 5,
                                    periodSeconds: 5,
                                },
                            },
                        ],
                        volumes: [
                            {
                                name: "data",
                                persistentVolumeClaim: { claimName: `${config.name}-data` },
                            },
                            ...(hasExtraDatabases
                                ? [
                                      {
                                          name: "initdb",
                                          configMap: {
                                              name: initConfigMapName,
                                              defaultMode: 0o755,
                                          },
                                      },
                                  ]
                                : []),
                        ],
                    },
                },
            },
        };

        const service: k8s.V1Service = {
            apiVersion: "v1",
            kind: "Service",
            metadata: {
                name: config.name,
                namespace,
                labels,
            },
            spec: {
                selector: { app: config.name },
                ports: [{ port: PORT, targetPort: PORT }],
            },
        };

        const configMaps: k8s.V1ConfigMap[] = [];
        if (hasExtraDatabases) {
            configMaps.push({
                apiVersion: "v1",
                kind: "ConfigMap",
                metadata: { name: initConfigMapName, namespace, labels },
                data: { "01-create-databases.sh": buildInitScript(options.databases) },
            });
        }

        return {
            deployments: [],
            statefulSets: [statefulSet],
            services: [service],
            configMaps,
            persistentVolumeClaims: [pvc],
        };
    }
}

function buildInitScript(databases: string[]): string {
    const lines = ["#!/bin/bash", "set -e", ""];
    for (const db of databases) {
        lines.push(`createdb --username "$POSTGRES_USER" "${db}" || true`);
    }
    lines.push("");
    return lines.join("\n");
}
