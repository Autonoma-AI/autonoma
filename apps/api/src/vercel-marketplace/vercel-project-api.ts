import { ThirdPartyError } from "@autonoma/errors";
import { logger as rootLogger } from "@autonoma/logger";
import { z } from "zod";

const logger = rootLogger.child({ name: "VercelProjectApi" });

const VERCEL_API_BASE = "https://api.vercel.com";
const AUTONOMA_CHECK_NAME = "Autonoma";

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
