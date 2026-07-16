import type { RouterOutputs } from "lib/trpc";
import { makeOrganization, makeSession } from "./auth-fixtures";
import { authHandlers } from "./auth-handlers";
import type { TrpcFixtures } from "./trpc-handler";
import { trpcHandler } from "./trpc-handler";

const FIXTURE_EPOCH = new Date("2026-01-01T00:00:00.000Z");
const ORG_ID = "org_fixture_01";

/**
 * One realistic WEB application, shaped exactly like `applications.list`
 * returns it. Stories can reference its slug ("acme-web") in page paths.
 */
export const baseApplication: RouterOutputs["applications"]["list"][number] = {
    id: "app_fixture_01",
    name: "Acme Web",
    slug: "acme-web",
    architecture: "WEB",
    customInstructions: null,
    testScopeGuidelines: null,
    disabled: false,
    githubRepositoryId: 123456,
    mainBranchId: "branch_fixture_01",
    signingSecretEnc: null,
    createdAt: FIXTURE_EPOCH,
    updatedAt: FIXTURE_EPOCH,
    organizationId: ORG_ID,
    mainBranch: {
        name: "main",
        deployment: {
            id: "deployment_fixture_01",
            active: true,
            branchId: "branch_fixture_01",
            webhookUrl: null,
            webhookHeaders: null,
            createdAt: FIXTURE_EPOCH,
            updatedAt: FIXTURE_EPOCH,
            organizationId: ORG_ID,
            webDeployment: {
                deploymentId: "deployment_fixture_01",
                url: "https://app.acme.example.com",
                file: "",
                createdAt: FIXTURE_EPOCH,
                updatedAt: FIXTURE_EPOCH,
                organizationId: ORG_ID,
            },
            mobileDeployment: null,
        },
    },
    onboardingState: { step: "completed" },
};

const baseTrpcFixtures: TrpcFixtures = {
    auth: { orgStatus: "approved" },
    applications: { list: [baseApplication] },
    github: { getInstallation: null },
    billing: {
        status: {
            creditBalance: 740,
            subscriptionCreditBalance: 500,
            topupCreditBalance: 240,
            subscriptionStatus: "active",
            currentPeriodEnd: new Date("2026-02-01T00:00:00.000Z"),
            cancelAtPeriodEnd: false,
            gracePeriodEndsAt: undefined,
            autoTopUpEnabled: false,
            autoTopUpThreshold: 0,
            cliCreditsSpent: 60,
            transactions: [],
        },
    },
};

/**
 * MSW handlers that satisfy the app-shell guards (session, active org,
 * approved org status, one application) so any page under the shell renders.
 * Page-specific tRPC fixtures deep-merge over the baseline.
 */
export function appShellHandlers(pageFixtures: TrpcFixtures = {}) {
    return [
        trpcHandler(mergeTrpcFixtures(baseTrpcFixtures, pageFixtures)),
        ...authHandlers({ session: makeSession(), organizations: [makeOrganization()] }),
    ];
}

function mergeTrpcFixtures(base: TrpcFixtures, extra: TrpcFixtures): TrpcFixtures {
    const merged: TrpcFixtures = { ...base };
    for (const key of Object.keys(extra)) {
        const router = key satisfies string;
        Object.assign(merged, { [router]: { ...Reflect.get(base, router), ...Reflect.get(extra, router) } });
    }
    return merged;
}
