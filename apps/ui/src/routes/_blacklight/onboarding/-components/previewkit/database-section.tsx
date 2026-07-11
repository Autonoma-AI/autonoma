import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  cn,
} from "@autonoma/blacklight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { DatabaseIcon } from "@phosphor-icons/react/Database";
import { InfoIcon } from "@phosphor-icons/react/Info";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { useState, type ReactNode } from "react";
import {
  SERVICE_OPTIONS,
  emptySetupTaskDraft,
  serviceDraftForRecipe,
  serviceRecipeIsDatabase,
  type RepoDraft,
  type ServiceDraft,
  type ServiceRecipe,
  type SetupTaskDraft,
  type SetupTaskFrequency,
} from "./topology-draft";

const DATABASE_OPTIONS = SERVICE_OPTIONS.filter((option) => serviceRecipeIsDatabase(option.recipe));

const DATABASES_DOCS_URL = "https://docs.autonoma.app/previewkit/databases/";

// A `separate_job` task with a blank repo runs in the primary repo. The Select
// needs a concrete value per item, so the primary-repo choice carries this
// sentinel in the dropdown and maps back to "" (the compiled shape) on change.
const PRIMARY_REPO_SENTINEL = "__primary_repo__";

const SETUP_TASK_GROUPS: Array<{
  frequency: SetupTaskFrequency;
  label: string;
  description: string;
}> = [
  {
    frequency: "on_create",
    label: "Run once · on create",
    description:
      "Runs the first time the database is created. Good for schema + seed. Your repo is checked out, so files like db/schema.sql are available even if the image doesn't ship them.",
  },
  {
    frequency: "every_commit",
    label: "Run on every commit / PR",
    description: "Re-runs on each preview build. Typically migrations.",
  },
];

interface DatabaseSectionProps {
  /** The database-recipe subset of the topology's services (postgres/mysql/mongodb/redis/valkey). */
  databases: ServiceDraft[];
  /** All service names in the topology, so a freshly-added database gets a unique name. */
  existingNames: string[];
  /** Declared app names, offered as the target for an `in_build` setup task. */
  appNames: string[];
  /** Dependency repos, offered as the target for a `separate_job` setup task (primary repo is implicit). */
  repos: RepoDraft[];
  onChange: (databases: ServiceDraft[]) => void;
}

/**
 * Edits the database engines of the topology. Databases are the recipes that
 * expose a managed connection string and carry guided setup tasks (schema, seed,
 * migrations). Before the first is added the picker is a grid of big engine
 * cards; afterwards a compact chip row adds more, keeping the added engines from
 * dominating the page.
 */
export function DatabaseSection({ databases, existingNames, appNames, repos, onChange }: DatabaseSectionProps) {
  function addDatabase(recipe: ServiceRecipe) {
    onChange([...databases, serviceDraftForRecipe(recipe, existingNames)]);
  }

  function removeDatabase(id: number) {
    onChange(databases.filter((database) => database.id !== id));
  }

  function updateDatabase(id: number, patch: Partial<ServiceDraft>) {
    onChange(databases.map((database) => (database.id === id ? { ...database, ...patch } : database)));
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">Databases</span>
        <span className="text-sm text-text-secondary">
          Add as many as your app needs. Each gets its own setup.{" "}
          <a
            href={DATABASES_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary-ink underline underline-offset-2"
          >
            Learn more
            <ArrowSquareOutIcon size={11} />
          </a>
        </span>
      </div>

      {databases.length === 0 ? (
        <DatabasePalette onAdd={addDatabase} />
      ) : (
        <div className="flex flex-wrap gap-2">
          {DATABASE_OPTIONS.map((option) => (
            <button
              key={option.recipe}
              type="button"
              onClick={() => addDatabase(option.recipe)}
              className="inline-flex h-8 items-center gap-1.5 border border-border-mid bg-transparent px-3 font-mono text-2xs text-text-secondary transition-colors hover:border-border-mid hover:text-text-primary"
            >
              <PlusIcon size={12} weight="bold" />
              {option.label}
            </button>
          ))}
        </div>
      )}

      {databases.map((database) => (
        <DatabaseCard
          key={database.id}
          database={database}
          appNames={appNames}
          repos={repos}
          onUpdate={(patch) => updateDatabase(database.id, patch)}
          onRemove={() => removeDatabase(database.id)}
        />
      ))}
    </div>
  );
}

/** The grid of engine cards shown before the first database is added. */
function DatabasePalette({ onAdd }: { onAdd: (recipe: ServiceRecipe) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {DATABASE_OPTIONS.map((option) => (
        <button
          key={option.recipe}
          type="button"
          onClick={() => onAdd(option.recipe)}
          className="group flex flex-col items-start gap-3 border border-border-dim bg-surface-base p-4 text-left transition-colors hover:border-primary-ink/60 hover:bg-accent-dim"
        >
          <DatabaseIcon size={22} className="text-text-secondary transition-colors group-hover:text-primary-ink" />
          <span className="flex flex-col gap-1">
            <span className="font-medium text-text-primary">{option.label}</span>
            <span className="font-mono text-3xs uppercase tracking-widest text-text-secondary">{option.meta}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function DatabaseCard({
  database,
  appNames,
  repos,
  onUpdate,
  onRemove,
}: {
  database: ServiceDraft;
  appNames: string[];
  repos: RepoDraft[];
  onUpdate: (patch: Partial<ServiceDraft>) => void;
  onRemove: () => void;
}) {
  const option = SERVICE_OPTIONS.find((candidate) => candidate.recipe === database.recipe);
  const label = option?.label ?? database.recipe;
  const [expanded, setExpanded] = useState(true);
  const onCreateTasks = database.setupTasks.filter((task) => task.frequency === "on_create");
  const everyCommitTasks = database.setupTasks.filter((task) => task.frequency === "every_commit");
  const taskSummary = summarizeTasks(onCreateTasks.length, everyCommitTasks.length);

  function updateTasks(frequency: SetupTaskFrequency, tasks: SetupTaskDraft[]) {
    const others = database.setupTasks.filter((task) => task.frequency !== frequency);
    onUpdate({ setupTasks: [...others, ...tasks] });
  }

  const version = database.version.trim();
  const port = option?.defaultPort != null ? String(option.defaultPort) : "";
  const metaLine = [database.name.trim() === "" ? (option?.defaultName ?? database.recipe) : database.name, port]
    .filter((part) => part !== "")
    .join(" · ");

  return (
    <div className="border border-border-dim bg-surface-base">
      <div className="flex items-center gap-2.5 border-b border-border-dim bg-surface-void px-4 py-3">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
          aria-expanded={expanded}
        >
          <DatabaseIcon size={16} className={expanded ? "text-primary-ink" : "text-text-secondary"} />
          <span className="font-mono text-sm font-bold text-text-primary">
            {label}
            {version !== "" ? <span className="font-normal text-text-secondary">@{version}</span> : undefined}
          </span>
          <span className="truncate font-mono text-2xs text-text-secondary">{metaLine}</span>
        </button>
        <span className="flex shrink-0 items-center gap-3">
          <span className={cn("font-mono text-3xs uppercase tracking-widest", taskSummary.tone)}>
            {taskSummary.text}
          </span>
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="text-text-secondary transition-colors hover:text-text-primary"
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? <CaretDownIcon size={14} /> : <CaretRightIcon size={14} />}
          </button>
          <button
            type="button"
            onClick={onRemove}
            title="Remove database"
            aria-label={`Remove ${database.name.trim() === "" ? label : database.name}`}
            className="text-border-mid transition-colors hover:text-status-critical"
          >
            <TrashIcon size={14} />
          </button>
        </span>
      </div>

      {expanded ? (
        <div className="flex flex-col gap-5 p-4">
          <div className="flex flex-wrap gap-3">
            <FieldColumn label="Name" className="min-w-40 flex-1">
              <Input
                value={database.name}
                onChange={(event) => onUpdate({ name: event.target.value })}
                placeholder={option?.defaultName ?? database.recipe}
                className="font-mono"
              />
            </FieldColumn>
            <FieldColumn label="Version" className="w-32">
              <Input
                value={database.version}
                onChange={(event) => onUpdate({ version: event.target.value })}
                placeholder={option?.version ?? "latest"}
                className="font-mono"
              />
            </FieldColumn>
            {port !== "" ? (
              <FieldColumn label="Port" className="w-28">
                <Input value={port} readOnly disabled className="font-mono" />
              </FieldColumn>
            ) : undefined}
          </div>

          {SETUP_TASK_GROUPS.map((group) => (
            <SetupTaskGroup
              key={group.frequency}
              group={group}
              appNames={appNames}
              repos={repos}
              tasks={group.frequency === "on_create" ? onCreateTasks : everyCommitTasks}
              onChange={(tasks) => updateTasks(group.frequency, tasks)}
            />
          ))}

          {database.setupTasks.length > 0 ? <WhereExplainer multiRepo={repos.length > 0} /> : undefined}
        </div>
      ) : undefined}
    </div>
  );
}

/** The summary shown on a collapsed card header: lime for build tasks, violet for a job, dim for none. */
function summarizeTasks(onCreate: number, everyCommit: number): { text: string; tone: string } {
  const total = onCreate + everyCommit;
  if (total === 0) return { text: "no setup", tone: "text-text-secondary" };
  if (everyCommit > 0) {
    return { text: `${total} setup ${total === 1 ? "task" : "tasks"}`, tone: "text-primary-ink" };
  }
  return { text: `${onCreate} ${onCreate === 1 ? "task" : "tasks"} · on create`, tone: "text-violet-accent" };
}

function SetupTaskGroup({
  group,
  appNames,
  repos,
  tasks,
  onChange,
}: {
  group: { frequency: SetupTaskFrequency; label: string; description: string };
  appNames: string[];
  repos: RepoDraft[];
  tasks: SetupTaskDraft[];
  onChange: (tasks: SetupTaskDraft[]) => void;
}) {
  function updateTask(id: number, patch: Partial<SetupTaskDraft>) {
    onChange(tasks.map((task) => (task.id === id ? { ...task, ...patch } : task)));
  }

  function removeTask(id: number) {
    onChange(tasks.filter((task) => task.id !== id));
  }

  function addTask() {
    onChange([...tasks, emptySetupTaskDraft(group.frequency)]);
  }

  return (
    <div className="flex flex-col gap-2.5 border-l-2 border-border-dim pl-3.5">
      <div className="flex items-center gap-2.5">
        <span className="font-mono text-2xs font-bold uppercase tracking-widest text-text-primary">{group.label}</span>
        <span className="border border-border-mid px-1.5 py-0.5 font-mono text-4xs uppercase tracking-widest text-text-secondary">
          Optional
        </span>
        {tasks.length > 0 ? (
          <button
            type="button"
            onClick={() => onChange([])}
            className="ml-auto text-2xs text-text-secondary transition-colors hover:text-text-primary"
          >
            Skip - my app handles this
          </button>
        ) : (
          <Button variant="ghost" size="xs" className="ml-auto gap-1" onClick={addTask}>
            <PlusIcon size={12} weight="bold" />
            Add task
          </Button>
        )}
      </div>
      <p className="text-2xs leading-relaxed text-text-secondary">{group.description}</p>
      {tasks.map((task) => (
        <SetupTaskRow
          key={task.id}
          task={task}
          appNames={appNames}
          repos={repos}
          onUpdate={(patch) => updateTask(task.id, patch)}
          onRemove={() => removeTask(task.id)}
        />
      ))}
      {tasks.length > 0 ? (
        <Button variant="ghost" size="xs" className="w-fit gap-1" onClick={addTask}>
          <PlusIcon size={12} weight="bold" />
          Add task
        </Button>
      ) : undefined}
    </div>
  );
}

function SetupTaskRow({
  task,
  appNames,
  repos,
  onUpdate,
  onRemove,
}: {
  task: SetupTaskDraft;
  appNames: string[];
  repos: RepoDraft[];
  onUpdate: (patch: Partial<SetupTaskDraft>) => void;
  onRemove: () => void;
}) {
  const showRepoPicker = repos.length > 0;
  const showAppPicker = appNames.length > 1;

  function selectInBuild() {
    // Fold the task into an app's build. With a single app there's nothing to
    // choose, so default straight to it; the app picker only appears with 2+.
    onUpdate({ locationType: "in_build", app: task.app.trim() === "" ? (appNames[0] ?? "") : task.app });
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-start gap-2">
        <Textarea
          value={task.command}
          onChange={(event) => onUpdate({ command: event.target.value })}
          placeholder="npx prisma migrate deploy"
          rows={2}
          className="flex-1 font-mono [field-sizing:content]"
          aria-label="Setup command"
        />
        <button
          type="button"
          onClick={onRemove}
          title="Remove task"
          aria-label="Remove task"
          className="mt-1 text-border-mid transition-colors hover:text-status-critical"
        >
          <TrashIcon size={14} />
        </button>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="font-mono text-3xs font-bold uppercase tracking-widest text-text-secondary">Where</span>
          <div className="flex border border-border-mid">
            <SegmentButton
              active={task.locationType === "in_build"}
              tone="lime"
              onClick={selectInBuild}
              label="In the build"
            />
            <SegmentButton
              active={task.locationType === "separate_job"}
              tone="violet"
              onClick={() => onUpdate({ locationType: "separate_job" })}
              label="Separate job"
              bordered
            />
          </div>

          {task.locationType === "in_build" && showAppPicker ? (
            <TaskPicker
              label="App"
              value={task.app}
              onChange={(value) => onUpdate({ app: value })}
              options={appNames.map((name) => ({ value: name, label: name }))}
            />
          ) : undefined}

          {task.locationType === "separate_job" && showRepoPicker ? (
            <TaskPicker
              label="Repo"
              value={task.repo === "" ? PRIMARY_REPO_SENTINEL : task.repo}
              onChange={(value) => onUpdate({ repo: value === PRIMARY_REPO_SENTINEL ? "" : value })}
              options={[
                { value: PRIMARY_REPO_SENTINEL, label: "primary repo" },
                ...repos.map((repo) => ({ value: repo.name, label: repo.name })),
              ]}
            />
          ) : undefined}

          <span className="text-2xs text-text-secondary">
            {task.locationType === "in_build"
              ? "runs from the app's built image"
              : "own container from the primary app's image"}
          </span>
        </div>

        {/* The in-build phase is a child of the "In the build" choice, not a peer toggle. */}
        {task.locationType === "in_build" ? (
          <div className="flex items-center gap-2.5">
            <span className="font-mono text-3xs font-bold uppercase tracking-widest text-text-secondary">
              <span className="mr-1 text-border-mid">└</span>Phase
            </span>
            <div className="flex border border-border-mid">
              <SegmentButton
                active={task.position === "before"}
                tone="lime"
                onClick={() => onUpdate({ position: "before" })}
                label="Before build"
              />
              <SegmentButton
                active={task.position === "after"}
                tone="lime"
                onClick={() => onUpdate({ position: "after" })}
                label="After build"
                bordered
              />
            </div>
          </div>
        ) : undefined}
      </div>
    </div>
  );
}

/** A segmented-toggle button. Active state tints lime (in-build) or violet (separate job). */
function SegmentButton({
  active,
  tone,
  onClick,
  label,
  bordered,
}: {
  active: boolean;
  tone: "lime" | "violet";
  onClick: () => void;
  label: string;
  bordered?: boolean;
}) {
  const activeClass =
    tone === "lime"
      ? "bg-accent-dim text-primary-ink shadow-[inset_0_0_0_1px_var(--primary-ink)]"
      : "bg-violet-accent/10 text-violet-accent shadow-[inset_0_0_0_1px_var(--violet-accent)]";
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "px-3 py-1.5 font-mono text-3xs font-bold uppercase tracking-wider transition-colors",
        bordered && "border-l border-border-mid",
        active ? activeClass : "text-text-secondary hover:text-text-primary",
      )}
    >
      {label}
    </button>
  );
}

/** A compact label + blacklight dropdown for the App / Repo picker. */
function TaskPicker({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <span className="flex items-center gap-2">
      <span className="font-mono text-3xs font-bold uppercase tracking-widest text-text-secondary">{label}</span>
      <Select<string> value={value} onValueChange={(next) => onChange(next ?? value)}>
        <SelectTrigger className="h-8 w-44 font-mono text-2xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value} className="font-mono text-2xs">
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </span>
  );
}

/** The lime/violet explainer contrasting an in-build task against a separate job. */
function WhereExplainer({ multiRepo }: { multiRepo: boolean }) {
  return (
    <div className="flex flex-col gap-2.5 border border-border-dim bg-surface-void p-3.5">
      <span className="flex items-center gap-1.5 font-mono text-3xs font-bold uppercase tracking-widest text-text-secondary">
        <InfoIcon size={12} />
        Where does it run?
      </span>
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="flex flex-1 flex-col gap-2 border border-primary-ink p-3">
          <span className="font-mono text-3xs font-bold uppercase tracking-widest text-primary-ink">
            ▣ In the build
          </span>
          <div className="flex flex-wrap items-center gap-1.5 font-mono text-4xs uppercase tracking-wider text-text-secondary">
            <span className="border border-border-mid px-1.5 py-1">before</span>
            <span className="text-border-mid">→</span>
            <span className="border border-primary-ink px-1.5 py-1 text-primary-ink">app build</span>
            <span className="text-border-mid">→</span>
            <span className="border border-border-mid px-1.5 py-1">after</span>
          </div>
          <span className="text-2xs leading-relaxed text-text-secondary">
            Recorded as a build-phase task. Today it runs as a standalone job from the app's built image; the
            before/after-build ordering isn't wired up yet.
          </span>
        </div>
        <div className="flex flex-1 flex-col gap-2 border border-violet-accent p-3">
          <span className="font-mono text-3xs font-bold uppercase tracking-widest text-violet-accent">
            ▢ Separate job
          </span>
          <span className="w-max border border-violet-accent px-1.5 py-1 font-mono text-4xs uppercase tracking-wider text-violet-accent">
            your command
          </span>
          <span className="text-2xs leading-relaxed text-text-secondary">
            Its own throwaway container, run from the primary app's image between infra and app startup. Never touches
            an app pod.
          </span>
        </div>
      </div>
      {multiRepo ? (
        <p className="border-t border-border-dim pt-2 text-2xs leading-relaxed text-text-secondary">
          The <span className="text-text-primary">Repo</span> picker shows because this preview spans more than one
          repo. It's recorded with the task, though today every job runs from the primary app's image.
        </p>
      ) : undefined}
    </div>
  );
}

function FieldColumn({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <span className="font-mono text-3xs font-bold uppercase tracking-widest text-text-secondary">{label}</span>
      {children}
    </div>
  );
}
