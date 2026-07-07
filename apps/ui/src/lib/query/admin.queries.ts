import type { AppRouter } from "@autonoma/api/router";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import type { inferRouterInputs } from "@trpc/server";
import { useAPIMutation } from "lib/query/api-queries";
import { trpc } from "lib/trpc";

type RouterInputs = inferRouterInputs<AppRouter>;
export type AdminPromoCodesInput = RouterInputs["admin"]["billing"]["listPromoCodes"];

export function useAdminOrganizations() {
    return useSuspenseQuery(trpc.admin.listOrganizations.queryOptions());
}

export function useAdminDeploymentConfig() {
    return useSuspenseQuery(trpc.admin.deploymentConfig.queryOptions());
}

export function useAdminPreviewkitEnvironments() {
    return useSuspenseQuery(trpc.admin.listPreviewkitEnvironments.queryOptions());
}

export function useRedeployPreviewkitEnvironment() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.admin.redeployPreviewkitEnvironment.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.admin.listPreviewkitEnvironments.queryKey() });
            },
        }),
        successToast: { title: "Redeploy triggered" },
        errorToast: { title: "Failed to trigger redeploy" },
    });
}

export function useRedeployPreviewkitApp() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.admin.redeployPreviewkitApp.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.admin.listPreviewkitEnvironments.queryKey() });
            },
        }),
        successToast: { title: "App redeploy triggered" },
        errorToast: { title: "Failed to trigger app redeploy" },
    });
}

export function usePreviewkitDeployableApplications() {
    return useSuspenseQuery(trpc.admin.listPreviewkitDeployableApplications.queryOptions());
}

export function useDeployPreviewkitMainBranch() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.admin.deployPreviewkitMainBranch.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.admin.listPreviewkitEnvironments.queryKey() });
            },
        }),
        successToast: { title: "Main branch deploy triggered" },
        errorToast: { title: "Failed to trigger deploy" },
    });
}

// Manual Environment Factory (admin) against a specific preview environment.
// The options query is lazy - it only runs while the popover is open, so it is
// a plain useQuery (not the page-level useSuspenseQuery) gated by `enabled`.
export function usePreviewkitEnvFactoryOptions(environmentId: string, enabled: boolean) {
    return useQuery({
        ...trpc.admin.previewkitEnvFactoryOptions.queryOptions({ environmentId }),
        enabled,
    });
}

export function usePreviewkitEnvFactoryUp() {
    return useAPIMutation({
        ...trpc.admin.previewkitEnvFactoryUp.mutationOptions(),
        errorToast: { title: "Failed to run up" },
    });
}

export function usePreviewkitEnvFactoryDown() {
    return useAPIMutation({
        ...trpc.admin.previewkitEnvFactoryDown.mutationOptions(),
        successToast: { title: "Environment torn down" },
        errorToast: { title: "Failed to run down" },
    });
}

export function useAdminPendingOrgs() {
    return useSuspenseQuery(trpc.admin.listPendingOrgs.queryOptions());
}

export function useAdminGitHubRepositories() {
    return useSuspenseQuery(trpc.admin.github.listRepositories.queryOptions());
}

export function useDownloadAdminGitHubRepository() {
    return useAPIMutation({
        ...trpc.admin.github.getRepositoryArchiveUrl.mutationOptions(),
        errorToast: { title: "Failed to download repository" },
    });
}

/**
 * Resolves which organizations own an application slug, across all orgs (returns
 * every owner, so the caller can auto-switch on a single match or show a chooser
 * when a slug lives in several of the user's orgs). Admin only - used to route
 * internal users into the right org when they open a cross-org deep link. Pass
 * `enabled: false` for non-admins so the admin-gated endpoint is never called.
 */
export function useOrgByAppSlug(appSlug: string, enabled: boolean) {
    return useQuery({
        ...trpc.admin.findOrgByAppSlug.queryOptions({ appSlug }),
        enabled,
    });
}

export function useSwitchToOrg() {
    return useAPIMutation({
        ...trpc.admin.switchToOrg.mutationOptions(),
        errorToast: { title: "Failed to switch organization" },
    });
}

export function useApproveOrg() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.admin.approveOrg.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.admin.listPendingOrgs.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.admin.listOrganizations.queryKey() });
            },
        }),
        successToast: { title: "Organization approved" },
        errorToast: { title: "Failed to approve organization" },
    });
}

export function useRejectOrg() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.admin.rejectOrg.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.admin.listPendingOrgs.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.admin.listOrganizations.queryKey() });
            },
        }),
        successToast: { title: "Organization rejected" },
        errorToast: { title: "Failed to reject organization" },
    });
}

export function useCreateOrg() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.admin.createOrg.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.admin.listOrganizations.queryKey() });
            },
        }),
        successToast: { title: "Organization created" },
        errorToast: { title: "Failed to create organization" },
    });
}

export function useAdminPromoCodes(input: AdminPromoCodesInput) {
    return useSuspenseQuery(trpc.admin.billing.listPromoCodes.queryOptions(input));
}

export function useCreatePromoCodeAdmin() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.admin.billing.createPromoCode.mutationOptions({
            onSuccess: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.admin.billing.listPromoCodes.queryKey() });
            },
        }),
        successToast: { title: "Promo code created" },
    });
}

export function useSetPromoCodeActiveAdmin() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.admin.billing.setPromoCodeActive.mutationOptions({
            onSuccess: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.admin.billing.listPromoCodes.queryKey() });
            },
        }),
        successToast: { title: "Promo code updated" },
    });
}
