const ownerParam = {
    name: "owner",
    in: "path",
    required: true,
    schema: { type: "string" },
    description: "Repository owner (e.g. GitHub organization slug)",
} as const;

const appParam = {
    name: "app",
    in: "path",
    required: true,
    schema: { type: "string" },
    description: "App name as declared in the repo's .preview.yaml",
} as const;

const repoParam = {
    name: "repo",
    in: "path",
    required: true,
    schema: { type: "string" },
    description: "Repository name (without owner)",
} as const;

const keyParam = {
    name: "key",
    in: "path",
    required: true,
    schema: { type: "string" },
    description: "Secret key (environment variable name)",
} as const;

const prParam = {
    name: "pr",
    in: "path",
    required: true,
    schema: { type: "integer", minimum: 1 },
    description: "Pull request number",
} as const;

const savedResponse = {
    "application/json": { schema: { $ref: "#/components/schemas/SecretMutationResponse" } },
} as const;
const savedPrResponse = {
    "application/json": { schema: { $ref: "#/components/schemas/PrSecretMutationResponse" } },
} as const;

export const openApiSpec = {
    openapi: "3.0.3",
    info: {
        title: "Previewkit API",
        version: "0.1.0",
        description:
            "Previewkit provides Vercel-style preview environments for pull requests on Kubernetes. " +
            "This API exposes webhook ingestion for Git providers and CRUD for per-owner / per-app / per-PR secrets.",
    },
    servers: [{ url: "/", description: "Current host" }],
    tags: [
        { name: "Health", description: "Liveness probe" },
        {
            name: "Environments",
            description: "On-demand preview environment lifecycle (create, poll status, teardown)",
        },
        { name: "Secrets (baseline)", description: "Owner + app scoped secrets, shared across all PRs for that app" },
        {
            name: "Secrets (PR-scoped)",
            description:
                "Owner + app + PR scoped secrets. Merged on top of baseline at deploy time and deleted with the namespace on teardown. Intended for external per-preview resources (e.g. a Neon database branch created by the client's CI).",
        },
    ],
    paths: {
        "/health": {
            get: {
                tags: ["Health"],
                summary: "Liveness probe",
                responses: {
                    "200": {
                        description: "Service is up",
                        content: {
                            "application/json": {
                                schema: { $ref: "#/components/schemas/HealthResponse" },
                            },
                        },
                    },
                },
            },
        },
        "/v1/environments": {
            post: {
                tags: ["Environments"],
                summary: "Create or redeploy a preview environment",
                description:
                    "Fire-and-forget. Accepts the request, returns 202 with a statusUrl the caller can poll until status is 'ready' or 'failed'. Posts a PR comment and commit status to GitHub while the deploy runs.",
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: { $ref: "#/components/schemas/DeployRequest" },
                        },
                    },
                },
                responses: {
                    "202": {
                        description: "Deploy accepted, running in background",
                        content: {
                            "application/json": {
                                schema: { $ref: "#/components/schemas/DeployAccepted" },
                            },
                        },
                    },
                    "400": {
                        description: "Invalid request body",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
                    },
                },
            },
        },
        "/v1/environments/{owner}/{repo}/{pr}": {
            get: {
                tags: ["Environments"],
                summary: "Poll a preview environment's status",
                description:
                    "Reads the namespace annotations maintained by the pipeline. Clients should poll until `status` is `ready` (URLs populated) or `failed` (error populated).",
                parameters: [ownerParam, repoParam, prParam],
                responses: {
                    "200": {
                        description: "Current status",
                        content: {
                            "application/json": {
                                schema: { $ref: "#/components/schemas/PreviewStatus" },
                            },
                        },
                    },
                    "400": {
                        description: "pr must be a positive integer",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
                    },
                    "404": {
                        description: "Preview not found (never deployed or torn down)",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
                    },
                },
            },
            delete: {
                tags: ["Environments"],
                summary: "Tear down a preview environment",
                description: "Fire-and-forget. Deletes the namespace and all PR-scoped secrets.",
                parameters: [ownerParam, repoParam, prParam],
                responses: {
                    "202": {
                        description: "Teardown accepted",
                        content: {
                            "application/json": {
                                schema: { $ref: "#/components/schemas/TeardownAccepted" },
                            },
                        },
                    },
                    "400": {
                        description: "pr must be a positive integer",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
                    },
                },
            },
        },
        "/v1/secrets/{owner}/{app}": {
            get: {
                tags: ["Secrets (baseline)"],
                summary: "List baseline secret keys for an app",
                parameters: [ownerParam, appParam],
                responses: {
                    "200": {
                        description: "List of stored secret keys (values are never returned)",
                        content: {
                            "application/json": {
                                schema: { $ref: "#/components/schemas/SecretKeysResponse" },
                            },
                        },
                    },
                },
            },
        },
        "/v1/secrets/{owner}/{app}/{key}": {
            put: {
                tags: ["Secrets (baseline)"],
                summary: "Create or update a baseline secret",
                parameters: [ownerParam, appParam, keyParam],
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: { $ref: "#/components/schemas/SecretValueRequest" },
                        },
                    },
                },
                responses: {
                    "200": { description: "Secret saved", content: savedResponse },
                    "400": {
                        description: "Invalid body",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
                    },
                },
            },
            delete: {
                tags: ["Secrets (baseline)"],
                summary: "Delete a baseline secret",
                parameters: [ownerParam, appParam, keyParam],
                responses: {
                    "200": { description: "Secret deleted", content: savedResponse },
                    "404": {
                        description: "Secret not found",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
                    },
                },
            },
        },
        "/v1/secrets/{owner}/{app}/pr/{pr}": {
            get: {
                tags: ["Secrets (PR-scoped)"],
                summary: "List PR-scoped secret keys for an app",
                parameters: [ownerParam, appParam, prParam],
                responses: {
                    "200": {
                        description: "List of stored PR-scoped secret keys",
                        content: {
                            "application/json": {
                                schema: { $ref: "#/components/schemas/PrSecretKeysResponse" },
                            },
                        },
                    },
                    "400": {
                        description: "pr must be a positive integer",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
                    },
                },
            },
        },
        "/v1/secrets/{owner}/{app}/pr/{pr}/{key}": {
            put: {
                tags: ["Secrets (PR-scoped)"],
                summary: "Create or update a PR-scoped secret",
                description:
                    "PR-scoped secrets override the baseline at deploy time. Typical use: the client's CI creates a Neon branch per PR and writes the connection string here before the preview deploys.",
                parameters: [ownerParam, appParam, prParam, keyParam],
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: { $ref: "#/components/schemas/SecretValueRequest" },
                        },
                    },
                },
                responses: {
                    "200": { description: "Secret saved", content: savedPrResponse },
                    "400": {
                        description: "Invalid body or pr parameter",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
                    },
                },
            },
            delete: {
                tags: ["Secrets (PR-scoped)"],
                summary: "Delete a PR-scoped secret",
                parameters: [ownerParam, appParam, prParam, keyParam],
                responses: {
                    "200": { description: "Secret deleted", content: savedPrResponse },
                    "400": {
                        description: "pr must be a positive integer",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
                    },
                    "404": {
                        description: "Secret not found",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
                    },
                },
            },
        },
    },
    components: {
        schemas: {
            HealthResponse: {
                type: "object",
                properties: { status: { type: "string", example: "ok" } },
                required: ["status"],
            },
            ErrorResponse: {
                type: "object",
                properties: { error: { type: "string" } },
                required: ["error"],
            },
            DeployRequest: {
                type: "object",
                properties: {
                    repoFullName: { type: "string", example: "acme-corp/my-repo", description: "owner/repo" },
                    prNumber: { type: "integer", minimum: 1, example: 42 },
                    headSha: { type: "string", example: "abc1234deadbeef..." },
                    headRef: { type: "string", example: "feature/new-thing" },
                    cloneUrl: { type: "string", format: "uri", example: "https://github.com/acme-corp/my-repo.git" },
                    baseSha: { type: "string" },
                    baseRef: { type: "string", example: "main" },
                },
                required: ["repoFullName", "prNumber", "headSha", "headRef", "cloneUrl"],
            },
            DeployAccepted: {
                type: "object",
                properties: {
                    accepted: { type: "boolean", example: true },
                    repoFullName: { type: "string" },
                    prNumber: { type: "integer" },
                    statusUrl: { type: "string", example: "/v1/environments/acme-corp/my-repo/42" },
                },
                required: ["accepted", "repoFullName", "prNumber", "statusUrl"],
            },
            TeardownAccepted: {
                type: "object",
                properties: {
                    accepted: { type: "boolean", example: true },
                    repoFullName: { type: "string" },
                    prNumber: { type: "integer" },
                },
                required: ["accepted", "repoFullName", "prNumber"],
            },
            PreviewStatus: {
                type: "object",
                properties: {
                    repoFullName: { type: "string" },
                    prNumber: { type: "integer" },
                    status: {
                        type: "string",
                        enum: ["pending", "building", "deploying", "ready", "failed", "unknown"],
                    },
                    phase: {
                        type: "string",
                        description: "Fine-grained phase within the current status",
                        example: "building-images",
                    },
                    createdAt: { type: "string", format: "date-time" },
                    updatedAt: { type: "string", format: "date-time" },
                    lastDeployedSha: { type: "string" },
                    urls: {
                        type: "object",
                        additionalProperties: { type: "string", format: "uri" },
                        description: "Populated when status is 'ready'. Keyed by app name.",
                    },
                    error: { type: "string", description: "Populated when status is 'failed'" },
                },
                required: ["repoFullName", "prNumber", "status", "urls"],
            },
            SecretValueRequest: {
                type: "object",
                properties: { value: { type: "string", example: "postgres://..." } },
                required: ["value"],
            },
            SecretKeysResponse: {
                type: "object",
                properties: {
                    owner: { type: "string" },
                    app: { type: "string" },
                    keys: { type: "array", items: { type: "string" } },
                },
                required: ["owner", "app", "keys"],
            },
            PrSecretKeysResponse: {
                type: "object",
                properties: {
                    owner: { type: "string" },
                    app: { type: "string" },
                    pr: { type: "integer" },
                    keys: { type: "array", items: { type: "string" } },
                },
                required: ["owner", "app", "pr", "keys"],
            },
            SecretMutationResponse: {
                type: "object",
                properties: {
                    owner: { type: "string" },
                    app: { type: "string" },
                    key: { type: "string" },
                    status: { type: "string", enum: ["saved", "deleted"] },
                },
                required: ["owner", "app", "key", "status"],
            },
            PrSecretMutationResponse: {
                type: "object",
                properties: {
                    owner: { type: "string" },
                    app: { type: "string" },
                    pr: { type: "integer" },
                    key: { type: "string" },
                    status: { type: "string", enum: ["saved", "deleted"] },
                },
                required: ["owner", "app", "pr", "key", "status"],
            },
        },
    },
} as const;
