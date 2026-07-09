import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, cn } from "@autonoma/blacklight";
import { AppWindowIcon } from "@phosphor-icons/react/AppWindow";
import { DatabaseIcon } from "@phosphor-icons/react/Database";
import { GitBranchIcon } from "@phosphor-icons/react/GitBranch";
import type { Icon } from "@phosphor-icons/react/lib";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import type { ReactNode } from "react";
import { PRIMARY_REPO_KEY, SERVICE_OPTIONS } from "../../../onboarding/-components/previewkit/topology-draft";
import { usePreviewDraft } from "./-draft-context";

/** What the preview-config rail points at: one app, one service, or a config section. */
export type RailSelection = { kind: "app"; id: number } | { kind: "service"; id: number } | { kind: "repos" };

interface PreviewRailProps {
  selection?: RailSelection;
  onSelect: (selection: RailSelection) => void;
}

/**
 * App-centric left rail for the Preview Environments settings (design "5a"):
 * apps are primary destinations, managed services sit beside them, and the
 * cross-cutting topology config (dependency repos, deploy hooks) gets its own
 * quiet group. There is no Secrets destination - a secret is just a masked
 * variable inside an app.
 */
export function PreviewRail({ selection, onSelect }: PreviewRailProps) {
  const { draft, addApp, addService } = usePreviewDraft();

  return (
    <nav aria-label="Preview environment sections" className="flex shrink-0 flex-col gap-6 lg:w-52">
      <RailGroup label="Apps">
        {draft.apps.map((app) => (
          <RailItem
            key={app.id}
            icon={AppWindowIcon}
            active={selection?.kind === "app" && selection.id === app.id}
            onClick={() => onSelect({ kind: "app", id: app.id })}
          >
            {app.name.trim() === "" ? <span className="italic">new app</span> : app.name}
          </RailItem>
        ))}
        <RailItem icon={PlusIcon} onClick={() => onSelect({ kind: "app", id: addApp(PRIMARY_REPO_KEY) })}>
          New app
        </RailItem>
      </RailGroup>

      <RailGroup label="Services">
        {draft.services.map((service) => (
          <RailItem
            key={service.id}
            icon={DatabaseIcon}
            active={selection?.kind === "service" && selection.id === service.id}
            onClick={() => onSelect({ kind: "service", id: service.id })}
          >
            {service.name.trim() === "" ? <span className="italic">unnamed</span> : service.name}
          </RailItem>
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button type="button" className={railItemClassName(false)}>
                <PlusIcon size={14} className="shrink-0" />
                <span className="truncate">Attach</span>
              </button>
            }
          />
          <DropdownMenuContent align="start">
            {SERVICE_OPTIONS.map((option) => (
              <DropdownMenuItem
                key={option.recipe}
                onClick={() => onSelect({ kind: "service", id: addService(option.recipe) })}
              >
                <span className="font-mono text-2xs">{option.label}</span>
                <span className="ml-2 font-mono text-4xs text-text-secondary">{option.meta}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </RailGroup>

      <RailGroup label="Config">
        <RailItem icon={GitBranchIcon} active={selection?.kind === "repos"} onClick={() => onSelect({ kind: "repos" })}>
          Repos
        </RailItem>
      </RailGroup>
    </nav>
  );
}

function RailGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="mb-1.5 px-3 font-mono text-4xs font-semibold uppercase tracking-widest text-text-secondary">
        {label}
      </p>
      {children}
    </div>
  );
}

function RailItem({
  icon: ItemIcon,
  active = false,
  onClick,
  children,
}: {
  icon: Icon;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} className={railItemClassName(active)}>
      <ItemIcon size={14} className="shrink-0" />
      <span className="truncate">{children}</span>
    </button>
  );
}

function railItemClassName(active: boolean): string {
  return cn(
    "flex w-full items-center gap-2.5 border-l-2 px-3 py-2 text-left font-mono text-xs transition-colors",
    active
      ? "border-primary bg-surface-base text-text-primary"
      : "border-transparent text-text-secondary hover:bg-surface-raised/50 hover:text-text-primary",
  );
}
