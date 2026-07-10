import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Label,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from "@autonoma/blacklight";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { InfoIcon } from "@phosphor-icons/react/Info";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { useState } from "react";
import { BuildModeSection } from "./build-mode-section";
import { FieldMessages } from "./field-messages";
import { fieldIssueKey, type AppDraft, type AppDraftField, type DraftIssues, type RepoDraft } from "./topology-draft";

const MULTIREPO_DOCS_URL = "https://docs.autonoma.app/previewkit/multirepo/";

interface AppCardProps {
  app: AppDraft;
  issues: DraftIssues;
  /** Names this app may depend on (other apps in its repo group + managed services). */
  dependencyOptions: string[];
  /** Whether to show the cross-app "Depends on" control - only relevant once the
   * project spans more than one repo, so it stays hidden for single-repo projects. */
  showDependsOn: boolean;
  /** Whether to show the frontend (primary) toggle. With a single app there is
   * nothing to choose - it is the frontend by default - so the toggle is hidden. */
  showFrontendToggle: boolean;
  /** Start expanded. Cards default to open so the fields are visible and never
   * auto-collapse while editing. */
  defaultExpanded?: boolean;
  /** The dependency repo this app belongs to. Absent for primary-repo apps, whose
   * branch is always the PR's own and which carry no per-repo settings. */
  repo?: RepoDraft;
  /** How many apps map to {@link repo}, so a shared-settings note appears when >1. */
  repoAppCount?: number;
  onChange: (id: number, patch: Partial<AppDraft>) => void;
  onRepoChange?: (id: number, patch: Partial<RepoDraft>) => void;
  onSetPrimary: (id: number) => void;
  onRemove: (id: number) => void;
}

/** One deployable app's source mapping and entrypoint configuration. */
export function AppCard({
  app,
  issues,
  dependencyOptions,
  showDependsOn,
  showFrontendToggle,
  defaultExpanded = true,
  repo,
  repoAppCount = 0,
  onChange,
  onRepoChange,
  onSetPrimary,
  onRemove,
}: AppCardProps) {
  const errorCount = countIssues(issues.fieldErrors, app.id);
  const warningCount = countIssues(issues.fieldWarnings, app.id);
  const [expanded, setExpanded] = useState(defaultExpanded);
  // Cards with errors stay open so the offending field is always visible.
  const open = expanded || errorCount > 0;

  function toggleDependency(name: string) {
    const dependsOn = app.dependsOn.includes(name)
      ? app.dependsOn.filter((candidate) => candidate !== name)
      : [...app.dependsOn, name];
    onChange(app.id, { dependsOn });
  }

  return (
    <div
      data-app-name={app.name}
      data-app-draft-id={app.id}
      className={cn("border bg-surface-base p-5", errorCount > 0 ? "border-status-critical/60" : "border-border-dim")}
    >
      <div className={cn("border-b border-border-dim pb-3", open && "mb-4")}>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setExpanded(!open)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            aria-expanded={open}
          >
            {open ? (
              <CaretDownIcon size={13} className="shrink-0 text-text-secondary" />
            ) : (
              <CaretRightIcon size={13} className="shrink-0 text-text-secondary" />
            )}
            <span className="font-mono text-sm font-bold text-text-primary">
              {app.name.trim() === "" ? "new app" : app.name}
            </span>
            {errorCount > 0 ? (
              <Badge variant="critical">
                {errorCount} {errorCount === 1 ? "error" : "errors"}
              </Badge>
            ) : undefined}
            {warningCount > 0 ? (
              <Badge variant="warn">
                {warningCount} {warningCount === 1 ? "warning" : "warnings"}
              </Badge>
            ) : undefined}
            {!open && app.port.trim() !== "" ? (
              <span className="font-mono text-2xs text-text-secondary">· {app.port}</span>
            ) : undefined}
          </button>
          {showFrontendToggle ? (
            <div className="flex shrink-0 items-center gap-2">
              <Label htmlFor={`pk-app-${app.id}-primary`} className="cursor-pointer text-2xs text-text-secondary">
                Frontend
              </Label>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="About the frontend app"
                      className="flex items-center text-text-secondary transition-colors hover:text-text-primary"
                    >
                      <InfoIcon size={13} />
                    </button>
                  }
                />
                <TooltipContent className="max-w-xs">
                  The frontend is the app our agents open in the browser to test, and its URL becomes the preview URL.
                  Each project has exactly one frontend.
                </TooltipContent>
              </Tooltip>
              <Switch
                id={`pk-app-${app.id}-primary`}
                checked={app.primary}
                onCheckedChange={() => onSetPrimary(app.id)}
              />
            </div>
          ) : undefined}
          <Button
            variant="ghost"
            size="icon-xs"
            title="Remove app"
            className="hover:text-status-critical"
            onClick={() => onRemove(app.id)}
          >
            <TrashIcon size={14} />
          </Button>
        </div>
        <FieldMessages issues={issues} draftId={app.id} field="primary" />
      </div>

      {open ? (
        <>
          {repo != null && onRepoChange != null ? (
            <RepoSettings repo={repo} repoAppCount={repoAppCount} onRepoChange={onRepoChange} />
          ) : undefined}

          <BuildModeSection app={app} issues={issues} onChange={onChange} />

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <AppField
              app={app}
              issues={issues}
              field="name"
              label="Name"
              placeholder="web"
              value={app.name}
              onChange={(name) => onChange(app.id, { name })}
              hint="Lowercase, used in resource names and the preview URL"
            />
            <AppField
              app={app}
              issues={issues}
              field="port"
              label="Port"
              placeholder="3000"
              value={app.port}
              onChange={(port) => onChange(app.id, { port })}
              hint="The port your app listens on"
            />
            {/* Path, build context, and start command only apply to auto-detect /
                Dockerfile builds. Manual builds copy the whole repo root and bake
                their own entrypoint (the workdir is shown in the build spec), so
                these are hidden to keep the choice explicit. */}
            {app.buildMode !== "runtime" ? (
              <AppField
                app={app}
                issues={issues}
                field="path"
                label="Path"
                placeholder="apps/web"
                value={app.path}
                onChange={(path) => onChange(app.id, { path })}
                hint="Directory of the app inside the repo"
              />
            ) : undefined}
            {app.buildMode !== "runtime" ? (
              <AppField
                app={app}
                issues={issues}
                field="buildContext"
                label="Root directory"
                placeholder="Defaults to Path"
                value={app.buildContext}
                onChange={(buildContext) => onChange(app.id, { buildContext })}
                hint="Folder Docker builds from - what COPY can read. Blank uses Path; set to the repo root for monorepos"
              />
            ) : undefined}
            {app.buildMode !== "runtime" ? (
              <AppField
                app={app}
                issues={issues}
                field="command"
                label="Start command"
                placeholder="autodetected"
                value={app.command}
                onChange={(command) => onChange(app.id, { command })}
              />
            ) : undefined}
            <AppField
              app={app}
              issues={issues}
              field="healthCheck"
              label="Health check"
              placeholder="/health"
              value={app.healthCheck}
              onChange={(healthCheck) => onChange(app.id, { healthCheck })}
              hint="Path we request to check the app is up"
            />
          </div>

          {showDependsOn ? (
            <div className="mt-6">
              <p className="font-mono text-2xs uppercase tracking-widest text-text-secondary">Depends on</p>
              <p className="mt-1 text-2xs text-text-secondary">
                Other apps or services this app waits for before it starts.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {app.dependsOn.map((name) => (
                  <Badge key={name} variant="outline" className="font-mono">
                    {name}
                  </Badge>
                ))}
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button variant="outline" size="xs" className="gap-1" disabled={dependencyOptions.length === 0}>
                        Add app dep
                        <CaretDownIcon size={12} />
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="start">
                    {dependencyOptions.map((name) => (
                      <DropdownMenuItem key={name} closeOnClick={false} onClick={() => toggleDependency(name)}>
                        <span className={cn("mr-2", app.dependsOn.includes(name) ? "opacity-100" : "opacity-0")}>
                          <CheckIcon size={12} weight="bold" />
                        </span>
                        <span className="font-mono text-2xs">{name}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <FieldMessages issues={issues} draftId={app.id} field="dependsOn" />
            </div>
          ) : undefined}
        </>
      ) : undefined}
    </div>
  );
}

/**
 * Per-repo settings (alias, fallback branch) for a dependency-repo app, shown at
 * the top of the card. These belong to the repo, not the app, so editing them here
 * updates every app from the same repo; a note flags that when more than one app
 * shares it.
 */
function RepoSettings({
  repo,
  repoAppCount,
  onRepoChange,
}: {
  repo: RepoDraft;
  repoAppCount: number;
  onRepoChange: (id: number, patch: Partial<RepoDraft>) => void;
}) {
  return (
    <div className="mb-6 border border-border-dim bg-surface-raised p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="font-mono text-2xs uppercase tracking-widest text-text-secondary">Repo settings</p>
        <span className="truncate font-mono text-2xs text-text-secondary" title={repo.repo}>
          {repo.repo}
        </span>
      </div>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor={`pk-repo-${repo.id}-alias`}>Alias</Label>
          <Input
            id={`pk-repo-${repo.id}-alias`}
            value={repo.name}
            onChange={(event) => onRepoChange(repo.id, { name: event.target.value })}
            placeholder="api"
            className="font-mono"
          />
          <p className="mt-1 text-2xs text-text-secondary">
            Short name for this repo in resource names. Must be unique.
          </p>
        </div>
        <div>
          <Label htmlFor={`pk-repo-${repo.id}-fallback`}>Fallback branch</Label>
          <Input
            id={`pk-repo-${repo.id}-fallback`}
            value={repo.fallbackBranch}
            onChange={(event) => onRepoChange(repo.id, { fallbackBranch: event.target.value })}
            placeholder="main"
            className="font-mono"
          />
          <p className="mt-1 text-2xs text-text-secondary">
            Deployed when branch matching finds no matching branch.{" "}
            <a
              href={MULTIREPO_DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="text-primary-ink underline underline-offset-2"
            >
              Learn more
            </a>
          </p>
        </div>
      </div>
      {repoAppCount > 1 ? (
        <p className="mt-3 text-2xs text-text-secondary">
          Shared across {repoAppCount} apps from this repo - changing it here updates them all.
        </p>
      ) : undefined}
    </div>
  );
}

function AppField({
  app,
  issues,
  field,
  label,
  placeholder,
  value,
  hint,
  onChange,
}: {
  app: AppDraft;
  issues: DraftIssues;
  field: AppDraftField;
  label: string;
  placeholder: string;
  value: string;
  hint?: string;
  onChange: (value: string) => void;
}) {
  const inputId = `pk-app-${app.id}-${field}`;
  return (
    <div>
      <Label htmlFor={inputId}>{label}</Label>
      <Input
        id={inputId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-invalid={issues.fieldErrors.has(fieldIssueKey(app.id, field))}
        className={fieldClassName(issues, app.id, field)}
      />
      {hint != null && !issues.fieldErrors.has(fieldIssueKey(app.id, field)) ? (
        <p className="mt-1 text-2xs text-text-secondary">{hint}</p>
      ) : undefined}
      <FieldMessages issues={issues} draftId={app.id} field={field} />
    </div>
  );
}

function fieldClassName(issues: DraftIssues, draftId: number, field: AppDraftField): string | undefined {
  const key = fieldIssueKey(draftId, field);
  if (issues.fieldErrors.has(key)) return "border-status-critical";
  if (issues.fieldWarnings.has(key)) return "border-status-warn";
  return undefined;
}

function countIssues(bucket: Map<string, string[]>, draftId: number): number {
  let count = 0;
  for (const [key, messages] of bucket) {
    if (key.startsWith(`${draftId}:`)) count += messages.length;
  }
  return count;
}
