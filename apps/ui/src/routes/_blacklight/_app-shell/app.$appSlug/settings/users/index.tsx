import { createFileRoute } from "@tanstack/react-router";
import { MembersPanel } from "components/organization/members-panel";
import {
  YourOrganizationsPanel,
  YourOrganizationsPanelSkeleton,
} from "components/organization/your-organizations-panel";
import { RouteErrorState } from "components/route-error-state";
import { Suspense } from "react";
import { OrgScopeNote } from "../-org-scope-note";

/**
 * Reachable for every organization, deliberately.
 *
 * This was once hidden for an organization anyone can auto-join by email domain, on the grounds that
 * invitations there are redundant. That reasoning only covered colleagues who share the domain, and
 * it created a trap: someone invited into such an organization could join it and then had no UI to
 * leave it, because `Leave` lives on this page. Inviting an address that would auto-join anyway is
 * still refused - by the server, with an error that explains why, which is the right place for it.
 */
export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/settings/users/")({
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
