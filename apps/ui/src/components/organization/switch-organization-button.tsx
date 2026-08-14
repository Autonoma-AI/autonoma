import { Button } from "@autonoma/blacklight";
import { BuildingsIcon } from "@phosphor-icons/react/Buildings";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { myOrganizationsQueryOptions } from "lib/query/organization.queries";

/**
 * A way out for the screens that render outside the app shell, and therefore outside the bar that carries the
 * organization switcher: `/pending`, `/rejected`, and the onboarding flow.
 *
 * Each of those is reachable while the session points at an organization the reader cannot use - one awaiting
 * approval, one that was rejected, one with no applications yet - and each offered nothing but Sign out. An
 * admin walked past them (`_app-shell/route.tsx` exempts `/admin`, which can switch); a member in a second,
 * perfectly good organization could not reach it.
 *
 * It links to the existing full-page picker rather than growing a second switcher: `/choose-organization`
 * already reads the list, writes the choice and forwards straight through for an account with one
 * organization, so there is one implementation of switching outside the bar rather than two.
 *
 * A plain `useQuery`, not `useSuspenseQuery`: these screens make no other server read, and suspending one on a
 * control that most readers never see would hold up the only thing on the page that matters.
 */
export function SwitchOrganizationButton({ size = "default" }: { size?: "default" | "xs" }) {
  const { data: organizations } = useQuery(myOrganizationsQueryOptions());

  // Nothing to switch to - and `undefined` while the read is in flight, so the button appears once there is
  // somewhere to go rather than flickering out.
  if (organizations == null || organizations.length <= 1) return undefined;

  return (
    // `nativeButton={false}` because this renders an anchor: Base UI otherwise warns that it has lost native
    // button semantics. An anchor is what we want here - it is navigation, so cmd-click and the context menu
    // should work.
    <Button
      variant="outline"
      size={size}
      nativeButton={false}
      render={<Link to="/choose-organization" />}
      className="gap-1.5"
    >
      <BuildingsIcon size={14} />
      Switch organization
    </Button>
  );
}
