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
import { useShellOrganizations, useSwitchOrganization } from "lib/query/app-shell.queries";

/**
 * Switches which organization this session is acting as. Renders as plain text for the common case
 * of a single organization, so the account menu does not grow a control that can only ever do nothing.
 *
 * The choice is session-scoped - it writes `session.activeOrganizationId`, so another browser stays
 * where it was and a fresh sign-in falls back to the default. A stored per-user preference is a
 * separate change.
 */
export function OrgSwitcher({ activeOrganizationName }: { activeOrganizationName: string }) {
  const { data: organizations } = useShellOrganizations();
  const switchOrganization = useSwitchOrganization();

  if (organizations.length <= 1) {
    return (
      <span className="truncate font-mono text-3xs uppercase tracking-widest text-text-secondary">
        {activeOrganizationName}
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 font-mono text-3xs uppercase tracking-widest text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary">
        <span className="truncate">{activeOrganizationName}</span>
        <CaretUpDownIcon size={11} className="shrink-0" />
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
