import { createFileRoute, redirect } from "@tanstack/react-router";
import { MembersPanel } from "components/organization/members-panel";
import {
  YourOrganizationsPanel,
  YourOrganizationsPanelSkeleton,
} from "components/organization/your-organizations-panel";
import { RouteErrorState } from "components/route-error-state";
import { ensureAPIQueryData } from "lib/query/api-queries";
import { trpc } from "lib/trpc";
import { Suspense } from "react";
import { OrgScopeNote } from "../-org-scope-note";
import { isSettingsEntryVisible, toSettingsVisibility } from "../-settings-rail";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/settings/users/")({
  // The rail hides this entry behind the same predicate. Typing the URL in directly has to be refused
  // too, so both gates read from one definition rather than each restating what an auto-join org means.
  loader: async ({ context, params: { appSlug } }) => {
    const activeOrg = await ensureAPIQueryData(context.queryClient, trpc.auth.activeOrg.queryOptions());
    if (!isSettingsEntryVisible("users", toSettingsVisibility(activeOrg))) {
      throw redirect({ to: "/app/$appSlug/settings", params: { appSlug } });
    }
  },
  errorComponent: ({ reset }) => <RouteErrorState message="We couldn't load your members." reset={reset} />,
  component: UsersPage,
});

function UsersPage() {
  return (
    <div className="flex flex-col gap-4">
      <OrgScopeNote>Members can see and change every application here.</OrgScopeNote>
      <MembersPanel />
      <Suspense fallback={<YourOrganizationsPanelSkeleton />}>
        <YourOrganizationsPanel />
      </Suspense>
    </div>
  );
}
