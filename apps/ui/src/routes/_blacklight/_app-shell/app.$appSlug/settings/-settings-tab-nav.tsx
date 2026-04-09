import { cn, tabsListVariants } from "@autonoma/blacklight";
import { BookOpenIcon } from "@phosphor-icons/react/BookOpen";
import { BroadcastIcon } from "@phosphor-icons/react/Broadcast";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/ClockCounterClockwise";
import { CreditCardIcon } from "@phosphor-icons/react/CreditCard";
import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { GithubLogoIcon } from "@phosphor-icons/react/GithubLogo";
import { KeyIcon } from "@phosphor-icons/react/Key";
import type { Icon } from "@phosphor-icons/react/lib";
import { Link } from "@tanstack/react-router";

type SettingsTab = "general" | "billing" | "scenarios" | "skills" | "history" | "github" | "api-keys";

interface SettingsTabNavProps {
  activeTab: SettingsTab;
  appSlug: string;
}

const TAB_CONFIG: { value: SettingsTab; label: string; icon: Icon; path: string }[] = [
  { value: "general", label: "General", icon: GearSixIcon, path: "settings" },
  { value: "billing", label: "Billing", icon: CreditCardIcon, path: "billing" },
  { value: "scenarios", label: "Scenarios", icon: BroadcastIcon, path: "scenarios" },
  { value: "skills", label: "Skills", icon: BookOpenIcon, path: "skills" },
  { value: "api-keys", label: "API Keys", icon: KeyIcon, path: "api-keys" },
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

      <div className={tabsListVariants()}>
        {TAB_CONFIG.map((tab) => (
          <Link
            key={tab.value}
            to={`${base}/${tab.path}` as "/"}
            className={cn(
              "relative inline-flex h-[calc(100%-1px)] flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-none border border-transparent px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.05em] whitespace-nowrap text-text-tertiary transition-all hover:text-foreground",
              activeTab === tab.value && "bg-surface-raised text-foreground",
            )}
          >
            <tab.icon size={14} />
            {tab.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
