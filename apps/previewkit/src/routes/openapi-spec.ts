const ownerParam = {
    name: "owner",
    in: "path",
    required: true,
    schema: { type: "string" },
    description: "Repository owner (e.g. GitHub organization slug)",
} as const;

const repoParam = {
    name: "repo",
    in: "path",
    required: true,
    schema: { type: "string" },
    description: "Repository name (without owner)",
} as const;

const prParam = {
    name: "pr",
    in: "path",
    required: true,
    schema: { type: "integer", minimum: 1 },
    description: "Pull request number",
} as const;

const applicationIdParam = {
    name: "applicationId",
    in: "path",
    required: true,
    schema: { type: "string" },
    description: "Application row id (CUID). Look up once from the autonoma dashboard.",
} as const;

const appParam = {
    name: "app",
    in: "path",
    required: true,
    schema: { type: "string" },
    description: "App name as declared in the repo's .preview.yaml",
} as const;

const keyParam = {
    name: "key",
    in: "path",
    required: true,
    schema: { type: "string" },
    description: "Secret key (environment variable name)",
} as const;

export const openApiSpec = {
    openapi: "3.0.3",
    info: {
        title: "Previewkit API",
        version: "0.1.0",
        description:
            "Previewkit provides Vercel-style preview environments for pull requests on Kubernetes. " +
            "This surface carries the environment lifecycle and CRUD over per-app AWS Secrets Manager bundles. " +
            "Sensitive runtime values flow to pods via the per-app bundle and the ExternalSecret bridge. " +
            "All /v1/* endpoints require an Authorization: Bearer header (autonoma API key or service shared secret); /health is open.",
    },
    servers: [{ url: "/", description: "Current host" }],
    security: [{ bearerAuth: [] }],
    tags: [
        { name: "Health", description: "Liveness probe" },
        {
            name: "Environments",
            description: "On-demand preview environment lifecycle (create, poll status, teardown)",
        },
        {
            name: "Secrets",
            description:
                "CRUD over per-app AWS Secrets Manager bundles. Each (applicationId, app) maps to one AWS SM secret whose keys are auto-mounted into the running pod via ExternalSecretsOperator. Mirrors the autonoma API's tRPC `secrets.*` route.",
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
                description: "Fire-and-forget. Deletes the preview namespace and all resources inside it.",
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
        "/v1/secrets/{applicationId}/{app}": {
            get: {
                tags: ["Secrets"],
                summary: "List secret keys for an app's AWS Secrets Manager bundle",
                description:
                    "Returns key names only; values are never returned. The bundle is the single AWS SM secret keyed by (applicationId, app).",
                parameters: [applicationIdParam, appParam],
                responses: {
                    "200": {
                        description: "List of secret keys (empty if no bundle exists yet)",
                        content: {
                            "application/json": {
                                schema: { $ref: "#/components/schemas/SecretKeysResponse" },
                            },
                        },
                    },
                },
            },
            put: {
                tags: ["Secrets"],
                summary: "Batch upsert keys into the AWS SM bundle",
                description:
                    "Creates the AWS SM secret on first call (allocating an ARN named `previewkit/<orgSlug>/<application>/<app>` and registering a `previewkit_secret` row) and merges the items on subsequent calls. Existing keys not in `items` are preserved.",
                parameters: [applicationIdParam, appParam],
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: { $ref: "#/components/schemas/SecretItemsRequest" },
                        },
                    },
                },
                responses: {
                    "200": {
                        description: "Bundle saved",
                        content: {
                            "application/json": { schema: { $ref: "#/components/schemas/SecretBatchResponse" } },
                        },
                    },
                    "400": {
                        description: "Invalid body",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
                    },
                    "404": {
                        description: "Application not found",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
                    },
                },
            },
        },
        "/v1/secrets/{applicationId}/{app}/{key}": {
            put: {
                tags: ["Secrets"],
                summary: "Upsert a single key in the AWS SM bundle",
                parameters: [applicationIdParam, appParam, keyParam],
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: { $ref: "#/components/schemas/SecretValueRequest" },
                        },
                    },
                },
                responses: {
                    "200": {
                        description: "Key saved",
                        content: {
                            "application/json": { schema: { $ref: "#/components/schemas/SecretMutationResponse" } },
                        },
                    },
                    "400": {
                        description: "Invalid body",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
                    },
                    "404": {
                        description: "Application not found",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
                    },
                },
            },
            delete: {
                tags: ["Secrets"],
                summary: "Delete a single key from the AWS SM bundle",
                parameters: [applicationIdParam, appParam, keyParam],
                responses: {
                    "200": {
                        description: "Key deleted",
                        content: {
                            "application/json": { schema: { $ref: "#/components/schemas/SecretMutationResponse" } },
                        },
                    },
                    "404": {
                        description: "Bundle or key not found",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
                    },
                },
            },
        },
    },
    components: {
        securitySchemes: {
            bearerAuth: {
                type: "http",
                scheme: "bearer",
                description:
                    "Autonoma API key (`Authorization: Bearer <key>`) for external callers, or the service shared secret for internal autonoma-to-previewkit calls. /health is exempt; every other route requires this.",
            },
        },
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
            SecretItem: {
                type: "object",
                properties: {
                    key: { type: "string", example: "STRIPE_API_KEY" },
                    value: { type: "string", example: "sk_live_..." },
                },
                required: ["key", "value"],
            },
            SecretItemsRequest: {
                type: "object",
                properties: {
                    items: {
                        type: "array",
                        items: { $ref: "#/components/schemas/SecretItem" },
                        minItems: 1,
                    },
                },
                required: ["items"],
            },
            SecretValueRequest: {
                type: "object",
                properties: { value: { type: "string", example: "sk_live_..." } },
                required: ["value"],
            },
            SecretSummary: {
                type: "object",
                description: "Key metadata; values are never returned.",
                properties: {
                    key: { type: "string" },
                    maskedLength: { type: "integer", description: "Length of the stored value, capped at 32." },
                    updatedAt: { type: "string", format: "date-time" },
                },
                required: ["key", "maskedLength", "updatedAt"],
            },
            SecretKeysResponse: {
                type: "object",
                properties: {
                    applicationId: { type: "string" },
                    app: { type: "string" },
                    keys: { type: "array", items: { $ref: "#/components/schemas/SecretSummary" } },
                },
                required: ["applicationId", "app", "keys"],
            },
            SecretMutationResponse: {
                type: "object",
                properties: {
                    applicationId: { type: "string" },
                    app: { type: "string" },
                    key: { type: "string" },
                    status: { type: "string", enum: ["saved", "deleted"] },
                },
                required: ["applicationId", "app", "key", "status"],
            },
            SecretBatchResponse: {
                type: "object",
                properties: {
                    applicationId: { type: "string" },
                    app: { type: "string" },
                    status: { type: "string", enum: ["saved"] },
                    count: { type: "integer", description: "Number of items merged into the bundle." },
                },
                required: ["applicationId", "app", "status", "count"],
            },
        },
    },
} as const;
