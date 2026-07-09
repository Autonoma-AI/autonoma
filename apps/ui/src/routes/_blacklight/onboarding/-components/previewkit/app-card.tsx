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
  cn,
} from "@autonoma/blacklight";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { useState } from "react";
import { fieldIssueKey, type AppDraft, type AppDraftField, type DraftIssues } from "./topology-draft";

interface AppCardProps {
  app: AppDraft;
  issues: DraftIssues;
  /** Names this app may depend on (other apps in its repo group + managed services). */
  dependencyOptions: string[];
  /** Start expanded (settings shows one card per pane, so collapsing has no place). */
  defaultExpanded?: boolean;
  onChange: (id: number, patch: Partial<AppDraft>) => void;
  onSetPrimary: (id: number) => void;
  onRemove: (id: number) => void;
}

/** One deployable app's source mapping and entrypoint configuration. */
export function AppCard({
  app,
  issues,
  dependencyOptions,
  defaultExpanded = false,
  onChange,
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
            {app.origin === "suggestion" ? <Badge variant="outline">suggested</Badge> : undefined}
            {app.origin === "starter" ? <Badge variant="warn">starter</Badge> : undefined}
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
          <div className="flex shrink-0 items-center gap-2" title="The primary app's URL becomes the preview URL.">
            <Label htmlFor={`pk-app-${app.id}-primary`} className="cursor-pointer text-2xs text-text-secondary">
              Primary
            </Label>
            <Switch
              id={`pk-app-${app.id}-primary`}
              checked={app.primary}
              onCheckedChange={() => onSetPrimary(app.id)}
            />
          </div>
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
          <div className="grid gap-4 sm:grid-cols-2">
            <AppField
              app={app}
              issues={issues}
              field="name"
              label="Name"
              placeholder="web"
              value={app.name}
              onChange={(name) => onChange(app.id, { name })}
            />
            <AppField
              app={app}
              issues={issues}
              field="port"
              label="Port"
              placeholder="3000"
              value={app.port}
              onChange={(port) => onChange(app.id, { port })}
            />
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
            <AppField
              app={app}
              issues={issues}
              field="buildContext"
              label="Build context"
              placeholder="defaults to path"
              value={app.buildContext}
              onChange={(buildContext) => onChange(app.id, { buildContext })}
            />
            <AppField
              app={app}
              issues={issues}
              field="command"
              label="Start command"
              placeholder="autodetected"
              value={app.command}
              onChange={(command) => onChange(app.id, { command })}
            />
            <AppField
              app={app}
              issues={issues}
              field="healthCheck"
              label="Health check"
              placeholder="/health"
              value={app.healthCheck}
              onChange={(healthCheck) => onChange(app.id, { healthCheck })}
            />
          </div>

          <div className="mt-4">
            <div className="flex items-center justify-between">
              <Label htmlFor={`pk-app-${app.id}-autodetect`}>Autodetect Dockerfile</Label>
              <Switch
                id={`pk-app-${app.id}-autodetect`}
                checked={app.autodetectDockerfile}
                onCheckedChange={(autodetectDockerfile) => onChange(app.id, { autodetectDockerfile })}
              />
            </div>
            {!app.autodetectDockerfile ? (
              <div className="mt-2">
                <Input
                  id={`pk-app-${app.id}-dockerfile`}
                  value={app.dockerfile}
                  onChange={(event) => onChange(app.id, { dockerfile: event.target.value })}
                  placeholder="Dockerfile"
                  aria-invalid={issues.fieldErrors.has(fieldIssueKey(app.id, "dockerfile"))}
                  className={fieldClassName(issues, app.id, "dockerfile")}
                />
                <FieldMessages issues={issues} draftId={app.id} field="dockerfile" />
              </div>
            ) : (
              <p className="mt-2 text-2xs text-text-secondary">
                Uses a Dockerfile in the app directory, turbo filters, or railpack autodetection.
              </p>
            )}
          </div>

          <div className="mt-4">
            <p className="font-mono text-2xs uppercase tracking-widest text-text-secondary">Depends on</p>
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

          <div className="mt-5 border-t border-border-dim pt-4">
            <p className="font-mono text-2xs uppercase tracking-widest text-text-secondary">Environment variables</p>
            <p className="mt-2 text-sm text-text-secondary">
              Secrets and connections for this app are managed in the Variables step.
            </p>
          </div>
        </>
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

function FieldMessages({ issues, draftId, field }: { issues: DraftIssues; draftId: number; field: AppDraftField }) {
  const key = fieldIssueKey(draftId, field);
  const errors = issues.fieldErrors.get(key) ?? [];
  const warnings = issues.fieldWarnings.get(key) ?? [];
  if (errors.length === 0 && warnings.length === 0) return undefined;
  return (
    <div className="mt-1 space-y-1">
      {errors.map((message) => (
        <p key={message} className="text-2xs text-status-critical">
          {message}
        </p>
      ))}
      {warnings.map((message) => (
        <p key={message} className="text-2xs text-status-warn">
          {message}
        </p>
      ))}
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
