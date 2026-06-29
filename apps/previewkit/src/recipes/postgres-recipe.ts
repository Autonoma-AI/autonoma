import type * as k8s from "@kubernetes/client-node";
import { z } from "zod";
import type { ServiceConfig } from "../config/schema";
import { BaseRecipe, passthroughOptionsSchema, type RecipeConnectionInfo, type RecipeResources } from "./recipe";

// Allowlist of accepted image prefixes for an explicit options.image. The
// default image (DEFAULT_POSTGRES_IMAGE) is internal, not user-supplied, so it
// bypasses this list.
const ALLOWED_IMAGE_PREFIXES = ["postgres:", "postgis/postgis:", "pgvector/pgvector:", "google/alloydbomni"];

// The default Postgres image, used whenever a preview doesn't pin its own
// options.image/version. It is the source of truth for which extensions are
// available: it bundles a broad set (PostGIS, pgvector, timescaledb, pg_cron,
// pg_graphql, ...) on top of the contrib modules, so any extension a preview
// requests via options.extensions just works. There is no code-side allowlist -
// to make a new extension available, bake it into the image. Built from
// apps/previewkit/postgres.Dockerfile.
const DEFAULT_POSTGRES_IMAGE = "public.ecr.aws/autonoma/postgres:16";

// A few baked extensions only load via shared_preload_libraries - CREATE
// EXTENSION fails outright otherwise. When the default image is in use and one
// is requested, we add its library to the postgres args so it is loaded before
// the init script runs (the entrypoint passes these args to the temporary server
// it uses for /docker-entrypoint-initdb.d). Order is significant: timescaledb
// must be preloaded first. Only applied to the default image, since a custom or
// stock image may not ship these libraries (preloading a missing one would crash
// the server on startup instead of failing a single CREATE EXTENSION).
const PRELOAD_REQUIRED_EXTENSIONS: ReadonlyArray<{ extension: string; library: string }> = [
    { extension: "timescaledb", library: "timescaledb" },
    { extension: "pg_cron", library: "pg_cron" },
    { extension: "pgaudit", library: "pgaudit" },
];

// Postgres extension names are identifiers; this only guards the generated init
// script against malformed input, not membership (the image decides membership).
const extensionName = z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, "Invalid extension name: use a Postgres extension identifier (letters, digits, _ or -)");

// Database names are interpolated into the generated init script too; guard them
// the same way as extension names (identifier shape, not membership).
const databaseName = z.string().regex(/^[A-Za-z0-9_-]+$/, "Invalid database name: use letters, digits, _ or -");

const optionsSchema = z.object({
    databases: z.array(databaseName).default([]),
    extensions: z.array(extensionName).default([]),
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

const PORT = 5432;
const POSTGRES_USER = "preview";
const POSTGRES_PASSWORD = "preview";
const POSTGRES_DB = "preview";
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
        return {
            host: config.name,
            port: PORT,
            url: `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${config.name}:${PORT}/${POSTGRES_DB}`,
        };
    }

    typedGenerate(config: ServiceConfig, namespace: string): RecipeResources {
        const options = optionsSchema.parse(config.options);
        // Precedence: an explicit image wins; an explicit version opts out to the
        // matching stock image (which carries only the contrib extensions);
        // otherwise the default image, which bundles every baked extension.
        const image = options.image ?? (config.version != null ? `postgres:${config.version}` : DEFAULT_POSTGRES_IMAGE);
        const isDefaultImage = image === DEFAULT_POSTGRES_IMAGE;
        const preloadLibraries = isDefaultImage ? resolvePreloadLibraries(options.extensions) : [];
        const postgresArgs = ["-c", "max_connections=300"];
        if (preloadLibraries.length > 0) {
            postgresArgs.push("-c", `shared_preload_libraries=${preloadLibraries.join(",")}`);
        }
        const labels = {
            "previewkit.dev/managed-by": "previewkit",
            "previewkit.dev/service": config.name,
        };
        const needsInitScripts = options.databases.length > 0 || options.extensions.length > 0;
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
                                args: postgresArgs,
                                env: [
                                    { name: "POSTGRES_USER", value: POSTGRES_USER },
                                    { name: "POSTGRES_PASSWORD", value: POSTGRES_PASSWORD },
                                    { name: "POSTGRES_DB", value: POSTGRES_DB },
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
                                    ...(needsInitScripts
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
                                        command: ["pg_isready", "-U", POSTGRES_USER, "-h", "127.0.0.1"],
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
                            ...(needsInitScripts
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
        if (needsInitScripts) {
            configMaps.push({
                apiVersion: "v1",
                kind: "ConfigMap",
                metadata: { name: initConfigMapName, namespace, labels },
                data: { "01-init.sh": buildInitScript(options.databases, options.extensions) },
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

// Map the requested extensions to the shared_preload_libraries they need,
// preserving PRELOAD_REQUIRED_EXTENSIONS order (timescaledb first).
function resolvePreloadLibraries(extensions: string[]): string[] {
    const requested = new Set(extensions);
    return PRELOAD_REQUIRED_EXTENSIONS.filter((entry) => requested.has(entry.extension)).map((entry) => entry.library);
}

function buildInitScript(databases: string[], extensions: string[]): string {
    const lines = ["#!/bin/bash", "set -e", ""];

    for (const db of databases) {
        lines.push(`createdb --username "$POSTGRES_USER" "${db}" || true`);
    }

    if (extensions.length > 0) {
        if (databases.length > 0) lines.push("");
        // Enable each extension in the default database and every extra database.
        // CASCADE pulls in any dependency extensions (e.g. earthdistance -> cube).
        const targets = ['"$POSTGRES_DB"', ...databases.map((db) => `"${db}"`)].join(" ");
        lines.push(`for database in ${targets}; do`);
        for (const ext of extensions) {
            lines.push(
                `  psql --username "$POSTGRES_USER" --dbname "$database" -c 'CREATE EXTENSION IF NOT EXISTS "${ext}" CASCADE;'`,
            );
        }
        lines.push("done");
    }

    lines.push("");
    return lines.join("\n");
}
