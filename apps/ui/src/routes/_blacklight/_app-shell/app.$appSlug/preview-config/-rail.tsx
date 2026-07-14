import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, cn } from "@autonoma/blacklight";
import { AppWindowIcon } from "@phosphor-icons/react/AppWindow";
import { DatabaseIcon } from "@phosphor-icons/react/Database";
import { GitBranchIcon } from "@phosphor-icons/react/GitBranch";
import type { Icon } from "@phosphor-icons/react/lib";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import type { ReactNode } from "react";
import { PRIMARY_REPO_KEY, SERVICE_OPTIONS } from "../../../onboarding/-components/previewkit/topology-draft";
import { usePreviewDraft } from "./-draft-context";

/** What the preview-config rail points at: one app, one service, or one dependency repo. */
export type RailSelection =
  | { kind: "app"; id: number }
  | { kind: "service"; id: number }
  | { kind: "repo"; id: number };

interface PreviewRailProps {
  selection?: RailSelection;
  onSelect: (selection: RailSelection) => void;
  /** Opens the "add an app from another repo" dialog (the GitHub-connect path). */
  onAddFromAnotherRepo: () => void;
}

/**
 * App-centric left rail for the Preview Environments settings (design "5a"):
 * apps are primary destinations, managed services sit beside them, and each
 * dependency repo the preview pulls apps from is its own destination too (only
 * shown once one exists). There is no Secrets destination - a secret is just a
 * masked variable inside an app.
 */
export function PreviewRail({ selection, onSelect, onAddFromAnotherRepo }: PreviewRailProps) {
  const { draft, addApp, addService, primaryRepoFullName } = usePreviewDraft();
  const primaryRepoShortName = primaryRepoFullName?.split("/").pop();

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
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button type="button" className={railItemClassName(false)}>
                <PlusIcon size={14} className="shrink-0" />
                <span className="truncate">New app</span>
              </button>
            }
          />
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => onSelect({ kind: "app", id: addApp(PRIMARY_REPO_KEY) })}>
              This repo
              {primaryRepoShortName != null ? (
                <span className="ml-1 text-text-secondary">({primaryRepoShortName})</span>
              ) : undefined}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onAddFromAnotherRepo}>Another repo</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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

      {/* Dependency repos each get their own destination, like apps and services.
          The primary repo isn't listed (the app implies it); this group only holds
          repos other apps are pulled from - so it's absent for a single-repo app and
          appears the moment one is added via "New app -> Another repo". */}
      {draft.repos.length > 0 ? (
        <RailGroup label="Repositories">
          {draft.repos.map((repo) => (
            <RailItem
              key={repo.id}
              icon={GitBranchIcon}
              active={selection?.kind === "repo" && selection.id === repo.id}
              onClick={() => onSelect({ kind: "repo", id: repo.id })}
            >
              {repo.name.trim() === "" ? <span className="italic">new repo</span> : repo.name}
            </RailItem>
          ))}
        </RailGroup>
      ) : undefined}
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
