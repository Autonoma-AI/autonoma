import { cn } from "@autonoma/blacklight";
import { BroadcastIcon } from "@phosphor-icons/react/Broadcast";
import { BrowsersIcon } from "@phosphor-icons/react/Browsers";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/ClockCounterClockwise";
import { CreditCardIcon } from "@phosphor-icons/react/CreditCard";
import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { GithubLogoIcon } from "@phosphor-icons/react/GithubLogo";
import { KeyIcon } from "@phosphor-icons/react/Key";
import type { Icon } from "@phosphor-icons/react/lib";
import { Link } from "@tanstack/react-router";

type SettingsTab = "general" | "billing" | "scenarios" | "history" | "github" | "api-keys" | "preview";

interface SettingsTabNavProps {
  activeTab: SettingsTab;
  appSlug: string;
}

const TAB_CONFIG: { value: SettingsTab; label: string; icon: Icon; path: string }[] = [
  { value: "general", label: "General", icon: GearSixIcon, path: "settings" },
  { value: "billing", label: "Billing", icon: CreditCardIcon, path: "billing" },
  { value: "scenarios", label: "Scenarios", icon: BroadcastIcon, path: "scenarios" },
  { value: "api-keys", label: "API Keys", icon: KeyIcon, path: "api-keys" },
  { value: "preview", label: "Preview Environments", icon: BrowsersIcon, path: "preview-config" },
  { value: "history", label: "History", icon: ClockCounterClockwiseIcon, path: "history" },
  { value: "github", label: "GitHub", icon: GithubLogoIcon, path: "github" },
];

export function SettingsTabNav({ activeTab, appSlug }: SettingsTabNavProps) {
  const base = `/app/${appSlug}`;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-medium tracking-tight text-text-primary">Settings</h1>
        <p className="mt-1 font-mono text-xs text-text-secondary">Configure application-wide settings</p>
      </header>

      <div className="overflow-x-auto">
        <nav className="flex w-max min-w-full items-center gap-1 border-b border-border-dim">
          {TAB_CONFIG.map((tab) => {
            const isActive = activeTab === tab.value;
            return (
              <Link
                key={tab.value}
                to={`${base}/${tab.path}` as "/"}
                className={cn(
                  "-mb-px inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-t-md border border-transparent px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors",
                  isActive
                    ? "border-border-dim border-b-surface-void text-primary"
                    : "text-text-secondary hover:text-text-primary",
                )}
              >
                <tab.icon size={16} weight={isActive ? "fill" : "regular"} />
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
