import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@autonoma/blacklight";
import { ChatCircleDotsIcon } from "@phosphor-icons/react/ChatCircleDots";
import { CreditCardIcon } from "@phosphor-icons/react/CreditCard";
import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { GridFourIcon } from "@phosphor-icons/react/GridFour";
import { ShieldCheckIcon } from "@phosphor-icons/react/ShieldCheck";
import { SignOutIcon } from "@phosphor-icons/react/SignOut";
import { Link, useLocation, useRouteContext } from "@tanstack/react-router";
import { IsolatedErrorBoundary } from "components/isolated-error-boundary";
import { useAuth, useAuthClient } from "lib/auth";
import { Suspense } from "react";
import { OrgSwitcher } from "./org-switcher";
import { useAppNav } from "./use-app-nav";

/**
 * Everything about you and your organization, in one place at the end of the bar: who you are signed in as,
 * where billing is, the admin doors, and the way out.
 *
 * Settings live here too rather than beside the sections. They are a destination you go to occasionally and
 * come back from, not one of the places you move between while working, and giving them a pill would have said
 * they were a peer of Home and Tests.
 *
 * **Settings and billing carry no scope heading, and that is deliberate.** They sat under `Application` and
 * `Organization` respectively, which claimed a split the destination does not have: the settings page holds
 * application sections and organization ones side by side, and billing is one of the organization sections
 * inside it. Two headings promising two scopes, both leading into the same page, said the product was
 * organized in a way it is not. `Admin` keeps its heading because it genuinely is a different scope - the
 * console spans every application rather than this one.
 */
export function AccountMenu({ onFeedback }: { onFeedback: () => void }) {
  const { user, isAdmin } = useAuth();
  const authClient = useAuthClient();
  const activeOrganization = useRouteContext({
    from: "/_blacklight/_app-shell",
    select: (ctx) => ctx.activeOrganization,
  });
  const { pathname } = useLocation();
  const { settings, billing } = useAppNav();
  const isAdminPage = pathname === "/admin" || pathname.startsWith("/admin/");

  const displayName = user?.name ?? user?.email ?? "User";

  // A full page load rather than a router navigation: signing out has to drop every cached query with it, and
  // the router would keep the client alive across the transition.
  const handleSignOut = () => {
    void authClient.signOut().then(() => {
      window.location.href = "/login";
    });
  };

  return (
    <DropdownMenu>
      {/* The avatar and the name, rather than a bordered square holding one letter. On its own the initial
          read as a control you press to do something - it looked like every other icon button in the product -
          where a face and a name read as who you are signed in as, which is what the menu is about. The name
          hides below `xl` for the same measured reason the disclaimer pill does: it costs ~100px, and below
          1280 the bar spends that by squeezing the application switcher. An avatar alone still does not look
          like an action. */}
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="xs" aria-label={`Account: ${displayName}`} className="shrink-0 gap-2" />}
      >
        <AccountAvatar name={displayName} image={user?.image ?? undefined} />
        <span className="hidden max-w-28 truncate text-text-secondary xl:block">{displayName}</span>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-64">
        <div className="flex flex-col gap-0.5 px-3 py-2.5">
          <span className="truncate text-xs font-medium text-text-primary">{displayName}</span>
          {user?.email != null && <span className="truncate font-mono text-3xs text-text-secondary">{user.email}</span>}
          {/* The rail made the organization name a switcher; this is where that went. It renders as plain
              text for the single-organization case, so it only becomes a control for someone who has
              somewhere to switch to.

              Boundaries because it reads with `useSuspenseQuery` and only mounts when the menu opens: the
              rail resolved that during the page load, but here it would suspend mid-interaction, and with
              nothing to catch it the throw lands on the route. Both fall back to the name as text, which is
              what a single-organization reader sees anyway. */}
          <IsolatedErrorBoundary fallback={() => <ActiveOrganizationName name={activeOrganization.name} />}>
            <Suspense fallback={<ActiveOrganizationName name={activeOrganization.name} />}>
              <OrgSwitcher activeOrganizationName={activeOrganization.name} />
            </Suspense>
          </IsolatedErrorBoundary>
        </div>

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          {settings != null && (
            <DropdownMenuItem render={<Link to={settings.href} />}>
              <GearSixIcon size={14} />
              {settings.label}
            </DropdownMenuItem>
          )}
          {/* A section of the settings page, listed again at the top level because someone hunting for an
              invoice looks for the word rather than for Settings. Not gated on the subscription status the way
              the upgrade button is: an organization that already pays is exactly the one that comes looking. */}
          {billing != null && (
            <DropdownMenuItem render={<Link to={billing.href} />}>
              <CreditCardIcon size={14} />
              {billing.label}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={onFeedback}>
            <ChatCircleDotsIcon size={14} />
            Send feedback
          </DropdownMenuItem>
        </DropdownMenuGroup>

        {isAdmin && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {/* Only the scope switch. This application's own admin view is a tab in the bar, beside the
                  sections it belongs with; what is left here is the move between one application and the
                  console that spans all of them. */}
              <DropdownMenuGroupLabel>Admin</DropdownMenuGroupLabel>
              {isAdminPage ? (
                <DropdownMenuItem render={<Link to="/" />}>
                  <GridFourIcon size={14} />
                  Back to apps
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem render={<Link to="/admin" />}>
                  <ShieldCheckIcon size={14} />
                  Admin console
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
          </>
        )}

        <DropdownMenuSeparator />

        <DropdownMenuItem onClick={handleSignOut} className="text-text-secondary hover:text-status-critical">
          <SignOutIcon size={14} />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The organization as a label - what the switcher itself renders when there is nowhere to switch to. */
function ActiveOrganizationName({ name }: { name: string }) {
  return <span className="truncate font-mono text-3xs uppercase tracking-widest text-text-secondary">{name}</span>;
}

/**
 * Square and bordered rather than a circle, matching the GitHub authors on the pull request list - they are the
 * only other faces in the product, and two shapes for the same idea would read as two different things.
 *
 * `alt` is empty because the name renders beside it: a screen reader that announced both would say it twice, and
 * the trigger's own `aria-label` already carries it for the widths where the name is hidden.
 */
function AccountAvatar({ name, image }: { name: string; image?: string }) {
  if (image != null) {
    return <img src={image} alt="" className="size-5 shrink-0 border border-border-dim object-cover" />;
  }

  return (
    <span className="grid size-5 shrink-0 place-items-center border border-border-dim font-mono text-3xs uppercase text-text-secondary">
      {name.slice(0, 1)}
    </span>
  );
}
