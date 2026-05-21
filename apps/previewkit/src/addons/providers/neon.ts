import { z } from "zod";
import { logger as rootLogger, type Logger } from "../../logger";
import type { AddonProvider, DeprovisionInput, ProvisionInput, ProvisionResult } from "../provider";

const NEON_API_BASE = "https://console.neon.tech/api/v2";

// `parent_branch_id` is intentionally optional: when omitted, Neon's API
// branches off the project's primary branch, which is the right default for
// previewkit users who don't want to memorise branch ids.
const neonOptionsSchema = z.object({
    project_id: z.string().min(1, "project_id is required"),
    parent_branch_id: z.string().optional(),
    database_name: z.string().default("neondb"),
    role_name: z.string().default("neondb_owner"),
});

// `token` is the conventional key inside the org-secret JSON map. Other
// providers will pick different keys; the contract is per-provider.
const neonAuthSchema = z.object({
    token: z.string().min(1, "Neon auth secret must contain a non-empty `token` key"),
});

const neonStateSchema = z.object({
    branchId: z.string(),
    endpointId: z.string().optional(),
});

// Minimal shape of the response payloads we read. Neon returns more
// fields; we only consume what we need so future API additions don't
// require schema updates.
const branchCreateResponseSchema = z.object({
    branch: z.object({ id: z.string() }),
    endpoints: z
        .array(z.object({ id: z.string(), host: z.string() }))
        .min(1, "Neon returned a branch with no endpoints — refusing to continue"),
});

const connectionUriResponseSchema = z.object({ uri: z.string() });

export class NeonProvider implements AddonProvider {
    readonly name = "neon";

    private readonly logger: Logger;
    private readonly apiBase: string;

    constructor(apiBase: string = NEON_API_BASE) {
        this.apiBase = apiBase;
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    async provision(input: ProvisionInput): Promise<ProvisionResult> {
        const options = neonOptionsSchema.parse(input.options);
        const auth = neonAuthSchema.parse(input.authSecret);
        const branchName = `previewkit-pr-${input.prNumber}`;

        this.logger.info("Provisioning Neon branch", {
            projectId: options.project_id,
            branchName,
            parentBranchId: options.parent_branch_id,
            namespace: input.namespace,
        });

        const createBody: Record<string, unknown> = {
            branch: { name: branchName },
            endpoints: [{ type: "read_write" }],
        };
        if (options.parent_branch_id != null) {
            (createBody.branch as Record<string, unknown>).parent_id = options.parent_branch_id;
        }

        const created = branchCreateResponseSchema.parse(
            await this.fetchJson("POST", `/projects/${options.project_id}/branches`, auth.token, createBody),
        );
        const branchId = created.branch.id;
        const endpoint = created.endpoints[0]!;

        const params = new URLSearchParams({
            branch_id: branchId,
            database_name: options.database_name,
            role_name: options.role_name,
        });
        const conn = connectionUriResponseSchema.parse(
            await this.fetchJson("GET", `/projects/${options.project_id}/connection_uri?${params}`, auth.token),
        );

        this.logger.info("Neon branch provisioned", { projectId: options.project_id, branchId });

        return {
            outputs: {
                connectionString: conn.uri,
                host: endpoint.host,
                database: options.database_name,
            },
            state: { branchId, endpointId: endpoint.id } satisfies z.infer<typeof neonStateSchema>,
        };
    }

    async deprovision(input: DeprovisionInput): Promise<void> {
        const options = neonOptionsSchema.parse(input.options);
        const auth = neonAuthSchema.parse(input.authSecret);
        const state = neonStateSchema.parse(input.state);

        this.logger.info("Deprovisioning Neon branch", {
            projectId: options.project_id,
            branchId: state.branchId,
        });

        await this.fetchJson("DELETE", `/projects/${options.project_id}/branches/${state.branchId}`, auth.token);

        this.logger.info("Neon branch deprovisioned", { branchId: state.branchId });
    }

    private async fetchJson(
        method: "GET" | "POST" | "DELETE",
        path: string,
        token: string,
        body?: unknown,
    ): Promise<unknown> {
        const url = `${this.apiBase}${path}`;
        const res = await fetch(url, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: body != null ? JSON.stringify(body) : undefined,
        });

        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`Neon API ${method} ${path} failed (${res.status}): ${text || res.statusText}`);
        }

        // DELETE returns 200 with a JSON body too, but treat empty 204s safely.
        if (res.status === 204) return {};
        return res.json();
    }
}
