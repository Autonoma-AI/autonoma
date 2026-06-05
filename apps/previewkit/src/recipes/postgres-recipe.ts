import type * as k8s from "@kubernetes/client-node";
import { z } from "zod";
import type { ServiceConfig } from "../config/schema";
import { BaseRecipe, passthroughOptionsSchema, type RecipeConnectionInfo, type RecipeResources } from "./recipe";

// Allowlist of accepted image prefixes for options.image.
const ALLOWED_IMAGE_PREFIXES = ["postgres:", "postgis/postgis:", "pgvector/pgvector:"];

const optionsSchema = z.object({
    databases: z.array(z.string()).default([]),
    image: z
        .string()
        .refine((img) => ALLOWED_IMAGE_PREFIXES.some((prefix) => img.startsWith(prefix)), {
            message: `Image is not allowed. Accepted prefixes: ${ALLOWED_IMAGE_PREFIXES.join(", ")}`,
        })
        .optional(),
});

const DEFAULT_VERSION = "16-alpine";
const PORT = 5432;

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
                    requests: { storage: "1Gi" },
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
                                    ...Object.entries(config.env).map(([name, value]) => ({
                                        name,
                                        value,
                                    })),
                                ],
                                resources: {
                                    requests: {
                                        cpu: config.resources.cpu,
                                        memory: config.resources.memory,
                                    },
                                    limits: {
                                        memory: config.resources.memory,
                                    },
                                },
                                volumeMounts: [
                                    {
                                        name: "data",
                                        mountPath: "/var/lib/postgresql/data",
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
