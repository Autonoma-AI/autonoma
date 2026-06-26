// OpenAPI spec for the PUBLIC Previewkit surface as served by the autonoma API,
// i.e. every route under `/v1/previewkit/*`. Served natively at
// `GET /v1/previewkit/openapi.json` (NOT forwarded from Previewkit, whose internal
// spec uses bare `/v1/...` paths and omits the API-native secrets/status/schema routes).
//
// Keep this in sync with previewkit-http.router.ts. Status + secrets + schema are
// served natively here; deploy / main-branch / teardown / redeploy are forwarded to
// Previewkit (its Kubernetes + BuildKit pipeline) and will move to a Temporal worker.

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
    schema: { type: "integer", minimum: 0 },
    description: "Pull request number. 0 is reserved for an Application main-branch environment.",
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
    description: "App name as declared in the preview config",
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
        title: "Previewkit API (autonoma)",
        version: "0.1.0",
        description:
            "Public Previewkit surface, served by the autonoma API under /v1/previewkit/*. " +
            "Per-app secrets and environment status are served natively by the API; " +
            "deploy / main-branch deploy / teardown / redeploy run Previewkit's Kubernetes + BuildKit pipeline. " +
            "Every route requires an Authorization: Bearer header (autonoma API key, or the service shared secret for internal callers).",
    },
    servers: [{ url: "/", description: "autonoma API host" }],
    security: [{ bearerAuth: [] }],
    tags: [
        {
            name: "Environments",
            description: "Preview environment lifecycle (create, status, teardown, redeploy)",
        },
        {
            name: "Secrets",
            description:
                "CRUD over per-app AWS Secrets Manager bundles. Each (applicationId, app) maps to one AWS SM secret whose keys are auto-mounted into the running pod via the ExternalSecrets bridge.",
        },
    ],
    paths: {
        "/v1/previewkit/environments": {
            post: {
                tags: ["Environments"],
                summary: "Create or redeploy a preview environment",
                description:
                    "Fire-and-forget. Forwarded to Previewkit. Returns 202 with a statusUrl the caller can poll until status is 'ready' or 'failed'.",
                requestBody: {
                    required: true,
                    content: { "application/json": { schema: { $ref: "#/components/schemas/DeployRequest" } } },
                },
                responses: {
                    "202": {
                        description: "Deploy accepted, running in background",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/DeployAccepted" } } },
                    },
                    "400": {
                        description: "Invalid request body",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
                    },
                },
            },
        },
        "/v1/previewkit/applications/{applicationId}/0": {
            post: {
                tags: ["Environments"],
                summary: "Deploy an Application's main-branch preview environment",
                description:
                    "Fire-and-forget. Forwarded to Previewkit. Deploys the Application's linked repo main branch as the stable environment 0 (GitHub PR numbers start at 1).",
                parameters: [applicationIdParam],
                responses: {
                    "202": {
                        description: "Main-branch deploy accepted, running in background",
                        content: {
                            "application/json": {
                                schema: { $ref: "#/components/schemas/ApplicationEnvironmentDeployAccepted" },
                            },
                        },
                    },
                    "404": {
                        description: "Application, linked repository, or main branch ref not found",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
                    },
                    "409": {
                        description: "Application is disabled, unlinked, or has no active GitHub installation",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
                    },
                },
            },
        },
        "/v1/previewkit/environments/{owner}/{repo}/{pr}": {
            get: {
                tags: ["Environments"],
                summary: "Poll a preview environment's status",
                description:
                    "Served natively by the API from the database. Scoped to the caller's organization. Poll until `status` is `ready` (URLs populated) or `failed` (error populated).",
                parameters: [ownerParam, repoParam, prParam],
                responses: {
                    "200": {
                        description: "Current status",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/PreviewStatus" } } },
                    },
                    "400": {
                        description: "pr must be a non-negative integer",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
                    },
                    "404": {
                        description: "Environment not found (or not in the caller's organization)",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
                    },
                },
            },
            delete: {
                tags: ["Environments"],
                summary: "Tear down a preview environment",
                description:
                    "Fire-and-forget. Forwarded to Previewkit; deletes the preview namespace and its resources.",
                parameters: [ownerParam, repoParam, prParam],
                responses: {
                    "202": {
                        description: "Teardown accepted",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/TeardownAccepted" } } },
                    },
                    "400": {
                        description: "pr must be a non-negative integer",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
                    },
                },
            },
            patch: {
                tags: ["Environments"],
                summary: "Re-run the pipeline for an existing environment",
                description:
                    "Fire-and-forget. Re-runs the deploy at the environment's current head SHA. To redeploy a single app, PATCH the `/apps/{app}` sub-resource instead.",
                parameters: [ownerParam, repoParam, prParam],
                responses: {
                    "202": {
                        description: "Redeploy accepted",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/RedeployAccepted" } } },
                    },
                    "404": {
                        description: "Environment not found",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
                    },
                    "409": {
                        description: "Environment was torn down or predates redeploy support",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
                    },
                },
            },
        },
        "/v1/previewkit/environments/{owner}/{repo}/{pr}/apps/{app}": {
            patch: {
                tags: ["Environments"],
                summary: "Redeploy a single app within an environment",
                description:
                    "Fire-and-forget. `mode: rebuild` (default) rebuilds just this app's image at the environment's " +
                    "current head SHA and redeploys only it; `mode: restart` re-rolls its pods using the running image. " +
                    "Sibling apps are left untouched.",
                parameters: [ownerParam, repoParam, prParam, appParam],
                requestBody: {
                    required: false,
                    content: {
                        "application/json": { schema: { $ref: "#/components/schemas/AppRedeployRequest" } },
                    },
                },
                responses: {
                    "202": {
                        description: "Redeploy accepted",
                        content: {
                            "application/json": { schema: { $ref: "#/components/schemas/AppRedeployAccepted" } },
                        },
                    },
                    "404": {
                        description: "Environment or app not found",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
                    },
                    "409": {
                        description: "Environment was torn down or predates redeploy support",
                        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
                    },
                },
            },
        },
        "/v1/previewkit/secrets/{applicationId}/{app}": {
            get: {
                tags: ["Secrets"],
                summary: "List secret keys for an app's bundle",
                description: "Served natively by the API. Returns key names only; values are never returned.",
                parameters: [applicationIdParam, appParam],
                responses: {
                    "200": {
                        description: "List of secret keys (empty if no bundle exists yet)",
                        content: {
                            "application/json": { schema: { $ref: "#/components/schemas/SecretKeysResponse" } },
                        },
                    },
                },
            },
            put: {
                tags: ["Secrets"],
                summary: "Batch upsert keys into the bundle",
                description:
                    "Served natively by the API. Creates the AWS SM secret on first call and merges items on subsequent calls; existing keys not in `items` are preserved.",
                parameters: [applicationIdParam, appParam],
                requestBody: {
                    required: true,
                    content: { "application/json": { schema: { $ref: "#/components/schemas/SecretItemsRequest" } } },
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
        "/v1/previewkit/secrets/{applicationId}/{app}/{key}": {
            put: {
                tags: ["Secrets"],
                summary: "Upsert a single key in the bundle",
                parameters: [applicationIdParam, appParam, keyParam],
                requestBody: {
                    required: true,
                    content: { "application/json": { schema: { $ref: "#/components/schemas/SecretValueRequest" } } },
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
                summary: "Delete a single key from the bundle",
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
                    "Autonoma API key (`Authorization: Bearer <key>`) for external callers, or the service shared secret for internal autonoma calls.",
            },
        },
        schemas: {
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
                    statusUrl: { type: "string", example: "/v1/previewkit/environments/acme-corp/my-repo/42" },
                },
                required: ["accepted", "repoFullName", "prNumber", "statusUrl"],
            },
            ApplicationEnvironmentDeployAccepted: {
                type: "object",
                properties: {
                    accepted: { type: "boolean", example: true },
                    applicationId: { type: "string" },
                    repoFullName: { type: "string", example: "acme-corp/my-repo" },
                    branch: { type: "string", example: "main" },
                    headSha: { type: "string", example: "abc1234deadbeef..." },
                    prNumber: {
                        type: "integer",
                        example: 0,
                        description: "Synthetic environment number for the Application main branch.",
                    },
                    statusUrl: { type: "string", example: "/v1/previewkit/environments/acme-corp/my-repo/0" },
                },
                required: ["accepted", "applicationId", "repoFullName", "branch", "headSha", "prNumber", "statusUrl"],
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
            RedeployAccepted: {
                type: "object",
                properties: {
                    accepted: { type: "boolean", example: true },
                    repoFullName: { type: "string" },
                    prNumber: { type: "integer" },
                },
                required: ["accepted", "repoFullName", "prNumber"],
            },
            AppRedeployRequest: {
                type: "object",
                properties: {
                    mode: {
                        type: "string",
                        enum: ["rebuild", "restart"],
                        default: "rebuild",
                        description:
                            "`rebuild` rebuilds the app's image and redeploys it; `restart` re-rolls its pods using the running image.",
                    },
                },
            },
            AppRedeployAccepted: {
                type: "object",
                properties: {
                    accepted: { type: "boolean", example: true },
                    repoFullName: { type: "string" },
                    prNumber: { type: "integer" },
                    app: { type: "string" },
                    mode: { type: "string", enum: ["rebuild", "restart"] },
                },
                required: ["accepted", "repoFullName", "prNumber", "app", "mode"],
            },
            PreviewStatus: {
                type: "object",
                properties: {
                    repoFullName: { type: "string" },
                    prNumber: { type: "integer" },
                    status: {
                        type: "string",
                        enum: ["pending", "building", "deploying", "ready", "failed", "torn_down"],
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
                    items: { type: "array", items: { $ref: "#/components/schemas/SecretItem" }, minItems: 1 },
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
