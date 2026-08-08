import { Skeleton } from "@autonoma/blacklight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { BuildingsIcon } from "@phosphor-icons/react/Buildings";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { safeRedirectTo } from "lib/auth-redirect";
import { ensureSessionData } from "lib/query/auth.queries";
import { ensureMyOrganizationsData, useMyOrganizations, useSwitchOrganization } from "lib/query/organization.queries";
import { Suspense } from "react";

/**
 * Where sign-in lands, so someone in several organizations picks which one before the app renders.
 *
 * This is part of the login redirect chain rather than a guard over the app: making it a guard would
 * need somewhere to record "already chosen", and the choice is deliberately not persisted yet. An
 * account with one organization never sees it - the loader forwards straight through - so the extra
 * hop costs nothing for the common case.
 */
export const Route = createFileRoute("/_blacklight/(auth)/choose-organization")({
  validateSearch: (search: Record<string, unknown>): { redirectTo?: string } => {
    if (typeof search.redirectTo === "string") return { redirectTo: search.redirectTo };
    return {};
  },
  loaderDeps: ({ search: { redirectTo } }) => ({ redirectTo }),
  beforeLoad: async ({ context: { queryClient } }) => {
    const session = await ensureSessionData(queryClient);
    if (session == null) throw redirect({ to: "/login", search: { error: undefined } });
  },
  loader: async ({ context: { queryClient }, deps: { redirectTo } }) => {
    const organizations = await ensureMyOrganizationsData(queryClient);
    // Nothing to choose between. `href` rather than `to` because the destination is an arbitrary
    // validated path, not a route this file can name.
    if (organizations.length <= 1) throw redirect({ href: safeRedirectTo(redirectTo) });
  },
  pendingComponent: () => (
    <ChooseOrgFrame>
      <Skeleton className="h-32 w-full" />
    </ChooseOrgFrame>
  ),
  component: ChooseOrganizationPage,
});

function ChooseOrganizationPage() {
  return (
    <Suspense
      fallback={
        <ChooseOrgFrame>
          <Skeleton className="h-32 w-full" />
        </ChooseOrgFrame>
      }
    >
      <OrganizationChoices />
    </Suspense>
  );
}

function OrganizationChoices() {
  const { redirectTo } = Route.useSearch();
  const { data: organizations } = useMyOrganizations();
  const switchOrganization = useSwitchOrganization();
  const navigate = useNavigate();

  function choose(organizationId: string, isActive: boolean) {
    // The session already points here, so there is nothing to write - just go.
    if (isActive) {
      void navigate({ href: safeRedirectTo(redirectTo) });
      return;
    }

    switchOrganization.mutate(
      { organizationId },
      {
        onSuccess: () => void navigate({ href: safeRedirectTo(redirectTo) }),
      },
    );
  }

  return (
    <ChooseOrgFrame>
      <div className="flex w-full flex-col divide-y divide-border-dim border border-border-dim">
        {organizations.map((organization) => (
          <button
            key={organization.id}
            type="button"
            disabled={switchOrganization.isPending}
            onClick={() => choose(organization.id, organization.isActive)}
            className="group flex items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-raised disabled:opacity-60"
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-sm font-medium text-text-primary">{organization.name}</span>
              <span className="font-mono text-3xs text-text-secondary">
                {organization.memberCount === 1 ? "1 member" : `${organization.memberCount} members`} ·{" "}
                {organization.applicationCount === 1
                  ? "1 application"
                  : `${organization.applicationCount} applications`}
              </span>
            </div>
            <ArrowRightIcon
              size={14}
              className="shrink-0 text-text-secondary transition-colors group-hover:text-text-primary"
            />
          </button>
        ))}
      </div>
    </ChooseOrgFrame>
  );
}

function ChooseOrgFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-surface-void">
      <div className="flex w-full max-w-md flex-col items-center gap-6 px-6 text-center">
        <div className="flex size-12 items-center justify-center border border-border-mid bg-surface-base">
          <BuildingsIcon size={22} className="text-primary" />
        </div>
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-2xl font-medium text-text-primary">Choose an organization</h1>
          <p className="font-mono text-sm text-text-secondary">
            You belong to more than one. You can switch any time from the sidebar.
          </p>
        </div>
        {children}
      </div>
    </div>
  );
}
