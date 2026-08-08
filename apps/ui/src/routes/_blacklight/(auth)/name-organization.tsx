import { Button, Input, Skeleton } from "@autonoma/blacklight";
import { BuildingsIcon } from "@phosphor-icons/react/Buildings";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { safeRedirectTo } from "lib/auth-redirect";
import { ensureAPIQueryData } from "lib/query/api-queries";
import { activeOrgQueryOptions } from "lib/query/auth.queries";
import { useRenameOrganization } from "lib/query/organization.queries";
import { Suspense, useState } from "react";

/**
 * Asks for a real organization name, once.
 *
 * An organization created from a personal email address is named after whoever signed up first, and
 * that person is not necessarily whose organization it is - the first person through the door is
 * often an engineer setting things up for a team. The field is prefilled with the current name, so
 * keeping it is one click.
 *
 * Unlike the organization picker this *is* reachable as a guard from the app shell, because
 * "already answered" is durable state (`organization.nameConfirmedAt`) rather than something that
 * would need remembering per session.
 */
export const Route = createFileRoute("/_blacklight/(auth)/name-organization")({
  validateSearch: (search: Record<string, unknown>): { redirectTo?: string } => {
    if (typeof search.redirectTo === "string") return { redirectTo: search.redirectTo };
    return {};
  },
  loaderDeps: ({ search: { redirectTo } }) => ({ redirectTo }),
  loader: async ({ context: { queryClient }, deps: { redirectTo } }) => {
    const activeOrg = await ensureAPIQueryData(queryClient, activeOrgQueryOptions());
    if (activeOrg == null) throw redirect({ to: "/login", search: { error: undefined } });
    // Already named, or an organization that never asks. Nothing to do here.
    if (!activeOrg.needsNaming) throw redirect({ href: safeRedirectTo(redirectTo) });
    return { name: activeOrg.name, organizationId: activeOrg.id };
  },
  pendingComponent: () => (
    <NameOrgFrame>
      <Skeleton className="h-10 w-full" />
    </NameOrgFrame>
  ),
  component: NameOrganizationPage,
});

function NameOrganizationPage() {
  return (
    <Suspense
      fallback={
        <NameOrgFrame>
          <Skeleton className="h-10 w-full" />
        </NameOrgFrame>
      }
    >
      <NameOrganizationForm />
    </Suspense>
  );
}

function NameOrganizationForm() {
  const { name, organizationId } = Route.useLoaderData();
  const { redirectTo } = Route.useSearch();
  const [value, setValue] = useState(name);
  const renameOrganization = useRenameOrganization();
  const navigate = useNavigate();
  const trimmed = value.trim();

  function submit() {
    if (trimmed.length === 0) return;
    renameOrganization.mutate(
      { organizationId, name: trimmed },
      { onSuccess: () => void navigate({ href: safeRedirectTo(redirectTo) }) },
    );
  }

  return (
    <NameOrgFrame>
      <form
        className="flex w-full flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Input
          // The whole point is to make replacing the prefilled guess effortless.
          autoFocus
          aria-label="Organization name"
          placeholder="Acme Inc."
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <Button type="submit" variant="accent" disabled={trimmed.length === 0 || renameOrganization.isPending}>
          {renameOrganization.isPending ? "Saving..." : "Continue"}
        </Button>
      </form>
    </NameOrgFrame>
  );
}

function NameOrgFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-surface-void">
      <div className="flex w-full max-w-md flex-col items-center gap-6 px-6 text-center">
        <div className="flex size-12 items-center justify-center border border-border-mid bg-surface-base">
          <BuildingsIcon size={22} className="text-primary" />
        </div>
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-2xl font-medium text-text-primary">Name your organization</h1>
          <p className="font-mono text-sm text-text-secondary">
            This is what your team will see. You can change it later in settings.
          </p>
        </div>
        {children}
      </div>
    </div>
  );
}
