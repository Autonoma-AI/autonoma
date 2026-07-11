import { cn } from "@autonoma/blacklight";
import { AppWindowIcon } from "@phosphor-icons/react/AppWindow";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { DatabaseIcon } from "@phosphor-icons/react/Database";
import type { ReactNode } from "react";
import {
  SERVICE_OPTIONS,
  serviceRecipeIsDatabase,
  type AppDraft,
  type ServiceDraft,
  type SetupTaskDraft,
  type TopologyDraft,
} from "./topology-draft";

interface ReviewSectionProps {
  draft: TopologyDraft;
  repoName: string;
}

/** A lifecycle-ordered summary of what runs, and when, before the deploy. */
export function ReviewSection({ draft }: ReviewSectionProps) {
  const databases = draft.services.filter((service) => serviceRecipeIsDatabase(service.recipe));
  const extras = draft.services.filter((service) => !serviceRecipeIsDatabase(service.recipe));
  const hookCount = draft.hooks.pre_deploy.length + draft.hooks.post_deploy.length;
  const frontend = draft.apps.find((app) => app.primary) ?? draft.apps[0];

  const onCreate = collectTasks(databases, "on_create");
  const everyCommit = collectTasks(databases, "every_commit");

  return (
    <div className="flex flex-col gap-5">
      <span className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">
        Review · what runs, and when
      </span>

      {/* lifecycle diagram */}
      <div className="relative border border-border-dim bg-surface-base p-5">
        <CornerAccents />
        <div className="flex flex-col items-stretch gap-3 lg:flex-row">
          <LifecycleStage
            tone="violet"
            title="▢ On create · once"
            subtitle="Separate job · own container"
            className="flex-1"
          >
            {onCreate.length === 0 ? (
              <EmptyChip>No on-create tasks</EmptyChip>
            ) : (
              onCreate.map((task) => (
                <span
                  key={task.id}
                  className="inline-flex items-center gap-1.5 border border-border-mid bg-surface-void px-2 py-1.5 font-mono text-3xs text-text-primary"
                >
                  <DatabaseIcon size={12} className="text-violet-accent" />
                  {task.label}
                </span>
              ))
            )}
          </LifecycleStage>

          <StageArrow />

          <LifecycleStage tone="lime" title="▣ Every commit / PR" className="flex-[1.4]">
            <div className="flex flex-wrap items-center gap-1.5">
              {everyCommit.map((task) => (
                <span
                  key={task.id}
                  className="border border-primary-ink bg-surface-void px-2 py-1.5 font-mono text-3xs font-bold text-primary-ink"
                >
                  {task.label}
                </span>
              ))}
              {everyCommit.length > 0 ? <span className="text-border-mid">→</span> : undefined}
              <span className="border border-border-mid bg-surface-void px-2 py-1.5 font-mono text-3xs font-bold text-text-primary">
                apps start
              </span>
            </div>
            <span className="text-2xs leading-relaxed text-text-secondary">
              Re-run on each preview build as one-off jobs, before your apps start.
            </span>
          </LifecycleStage>

          <StageArrow />

          <LifecycleStage tone="running" title="● Running preview" className="flex-1">
            <span className="inline-flex w-max items-center gap-1.5 border border-border-mid bg-surface-base px-2 py-1.5 font-mono text-3xs text-text-primary">
              <AppWindowIcon size={12} className="text-status-success" />
              {frontend != null ? `${appLabel(frontend)} :${frontend.port || "?"}` : "no app"}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {databases.map((database) => (
                <span
                  key={database.id}
                  className="border border-border-mid bg-surface-base px-1.5 py-1 font-mono text-4xs text-text-secondary"
                >
                  {serviceShortName(database)}
                </span>
              ))}
              {extras.map((service) => (
                <span
                  key={service.id}
                  className="border border-violet-accent bg-surface-base px-1.5 py-1 font-mono text-4xs text-violet-accent"
                >
                  {serviceShortName(service)}
                </span>
              ))}
            </div>
          </LifecycleStage>
        </div>
      </div>

      {/* config summary */}
      <div className="grid gap-4 sm:grid-cols-2">
        <SummaryCard title="Apps" count={draft.apps.length}>
          {draft.apps.length === 0 ? (
            <EmptyLine>No apps mapped.</EmptyLine>
          ) : (
            draft.apps.map((app) => (
              <div key={app.id} className="flex flex-col gap-1">
                <div className="flex justify-between font-mono text-2xs">
                  <span className="text-text-primary">{appLabel(app)}</span>
                  <span className="text-primary-ink">{buildMethodLabel(app)}</span>
                </div>
                <span className="text-2xs text-text-secondary">
                  entry {entrypointLabel(app)} · port {app.port || "?"}
                </span>
              </div>
            ))
          )}
        </SummaryCard>

        <SummaryCard title="Databases" count={databases.length} accent>
          {databases.length === 0 ? (
            <EmptyLine>No databases.</EmptyLine>
          ) : (
            databases.map((database) => (
              <div key={database.id} className="flex justify-between font-mono text-2xs">
                <span className="text-text-primary">{databaseLabel(database)}</span>
                <span className="text-text-secondary">{taskCountLabel(database.setupTasks.length)}</span>
              </div>
            ))
          )}
        </SummaryCard>

        <SummaryCard title="Extra services" count={extras.length} accent="violet">
          {extras.length === 0 ? (
            <EmptyLine>None configured.</EmptyLine>
          ) : (
            extras.map((service) => (
              <div key={service.id} className="font-mono text-2xs text-text-primary">
                {serviceShortName(service)}{" "}
                <span className="text-text-secondary">
                  {service.port.trim() !== "" ? `:${service.port} · ` : ""}
                  {service.env.length} env
                </span>
              </div>
            ))
          )}
        </SummaryCard>

        <SummaryCard title="Lifecycle hooks" count={hookCount}>
          {hookCount === 0 ? (
            <EmptyLine>None configured.</EmptyLine>
          ) : (
            <>
              <div className="flex justify-between font-mono text-2xs">
                <span className="text-text-primary">Pre-deploy</span>
                <span className="text-text-secondary">{draft.hooks.pre_deploy.length}</span>
              </div>
              <div className="flex justify-between font-mono text-2xs">
                <span className="text-text-primary">Post-deploy</span>
                <span className="text-text-secondary">{draft.hooks.post_deploy.length}</span>
              </div>
            </>
          )}
        </SummaryCard>
      </div>
    </div>
  );
}

function LifecycleStage({
  tone,
  title,
  subtitle,
  className,
  children,
}: {
  tone: "violet" | "lime" | "running";
  title: string;
  subtitle?: string;
  className?: string;
  children: ReactNode;
}) {
  const toneClass =
    tone === "violet"
      ? "border-violet-accent bg-violet-accent/[0.06]"
      : tone === "lime"
        ? "border-primary-ink bg-accent-dim"
        : "border-border-dim bg-surface-void";
  const titleClass =
    tone === "violet" ? "text-violet-accent" : tone === "lime" ? "text-primary-ink" : "text-status-success";
  return (
    <div className={cn("flex flex-col gap-2.5 border p-3.5", toneClass, className)}>
      <span className={cn("font-mono text-3xs font-bold uppercase tracking-widest", titleClass)}>{title}</span>
      {subtitle != null ? <span className="text-2xs text-text-secondary">{subtitle}</span> : undefined}
      {children}
    </div>
  );
}

function StageArrow() {
  return (
    <div className="flex items-center justify-center text-text-primary lg:px-0">
      <ArrowRightIcon size={16} weight="bold" className="rotate-90 lg:rotate-0" />
    </div>
  );
}

function SummaryCard({
  title,
  count,
  accent,
  children,
}: {
  title: string;
  count: number;
  accent?: boolean | "violet";
  children: ReactNode;
}) {
  const countClass = accent === "violet" ? "text-violet-accent" : accent ? "text-primary-ink" : "text-text-secondary";
  return (
    <div className="border border-border-dim bg-surface-base">
      <div className="flex items-center justify-between border-b border-border-dim px-3.5 py-2.5 font-mono text-3xs font-bold uppercase tracking-widest text-text-secondary">
        <span>{title}</span>
        <span className={countClass}>{count}</span>
      </div>
      <div className="flex flex-col gap-2 p-3.5">{children}</div>
    </div>
  );
}

function EmptyLine({ children }: { children: ReactNode }) {
  return <span className="text-2xs text-text-secondary">{children}</span>;
}

function EmptyChip({ children }: { children: ReactNode }) {
  return (
    <span className="border border-border-mid bg-surface-void px-2 py-1.5 font-mono text-3xs text-text-secondary">
      {children}
    </span>
  );
}

function CornerAccents() {
  return (
    <>
      <span className="pointer-events-none absolute left-0 top-0 size-2 border-l border-t border-border-mid" />
      <span className="pointer-events-none absolute right-0 top-0 size-2 border-r border-t border-border-mid" />
      <span className="pointer-events-none absolute bottom-0 left-0 size-2 border-b border-l border-border-mid" />
      <span className="pointer-events-none absolute bottom-0 right-0 size-2 border-b border-r border-border-mid" />
    </>
  );
}

interface LifecycleTask {
  id: number;
  label: string;
}

/** Collects setup tasks of a frequency across every database, labelled `name: command`. */
function collectTasks(databases: ServiceDraft[], frequency: SetupTaskDraft["frequency"]): LifecycleTask[] {
  const tasks: LifecycleTask[] = [];
  for (const database of databases) {
    for (const task of database.setupTasks) {
      if (task.frequency !== frequency || task.command.trim() === "") continue;
      tasks.push({ id: task.id, label: `${serviceShortName(database)}: ${commandSummary(task.command)}` });
    }
  }
  return tasks;
}

/** First line of a command, trimmed to a compact chip length. */
function commandSummary(command: string): string {
  const firstLine = command.split("\n")[0]?.trim() ?? "";
  return firstLine.length > 28 ? `${firstLine.slice(0, 27)}…` : firstLine;
}

function serviceShortName(service: ServiceDraft): string {
  return service.name.trim() === "" ? serviceLabel(service).toLowerCase() : service.name;
}

function serviceLabel(service: ServiceDraft): string {
  return SERVICE_OPTIONS.find((option) => option.recipe === service.recipe)?.label ?? service.recipe;
}

function databaseLabel(database: ServiceDraft): string {
  const version = database.version.trim();
  return version === "" ? serviceLabel(database) : `${serviceLabel(database)} ${version}`;
}

function taskCountLabel(count: number): string {
  if (count === 0) return "no setup";
  return `${count} ${count === 1 ? "task" : "tasks"}`;
}

function appLabel(app: AppDraft): string {
  return app.name.trim() === "" ? "unnamed app" : app.name;
}

function buildMethodLabel(app: AppDraft): string {
  if (app.buildMode === "runtime") return app.runtime;
  if (app.buildMode === "dockerfile") return "dockerfile";
  return "auto";
}

function entrypointLabel(app: AppDraft): string {
  if (app.buildMode === "runtime") return app.entrypoint.trim() === "" ? "-" : app.entrypoint.trim();
  return app.command.trim() === "" ? "auto" : app.command.trim();
}
