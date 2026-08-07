import { cn } from "@autonoma/blacklight";
import { BroadcastIcon } from "@phosphor-icons/react/Broadcast";
import { BrowsersIcon } from "@phosphor-icons/react/Browsers";
import { CreditCardIcon } from "@phosphor-icons/react/CreditCard";
import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { GithubLogoIcon } from "@phosphor-icons/react/GithubLogo";
import { KeyIcon } from "@phosphor-icons/react/Key";
import type { Icon } from "@phosphor-icons/react/lib";
import { LightningIcon } from "@phosphor-icons/react/Lightning";
import { Link } from "@tanstack/react-router";
import { useActiveOrg } from "lib/query/auth.queries";

type SettingsEntryId = "general" | "triggers" | "scenarios" | "previews" | "billing" | "api-keys" | "github";

/**
 * Entries carry a description, not just a label, because the failure this rail replaces was people not
 * knowing what a destination was from its name alone - a tab bar can only ever show the word.
 *
 * The groups are load-bearing rather than decorative. Billing, API keys and the GitHub App are
 * organization state reached from an application's URL, so without a heading saying so, changing them from
 * one application and having it apply to all of them is invisible - which is the exact complaint that put
 * them on this list.
 */
const APPLICATION_ENTRIES = [
  {
    id: "general",
    label: "General",
    description: "What this app is, and how agents test it",
    icon: GearSixIcon,
    to: "/app/$appSlug/settings",
    exact: true,
  },
  {
    id: "triggers",
    label: "Triggers",
    description: "When a run starts",
    icon: LightningIcon,
    to: "/app/$appSlug/settings/triggers",
    exact: false,
  },
  {
    id: "scenarios",
    label: "Scenarios & SDK",
    description: "The endpoint Autonoma calls for test data",
    icon: BroadcastIcon,
    to: "/app/$appSlug/settings/scenarios",
    exact: false,
  },
  {
    id: "previews",
    label: "Previews",
    description: "How preview environments are built",
    icon: BrowsersIcon,
    to: "/app/$appSlug/settings/previews",
    exact: false,
  },
] as const satisfies readonly SettingsEntry[];

const ORGANIZATION_ENTRIES = [
  {
    id: "billing",
    label: "Billing",
    description: "Credits, plan and top-ups",
    icon: CreditCardIcon,
    to: "/app/$appSlug/settings/billing",
    exact: false,
  },
  {
    id: "api-keys",
    label: "API keys",
    description: "Authenticate the CLI and the API",
    icon: KeyIcon,
    to: "/app/$appSlug/settings/api-keys",
    exact: false,
  },
  {
    id: "github",
    label: "GitHub App",
    description: "The installation every repository connects through",
    icon: GithubLogoIcon,
    to: "/app/$appSlug/settings/github",
    exact: false,
  },
] as const satisfies readonly SettingsEntry[];

interface SettingsEntry {
  id: SettingsEntryId;
  label: string;
  description: string;
  icon: Icon;
  to: string;
  exact: boolean;
}

/** Entries hidden unless the org is in the merge-gate program. */
const GATED_ENTRY_IDS: ReadonlySet<SettingsEntryId> = new Set(["triggers"]);

export function isSettingsEntryVisible(id: SettingsEntryId, mergeGateEnabled: boolean): boolean {
  return mergeGateEnabled || !GATED_ENTRY_IDS.has(id);
}

export function SettingsRail({ appSlug }: { appSlug: string }) {
  const { data: activeOrg } = useActiveOrg();
  const mergeGateEnabled = activeOrg?.mergeGateEnabled ?? false;

  return (
    <nav aria-label="Settings sections" className="flex shrink-0 flex-col gap-5 lg:w-56">
      <RailGroup label="This application">
        {APPLICATION_ENTRIES.filter((entry) => isSettingsEntryVisible(entry.id, mergeGateEnabled)).map((entry) => (
          <RailItem key={entry.id} entry={entry} appSlug={appSlug} />
        ))}
      </RailGroup>

      <RailGroup label="Organization settings">
        {ORGANIZATION_ENTRIES.map((entry) => (
          <RailItem key={entry.id} entry={entry} appSlug={appSlug} />
        ))}
      </RailGroup>
    </nav>
  );
}

function RailGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="px-3 font-mono text-3xs uppercase tracking-widest text-text-secondary">{label}</p>
      {children}
    </div>
  );
}

function RailItem({ entry, appSlug }: { entry: SettingsEntry; appSlug: string }) {
  return (
    <Link
      to={entry.to}
      params={{ appSlug }}
      activeOptions={{ exact: entry.exact }}
      className="group flex flex-col gap-0.5 border-l-2 px-3 py-2 transition-colors"
      activeProps={{ className: "border-primary bg-surface-raised" }}
      inactiveProps={{ className: "border-transparent hover:bg-surface-raised/50" }}
    >
      {({ isActive }) => (
        <>
          <span
            className={cn(
              "flex items-center gap-2 text-sm font-medium",
              isActive ? "text-text-primary" : "text-text-secondary group-hover:text-text-primary",
            )}
          >
            <entry.icon size={15} weight={isActive ? "fill" : "regular"} />
            {entry.label}
          </span>
          <span className="pl-[23px] text-2xs text-text-secondary">{entry.description}</span>
        </>
      )}
    </Link>
  );
}
