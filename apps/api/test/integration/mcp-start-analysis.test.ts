import { randomBytes } from "node:crypto";
import { PostHogAnalytics } from "@autonoma/analytics";
import { ApplicationArchitecture } from "@autonoma/db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect } from "vitest";
import type { AnalysisRunTrigger, RequestRunOutcome, RequestRunParams } from "../../src/github/analysis-run-trigger";
import { MergeGateService } from "../../src/github/merge-gate.service";
import { registerDebugTools } from "../../src/mcp/debug-tools";
import { McpAnalytics } from "../../src/mcp/mcp-analytics";
import { resolveMcpPrincipal } from "../../src/mcp/mcp-principal";
import { resolveRepoContext } from "../../src/mcp/resolve-repo-context";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

interface CapturedEvent {
    event: string;
    properties?: Record<string, unknown>;
}

/** Records capture() calls so we can assert the merge-gate events without a live PostHog. */
class RecordingAnalytics extends PostHogAnalytics {
    public captures: CapturedEvent[] = [];

    override capture(
        _distinctId: string,
        event: string,
        properties?: Record<string, unknown>,
        _groups?: Record<string, string>,
    ): void {
        this.captures.push({ event, properties });
    }
}

/** Records the runs requested through the trigger so we can assert exactly one run was fired (and with what). */
class RecordingRunTrigger implements AnalysisRunTrigger {
    public calls: RequestRunParams[] = [];
    constructor(private readonly outcome: RequestRunOutcome = { started: true }) {}

    async requestRun(params: RequestRunParams): Promise<RequestRunOutcome> {
        this.calls.push(params);
        return this.outcome;
    }
}

const HEAD_SHA = "head-1";
const PR_NUMBER = 42;

apiTestSuite({
    name: "debug MCP start_analysis",
    seed: async ({ harness }) => {
        // resolveRepoContext's membership gate reads the `member` table, which the base harness does not populate.
        await harness.db.member.create({
            data: { userId: harness.userId, organizationId: harness.organizationId, role: "owner" },
        });
        // getPullRequest resolves the org's installation client; the fake app returns its defaultClient for any id.
        // installation_id is globally unique and the integration suites share one DB, so keep it random (the same
        // cross-suite uniqueness trick the harness uses for org slugs and emails). 3 bytes stays within int4.
        await harness.services.github.handleInstallation(
            9_000_000 + randomBytes(3).readUIntBE(0, 3),
            harness.organizationId,
            "test-org",
            999,
            "Organization",
        );
        return {};
    },
    cases: (test) => {
        test("start_analysis resolves the PR head and fires an mcp-sourced run, recording the activation", async ({
            harness,
        }) => {
            const analytics = new RecordingAnalytics();
            const trigger = new RecordingRunTrigger({ started: true });
            const fixture = await createRepoApp(harness);
            await setActivationGate(harness);

            const mergeGate = new MergeGateService(
                harness.db,
                harness.githubApp,
                true,
                analytics,
                harness.services.falsePositiveCandidates,
                undefined,
                trigger,
            );

            const result = await callStartAnalysis(harness, mergeGate, fixture.repoFullName, PR_NUMBER);

            // The tool reports the request back to the agent, naming the resolved head commit.
            expect(result.isError).not.toBe(true);
            const payload = parseToolText(result);
            expect(payload.status).toBe("requested");
            expect(payload.message).toContain(`PR ${PR_NUMBER}`);
            expect(payload.message).toContain(HEAD_SHA);

            // Exactly one run was fired, for this PR - the entrypoint's observable effect, not a mocked call.
            expect(trigger.calls).toHaveLength(1);
            expect(trigger.calls[0]).toMatchObject({
                organizationId: harness.organizationId,
                repoFullName: fixture.repoFullName,
                githubRepositoryId: fixture.repoId,
                prNumber: PR_NUMBER,
            });

            // The activation is persisted on the check row for the resolved head, sourced to MCP.
            const row = await harness.db.gitHubCheckRun.findUnique({
                where: { repoFullName_headSha: { repoFullName: fixture.repoFullName, headSha: HEAD_SHA } },
            });
            expect(row?.conclusion).toBe("in_progress");
            expect(row?.activationSource).toBe("mcp");
            expect(row?.activatedByLogin).toBe("autonoma-mcp");
            expect(row?.activatedAt).not.toBeNull();

            // The merge_gate.activated event carries the MCP source and the resolved head.
            const activated = analytics.captures.filter((capture) => capture.event === "merge_gate.activated");
            expect(activated).toHaveLength(1);
            expect(activated[0]?.properties).toMatchObject({
                organizationId: harness.organizationId,
                repoFullName: fixture.repoFullName,
                prNumber: PR_NUMBER,
                headSha: HEAD_SHA,
                source: "mcp",
                actorLogin: "autonoma-mcp",
            });
        });

        test("start_analysis no-ops without throwing when the org is not migrated to activation", async ({
            harness,
        }) => {
            const analytics = new RecordingAnalytics();
            const trigger = new RecordingRunTrigger({ started: true });
            const fixture = await createRepoApp(harness);
            // Gate enabled but activation off: an un-migrated org still runs automatically, so a request is a no-op.
            await setActivationGate(harness, { activationEnabled: false });

            const mergeGate = new MergeGateService(
                harness.db,
                harness.githubApp,
                true,
                analytics,
                harness.services.falsePositiveCandidates,
                undefined,
                trigger,
            );

            const result = await callStartAnalysis(harness, mergeGate, fixture.repoFullName, PR_NUMBER);

            // Still a clean, non-error result - the tool always returns the "requested" acknowledgement.
            expect(result.isError).not.toBe(true);
            expect(parseToolText(result).status).toBe("requested");

            // Nothing ran, nothing was recorded.
            expect(trigger.calls).toHaveLength(0);
            expect(analytics.captures.filter((capture) => capture.event === "merge_gate.activated")).toHaveLength(0);
        });
    },
});

interface RepoAppFixture {
    appId: string;
    repoId: number;
    repoFullName: string;
}

/** Create a fresh repo + linked application + preview env + open PR so each test resolves its own head. */
async function createRepoApp(harness: APITestHarness): Promise<RepoAppFixture> {
    const fakeClient = harness.githubApp.defaultClient;
    // Random (not a counter) so each test's repo is unique on the shared integration DB; 3 bytes stays within int4.
    const repoId = 500_000 + randomBytes(3).readUIntBE(0, 3);
    const repoFullName = `org/start-analysis-${repoId}`;

    fakeClient.addRepository({
        id: repoId,
        name: `start-analysis-${repoId}`,
        fullName: repoFullName,
        defaultBranch: "main",
        commits: ["base-1"],
    });
    fakeClient.addPullRequest(repoFullName, {
        number: PR_NUMBER,
        title: "Fix checkout",
        headRef: "feature/fix",
        baseSha: "base-1",
        commits: [HEAD_SHA],
    });

    const app = await harness.services.applications.createApplication({
        name: `start-analysis-${repoId}`,
        organizationId: harness.organizationId,
        architecture: ApplicationArchitecture.WEB,
        url: "https://example.com",
        file: "s3://bucket/file.png",
    });
    await harness.db.application.update({ where: { id: app.id }, data: { githubRepositoryId: repoId } });

    // The preview env is the fast path resolveRepoContext uses to map repoFullName -> org + app + repo id.
    await harness.db.previewkitEnvironment.create({
        data: {
            namespace: `preview-start-analysis-${randomBytes(4).toString("hex")}`,
            repoFullName,
            prNumber: PR_NUMBER,
            headSha: HEAD_SHA,
            headRef: "feature/fix",
            githubRepositoryId: repoId,
            organizationId: harness.organizationId,
        },
    });

    return { appId: app.id, repoId, repoFullName };
}

/** Enable the gate + analysis, and (by default) migrate the org to activation, on the shared org. */
async function setActivationGate(
    harness: APITestHarness,
    options: { activationEnabled?: boolean } = {},
): Promise<void> {
    const data = {
        analysisEnabled: true,
        mergeGateEnabled: true,
        activationEnabled: options.activationEnabled ?? true,
    };
    await harness.db.organizationSettings.upsert({
        where: { organizationId: harness.organizationId },
        create: { organizationId: harness.organizationId, ...data },
        update: data,
    });
}

/** Serve the debug tools over an in-memory transport and call `start_analysis` as a real MCP client would. */
async function callStartAnalysis(
    harness: APITestHarness,
    mergeGate: MergeGateService,
    repoFullName: string,
    prNumber: number,
) {
    const server = new McpServer({ name: "autonoma-debug", version: "0.0.0" });
    registerDebugTools(server, {
        services: harness.services,
        resolveRepoContext: async (repo) =>
            resolveRepoContext(
                { db: harness.db, listRepositories: (orgId) => harness.services.github.listRepositories(orgId) },
                await resolveMcpPrincipal(harness.db, { userId: harness.userId }),
                repo,
            ),
        listRepos: () => Promise.resolve({ repos: [], truncated: false, unreadable: [] }),
        analytics: new McpAnalytics(new PostHogAnalytics(), "debug", harness.userId),
        userId: harness.userId,
        mergeGate,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
        return await client.callTool({ name: "start_analysis", arguments: { repoFullName, prNumber } });
    } finally {
        await client.close();
        await server.close();
    }
}

/** The single text content block of a tool result, parsed back from its JSON payload. */
function parseToolText(result: Awaited<ReturnType<Client["callTool"]>>): { status?: string; message?: string } {
    const content = result.content;
    if (!Array.isArray(content)) throw new Error("tool result has no content array");
    const first = content[0];
    if (first == null || first.type !== "text") throw new Error("tool result is not text content");
    return JSON.parse(first.text);
}
