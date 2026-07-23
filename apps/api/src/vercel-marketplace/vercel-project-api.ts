import { ThirdPartyError } from "@autonoma/errors";
import { logger as rootLogger } from "@autonoma/logger";
import { z } from "zod";

const logger = rootLogger.child({ name: "VercelProjectApi" });

const VERCEL_API_BASE = "https://api.vercel.com";
const AUTONOMA_CHECK_NAME = "Autonoma";
const DEFAULT_DEPLOYMENT_LIST_LIMIT = 15;
const VERCEL_DEPLOYMENT_CREATE_PATH = "/v13/deployments";

export interface VercelDeploymentSummary {
    id: string;
    url: string;
    target: "production" | "preview";
    branch: string | undefined;
    createdAt: string;
}

/**
 * A single deployment's current build state, used to (re)deploy and then poll
 * for readiness. `readyState` is Vercel's raw string (QUEUED / INITIALIZING /
 * BUILDING / READY / ERROR / CANCELED) - call sites compare against "READY"
 * rather than locking a Zod enum that would break if Vercel adds a state.
 */
export interface VercelDeploymentState {
    id: string;
    url: string;
    readyState: string;
}

// ─── Vercel API response schemas ──────────────────────────────────────────────

const VercelProjectLinkSchema = z
    .object({
        type: z.string().optional(),
        repoId: z.coerce.number().optional(),
    })
    .partial();

const VercelProjectResponseSchema = z.object({
    id: z.string(),
    name: z.string(),
    link: VercelProjectLinkSchema.optional(),
    targets: z
        .object({
            production: z.object({ url: z.string().optional() }).optional(),
        })
        .optional(),
});

export const VercelCheckResponseSchema = z.object({ id: z.string() });

const VercelCheckListItemSchema = z.object({
    id: z.string(),
    name: z.string(),
    sourceIntegrationConfigurationId: z.string().optional(),
});

const VercelCheckListResponseSchema = z.object({ checks: z.array(VercelCheckListItemSchema) });

// `protectionBypass` is keyed by the secret itself; each value is metadata
// about that bypass entry (createdAt/createdBy/scope/...), which we never
// read - only the key (the secret) matters, so values are left unvalidated.
const VercelProtectionBypassResponseSchema = z.object({
    protectionBypass: z.record(z.string(), z.unknown()),
});

const VercelDeploymentListItemSchema = z.object({
    uid: z.string(),
    url: z.string(),
    created: z.number(),
    // null on Vercel's side means "preview" - anything else (e.g. "production")
    // is passed through as-is.
    target: z.string().nullable().optional(),
    meta: z.object({ githubCommitRef: z.string().optional() }).optional(),
});

const VercelDeploymentListResponseSchema = z.object({
    deployments: z.array(VercelDeploymentListItemSchema),
});

const VercelEnvVarListItemSchema = z.object({ id: z.string(), key: z.string() });

const VercelEnvVarListResponseSchema = z.object({ envs: z.array(VercelEnvVarListItemSchema) });

const VercelDeploymentStateSchema = z.object({
    id: z.string(),
    url: z.string(),
    readyState: z.string(),
});

// ─── API calls ─────────────────────────────────────────────────────────────────

function withTeamId(url: string, teamId: string | undefined): string {
    return teamId != null ? `${url}?teamId=${teamId}` : url;
}

export async function fetchVercelProjectDetails(
    projectId: string,
    teamId: string | undefined,
    accessToken: string,
): Promise<{ name: string; productionUrl: string | undefined; githubRepoId: number | undefined }> {
    let res: Response;
    try {
        res = await fetch(withTeamId(`${VERCEL_API_BASE}/v9/projects/${projectId}`, teamId), {
            headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        });
    } catch (error) {
        throw new ThirdPartyError("vercel", error, "Network error fetching Vercel project details");
    }

    if (!res.ok) {
        throw new ThirdPartyError(
            "vercel",
            new Error(`${res.status} ${res.statusText}`),
            "Failed to fetch Vercel project details",
        );
    }

    const project = VercelProjectResponseSchema.parse(await res.json());

    const productionUrl =
        project.targets?.production?.url != null ? `https://${project.targets.production.url}` : undefined;
    const githubRepoId = project.link?.type === "github" ? project.link.repoId : undefined;

    return { name: project.name, productionUrl, githubRepoId };
}

export async function updateVercelProtectionBypass(
    projectId: string,
    teamId: string | undefined,
    accessToken: string,
): Promise<string> {
    logger.info("Updating protection bypass", { projectId, teamId });

    let res: Response;
    try {
        res = await fetch(withTeamId(`${VERCEL_API_BASE}/v1/projects/${projectId}/protection-bypass`, teamId), {
            method: "PATCH",
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({}),
        });
    } catch (error) {
        throw new ThirdPartyError("vercel", error, "Network error updating protection bypass");
    }

    if (!res.ok) {
        throw new ThirdPartyError(
            "vercel",
            new Error(`${res.status} ${res.statusText}`),
            "Failed to update protection bypass",
        );
    }

    const result = VercelProtectionBypassResponseSchema.parse(await res.json());
    const secret = Object.keys(result.protectionBypass).at(-1);

    if (secret == null) {
        throw new ThirdPartyError(
            "vercel",
            new Error("No secret found in response"),
            "Protection bypass response was empty",
        );
    }

    return secret;
}

async function findExistingVercelCheck(
    projectId: string,
    teamId: string | undefined,
    accessToken: string,
    vercelInstallationId: string,
): Promise<string | undefined> {
    let res: Response;
    try {
        res = await fetch(withTeamId(`${VERCEL_API_BASE}/v2/projects/${projectId}/checks`, teamId), {
            headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        });
    } catch (error) {
        throw new ThirdPartyError("vercel", error, "Network error listing Vercel checks");
    }

    if (!res.ok) {
        const body = await res.text();
        logger.warn("Failed to list Vercel checks, will attempt to register a new one", {
            projectId,
            status: res.status,
            body,
        });
        return undefined;
    }

    const { checks } = VercelCheckListResponseSchema.parse(await res.json());
    const existing = checks.find(
        (check) =>
            check.name === AUTONOMA_CHECK_NAME && check.sourceIntegrationConfigurationId === vercelInstallationId,
    );
    return existing?.id;
}

export async function registerVercelCheck(
    projectId: string,
    teamId: string | undefined,
    accessToken: string,
    vercelInstallationId: string,
): Promise<string | undefined> {
    logger.info("Registering Vercel check for project", { projectId });

    const existingCheckId = await findExistingVercelCheck(projectId, teamId, accessToken, vercelInstallationId);
    if (existingCheckId != null) {
        logger.info("Vercel check already registered for project, reusing it", { projectId, checkId: existingCheckId });
        return existingCheckId;
    }

    let res: Response;
    try {
        res = await fetch(withTeamId(`${VERCEL_API_BASE}/v2/projects/${projectId}/checks`, teamId), {
            method: "POST",
            headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                name: AUTONOMA_CHECK_NAME,
                isRequestable: false,
                requires: "build-ready",
                targets: ["production", "preview"],
                blocks: "none",
                source: {
                    kind: "integration",
                    integrationId: "autonoma-ai",
                    installationConfigurationId: vercelInstallationId,
                },
                timeout: 300,
            }),
        });
    } catch (error) {
        throw new ThirdPartyError("vercel", error, "Network error registering Vercel check");
    }

    if (!res.ok) {
        const body = await res.text();
        logger.warn("Failed to register Vercel check", { projectId, status: res.status, body });
        return undefined;
    }

    const data = VercelCheckResponseSchema.parse(await res.json());
    logger.info("Vercel check registered", { projectId, checkId: data.id });
    return data.id;
}

export async function listVercelDeployments(
    projectId: string,
    teamId: string | undefined,
    accessToken: string,
    limit: number = DEFAULT_DEPLOYMENT_LIST_LIMIT,
): Promise<VercelDeploymentSummary[]> {
    logger.info("Listing Vercel deployments", { projectId, limit });

    const url = withTeamId(`${VERCEL_API_BASE}/v6/deployments`, teamId);
    const params = new URLSearchParams({ projectId, limit: String(limit), state: "READY" });
    const joiner = url.includes("?") ? "&" : "?";

    let res: Response;
    try {
        res = await fetch(`${url}${joiner}${params.toString()}`, {
            headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        });
    } catch (error) {
        throw new ThirdPartyError("vercel", error, "Network error listing Vercel deployments");
    }

    if (!res.ok) {
        throw new ThirdPartyError(
            "vercel",
            new Error(`${res.status} ${res.statusText}`),
            "Failed to list Vercel deployments",
        );
    }

    const { deployments } = VercelDeploymentListResponseSchema.parse(await res.json());
    const summaries = deployments.map((deployment) => ({
        id: deployment.uid,
        url: `https://${deployment.url}`,
        target: deployment.target === "production" ? ("production" as const) : ("preview" as const),
        branch: deployment.meta?.githubCommitRef?.replace(/^refs\/heads\//, ""),
        createdAt: new Date(deployment.created).toISOString(),
    }));

    logger.info("Listed Vercel deployments", { projectId, count: summaries.length });
    return summaries;
}

/**
 * Redeploys an existing deployment so it rebuilds with the project's current env
 * vars (e.g. the `AUTONOMA_SHARED_SECRET` we inject on link, which only takes
 * effect on new builds). The redeploy gets a NEW id + URL and starts building
 * immediately; the caller polls `getVercelDeployment` until `readyState` is
 * "READY". `forceNew=1` bypasses Vercel's dedup so a re-pick always rebuilds.
 */
export async function redeployVercelDeployment(
    projectName: string,
    deploymentId: string,
    teamId: string | undefined,
    accessToken: string,
): Promise<VercelDeploymentState> {
    logger.info("Redeploying Vercel deployment", { projectName, deploymentId, teamId });

    const url = withTeamId(`${VERCEL_API_BASE}${VERCEL_DEPLOYMENT_CREATE_PATH}`, teamId);
    const joiner = url.includes("?") ? "&" : "?";

    let res: Response;
    try {
        res = await fetch(`${url}${joiner}forceNew=1`, {
            method: "POST",
            headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ name: projectName, deploymentId }),
        });
    } catch (error) {
        throw new ThirdPartyError("vercel", error, "Network error redeploying Vercel deployment");
    }

    if (!res.ok) {
        const body = await res.text();
        throw new ThirdPartyError(
            "vercel",
            new Error(`${res.status} ${res.statusText}: ${body}`),
            "Failed to redeploy Vercel deployment",
        );
    }

    const deployment = VercelDeploymentStateSchema.parse(await res.json());
    logger.info("Redeployed Vercel deployment", {
        projectName,
        deploymentId,
        newDeploymentId: deployment.id,
        readyState: deployment.readyState,
    });
    return { id: deployment.id, url: `https://${deployment.url}`, readyState: deployment.readyState };
}

/** Fetches a single deployment's current build state, for polling readiness after a redeploy. */
export async function getVercelDeployment(
    deploymentId: string,
    teamId: string | undefined,
    accessToken: string,
): Promise<VercelDeploymentState> {
    logger.info("Fetching Vercel deployment", { deploymentId, teamId });

    let res: Response;
    try {
        res = await fetch(withTeamId(`${VERCEL_API_BASE}${VERCEL_DEPLOYMENT_CREATE_PATH}/${deploymentId}`, teamId), {
            headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        });
    } catch (error) {
        throw new ThirdPartyError("vercel", error, "Network error fetching Vercel deployment");
    }

    if (!res.ok) {
        throw new ThirdPartyError(
            "vercel",
            new Error(`${res.status} ${res.statusText}`),
            "Failed to fetch Vercel deployment",
        );
    }

    const deployment = VercelDeploymentStateSchema.parse(await res.json());
    logger.info("Fetched Vercel deployment", { deploymentId, readyState: deployment.readyState });
    return { id: deployment.id, url: `https://${deployment.url}`, readyState: deployment.readyState };
}

async function findExistingVercelEnvVar(
    projectId: string,
    teamId: string | undefined,
    accessToken: string,
    key: string,
): Promise<string | undefined> {
    let res: Response;
    try {
        res = await fetch(withTeamId(`${VERCEL_API_BASE}/v9/projects/${projectId}/env`, teamId), {
            headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        });
    } catch (error) {
        throw new ThirdPartyError("vercel", error, "Network error listing Vercel env vars");
    }

    if (!res.ok) {
        const body = await res.text();
        logger.warn("Failed to list Vercel env vars, will attempt to create instead", {
            projectId,
            status: res.status,
            body,
        });
        return undefined;
    }

    const { envs } = VercelEnvVarListResponseSchema.parse(await res.json());
    return envs.find((env) => env.key === key)?.id;
}

/**
 * Creates or updates a Vercel project env var. Looks the key up first (Vercel's
 * create endpoint 409s on a duplicate key/target) so a re-link or a retried call
 * updates the existing value instead of failing.
 */
export async function upsertVercelEnvVar(
    projectId: string,
    teamId: string | undefined,
    accessToken: string,
    key: string,
    value: string,
    targets: string[],
): Promise<void> {
    logger.info("Upserting Vercel project env var", { projectId, key, targets });

    const existingEnvId = await findExistingVercelEnvVar(projectId, teamId, accessToken, key);

    const path =
        existingEnvId != null ? `/v10/projects/${projectId}/env/${existingEnvId}` : `/v10/projects/${projectId}/env`;
    const method = existingEnvId != null ? "PATCH" : "POST";
    const body =
        existingEnvId != null ? { value, target: targets } : { key, value, type: "encrypted", target: targets };

    let res: Response;
    try {
        res = await fetch(withTeamId(`${VERCEL_API_BASE}${path}`, teamId), {
            method,
            headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
    } catch (error) {
        throw new ThirdPartyError("vercel", error, "Network error upserting Vercel env var");
    }

    if (!res.ok) {
        const resBody = await res.text();
        throw new ThirdPartyError(
            "vercel",
            new Error(`${res.status} ${res.statusText}: ${resBody}`),
            "Failed to upsert Vercel env var",
        );
    }

    logger.info("Upserted Vercel project env var", { projectId, key, updated: existingEnvId != null });
}
