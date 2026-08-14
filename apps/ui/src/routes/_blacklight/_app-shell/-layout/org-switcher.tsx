import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@autonoma/blacklight";
import { CaretUpDownIcon } from "@phosphor-icons/react/CaretUpDown";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { IsolatedErrorBoundary } from "components/isolated-error-boundary";
import { useShellOrganizations, useSwitchOrganization } from "lib/query/app-shell.queries";
import { Suspense } from "react";

/**
 * Switches which organization this session is acting as. Renders as plain text for the common case of a single
 * organization, so the bar does not grow a control that can only ever do nothing.
 *
 * It lives in the bar rather than inside the account menu, and the second reason is a correctness one. A
 * `DropdownMenu` inside that menu's popup is a Base UI `Menu.Root` with no parent - only `Menu.SubmenuRoot`
 * inherits one - so it opens as an independent modal menu that lays its own backdrop over the menu it is
 * standing in, and a press on one of its items fires `onClick` twice, submitting the switch twice.
 *
 * The choice is session-scoped - it writes `session.activeOrganizationId`, so another browser stays where it
 * was and a fresh sign-in falls back to the default. A stored per-user preference is a separate change.
 *
 * Both boundaries live here rather than at the two call sites, so neither bar can render the switcher without
 * them. `Suspense` alone would not be enough: `useShellOrganizations` reads with `useSuspenseQuery`, which
 * throws a *failed* fetch rather than suspending on it, and there is no boundary between here and the route -
 * so a 500 on `organization.mine` would replace the whole bar with a retry screen. Both degrade to the name as
 * text, which is what a single-organization reader sees anyway.
 */
export function OrgSwitcher({ activeOrganizationName }: { activeOrganizationName: string }) {
  const label = <OrgSwitcherLabel name={activeOrganizationName} />;

  return (
    <IsolatedErrorBoundary fallback={() => label}>
      <Suspense fallback={label}>
        <OrgSwitcherMenu activeOrganizationName={activeOrganizationName} />
      </Suspense>
    </IsolatedErrorBoundary>
  );
}

function OrgSwitcherMenu({ activeOrganizationName }: { activeOrganizationName: string }) {
  const { data: organizations } = useShellOrganizations();
  const switchOrganization = useSwitchOrganization();

  if (organizations.length <= 1) return <OrgSwitcherLabel name={activeOrganizationName} />;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Switch organization (current: ${activeOrganizationName})`}
        className="flex h-full min-w-0 max-w-48 items-center gap-1.5 px-1.5 text-sm text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary"
      >
        <span className="min-w-0 truncate">{activeOrganizationName}</span>
        <CaretUpDownIcon size={12} className="shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[70vh] overflow-y-auto">
        {/* GroupLabel must live inside a Group - Base UI throws error #31 when it does not, at open. */}
        <DropdownMenuGroup>
          <DropdownMenuGroupLabel className="font-mono text-3xs uppercase tracking-widest text-text-secondary">
            Your organizations
          </DropdownMenuGroupLabel>
          {organizations.map((organization) => (
            <DropdownMenuItem
              key={organization.id}
              disabled={organization.isActive || switchOrganization.isPending}
              onClick={() => switchOrganization.mutate({ organizationId: organization.id })}
            >
              <span className="truncate">{organization.name}</span>
              {organization.isActive && <CheckIcon size={12} className="ml-auto shrink-0 text-primary" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The organization as a label - what the switcher renders when there is nowhere to switch to, and what stands
 * in for it when the list is in flight or could not be read. Same box as the trigger minus the caret, so the
 * name does not move when the query lands.
 */
function OrgSwitcherLabel({ name }: { name: string }) {
  return (
    <span className="flex h-full min-w-0 max-w-48 items-center px-1.5 text-sm text-text-secondary">
      <span className="min-w-0 truncate">{name}</span>
    </span>
  );
}
