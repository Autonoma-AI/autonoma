import {
  Badge,
  Button,
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Textarea,
  cn,
} from "@autonoma/blacklight";
import {
  isDeprecatedBuildFramework,
  PREVIEWKIT_RUNTIME_CATALOG,
  PREVIEWKIT_RUNTIMES,
  PREVIEWKIT_TOOLBELT,
  previewkitRuntimeImage,
  type PreviewkitRuntime,
  type PreviewkitRuntimeSpec,
} from "@autonoma/types";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { FileIcon } from "@phosphor-icons/react/File";
import { FolderIcon } from "@phosphor-icons/react/Folder";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { useDockerfiles } from "lib/query/onboarding.queries";
import { useState } from "react";
import { FieldMessages } from "./field-messages";
import {
  fieldIssueKey,
  type AppBuildMode,
  type AppDraft,
  type AppDraftField,
  type DraftIssues,
} from "./topology-draft";

// The build modes are keyed internally by AppBuildMode; "Manual" is the display
// name for the "runtime" escape hatch (an app's build union still compiles to
// `framework: "runtime"` - only the user-facing wording changed). Manual leads
// because it is the primary path; "auto" is not offered as a choice - an app that
// loaded with no build block or a framework preset keeps auto-detection until the
// user picks a method here.
const MODE_OPTIONS: Array<{ id: AppBuildMode; label: string; hint: string }> = [
  { id: "runtime", label: "Manual", hint: "Pick a runtime and write the build yourself." },
  { id: "dockerfile", label: "Dockerfile", hint: "We build an existing Dockerfile from your repo." },
];

// Nested-tree indentation per depth level (px), applied inline so an arbitrary
// depth stays expressible. The base pad keeps level 0 off the edge.
const TREE_INDENT_PX = 16;
const TREE_BASE_PAD_PX = 8;

interface BuildModeSectionProps {
  app: AppDraft;
  /** The Application, so the Dockerfile picker can query its repo file tree. */
  applicationId: string;
  /** The app's repo (undefined = the Application's primary repo). Scopes the file tree query. */
  githubRepositoryId?: number;
  issues: DraftIssues;
  onChange: (id: number, patch: Partial<AppDraft>) => void;
}

/**
 * An app's build method: a three-way choice between autodetection, an existing
 * Dockerfile, and manual mode (pick a runtime, write a bash build script +
 * entrypoint). Leads the app card because the choice governs which of the app's
 * other fields matter (e.g. build context). Manual mode renders the runtime
 * picker side by side with a live build spec. Compiles via `topology-draft`'s
 * `compileApp`.
 */
export function BuildModeSection({ app, applicationId, githubRepositoryId, issues, onChange }: BuildModeSectionProps) {
  const activeHint = MODE_OPTIONS.find((mode) => mode.id === app.buildMode)?.hint ?? "";
  const modeInvalid = hasFieldError(issues, app.id, "buildMode");

  function selectMode(mode: AppBuildMode) {
    // Picking any mode is an explicit override, so drop a preserved framework-preset
    // build block (see AppDraft.buildPassthrough) - the user is choosing anew.
    if (mode !== "runtime") {
      onChange(app.id, { buildMode: mode, buildPassthrough: undefined });
      return;
    }
    // Entering manual mode: seed the build script + entrypoint from the current
    // runtime's defaults when they are still blank, so the editor is never empty.
    const spec = PREVIEWKIT_RUNTIME_CATALOG[app.runtime];
    const patch: Partial<AppDraft> = { buildMode: "runtime", buildPassthrough: undefined };
    if (app.buildScript.trim() === "") patch.buildScript = spec.defaultBuildScript;
    if (app.entrypoint.trim() === "") patch.entrypoint = spec.defaultEntrypoint;
    onChange(app.id, patch);
  }

  return (
    <div>
      <Label>Build method</Label>
      <div className={cn("mt-2 flex w-fit border", modeInvalid ? "border-status-critical" : "border-border-dim")}>
        {MODE_OPTIONS.map((mode, index) => (
          <button
            key={mode.id}
            type="button"
            onClick={() => selectMode(mode.id)}
            aria-pressed={app.buildMode === mode.id}
            className={cn(
              "px-5 py-2 text-2xs font-medium transition-colors",
              index > 0 && "border-l border-border-dim",
              app.buildMode === mode.id
                ? "bg-primary/15 text-primary-ink"
                : "text-text-secondary hover:bg-surface-raised hover:text-text-primary",
            )}
          >
            {mode.label}
          </button>
        ))}
      </div>
      {activeHint !== "" ? <p className="mt-2 text-2xs text-text-secondary">{activeHint}</p> : undefined}
      <FieldMessages issues={issues} draftId={app.id} field="buildMode" />

      {app.buildMode === "auto" ? (
        <p className="mt-2 text-2xs text-text-secondary">
          {app.buildPassthrough == null ? (
            "This app currently uses auto-detection. Pick a method above to configure it explicitly."
          ) : isDeprecatedBuildFramework(app.buildPassthrough.framework) ? (
            <>
              Its preview keeps deploying with the retired{" "}
              <span className="font-mono text-text-primary">{app.buildPassthrough.framework}</span> preset until you
              pick a method above.
            </>
          ) : (
            <>
              Keeping this app&apos;s existing{" "}
              <span className="font-mono text-text-primary">{app.buildPassthrough.framework}</span> build config. Pick a
              method above to configure it explicitly.
            </>
          )}
        </p>
      ) : undefined}

      {app.buildMode === "dockerfile" ? (
        <DockerfilePicker
          app={app}
          applicationId={applicationId}
          githubRepositoryId={githubRepositoryId}
          issues={issues}
          onChange={onChange}
        />
      ) : undefined}

      {app.buildMode === "runtime" ? <ManualEditor app={app} issues={issues} onChange={onChange} /> : undefined}
    </div>
  );
}

interface FileTreeNode {
  name: string;
  /** Full repo-relative path (e.g. `apps/web/Dockerfile`). */
  path: string;
  isFile: boolean;
  children: FileTreeNode[];
}

/** Builds a nested folder/file tree from a flat list of blob paths, dirs before files, alpha within. */
function buildFileTree(paths: readonly string[]): FileTreeNode[] {
  const root: FileTreeNode = { name: "", path: "", isFile: false, children: [] };
  const dirs = new Map<string, FileTreeNode>([["", root]]);
  for (const path of paths) {
    const segments = path.split("/");
    let parent = root;
    let prefix = "";
    for (const [index, segment] of segments.entries()) {
      const nodePath = prefix === "" ? segment : `${prefix}/${segment}`;
      const isFile = index === segments.length - 1;
      if (isFile) {
        parent.children.push({ name: segment, path: nodePath, isFile: true, children: [] });
      } else {
        let dir = dirs.get(nodePath);
        if (dir == null) {
          dir = { name: segment, path: nodePath, isFile: false, children: [] };
          parent.children.push(dir);
          dirs.set(nodePath, dir);
        }
        parent = dir;
      }
      prefix = nodePath;
    }
  }
  sortTreeNodes(root);
  return root.children;
}

function sortTreeNodes(node: FileTreeNode): void {
  node.children.sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  for (const child of node.children) {
    if (!child.isFile) sortTreeNodes(child);
  }
}

/**
 * Every folder that contains a Dockerfile, so the browser opens fully expanded.
 * `paths` is already narrowed to Dockerfiles server-side, so this is every
 * ancestor directory of every path.
 */
function defaultExpandedDirs(paths: readonly string[]): Set<string> {
  const dirs = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      dirs.add(segments.slice(0, depth).join("/"));
    }
  }
  return dirs;
}

/**
 * Dockerfile path field for the `dockerfile` build mode. Renders a select-style
 * trigger that opens a modal browser over the repo's Dockerfiles; picking one
 * fills the path. Falls back to a plain text input whenever the tree can't back
 * a browser - GitHub unavailable, no Dockerfile in the repo, or a tree too large
 * to list - or when the user opts into a custom path.
 */
function DockerfilePicker({ app, applicationId, githubRepositoryId, issues, onChange }: BuildModeSectionProps) {
  const dockerfilesQuery = useDockerfiles(applicationId, githubRepositoryId, true);
  const [customPath, setCustomPath] = useState(false);
  const [browsing, setBrowsing] = useState(false);

  const data = dockerfilesQuery.data;
  // The endpoint returns only Dockerfiles; a truncated tree means the set may be
  // incomplete, so fall back to free-text rather than offer a partial list.
  const dockerfiles = data != null && !data.truncated ? data.paths : [];
  const hasDockerfiles = dockerfiles.length > 0;
  const current = app.dockerfile.trim();
  const invalid = hasFieldError(issues, app.id, "dockerfile");
  const controlId = `pk-app-${app.id}-dockerfile`;

  function pickFile(path: string) {
    onChange(app.id, { dockerfile: path });
    setBrowsing(false);
  }

  return (
    <div className="mt-4 max-w-md">
      <Label htmlFor={controlId}>Dockerfile path</Label>
      {dockerfilesQuery.isLoading ? (
        <Input disabled placeholder="Loading repo files..." className="mt-2 font-mono" />
      ) : !hasDockerfiles || customPath ? (
        <div className="mt-2">
          <Input
            id={controlId}
            value={app.dockerfile}
            onChange={(event) => onChange(app.id, { dockerfile: event.target.value })}
            placeholder="path/to/Dockerfile"
            aria-invalid={invalid}
            className={cn("font-mono", invalidClass(issues, app.id, "dockerfile"))}
          />
          {hasDockerfiles ? (
            <Button
              type="button"
              variant="link"
              size="xs"
              className="mt-1 h-auto p-0 text-2xs"
              onClick={() => setCustomPath(false)}
            >
              Browse Dockerfiles instead
            </Button>
          ) : undefined}
        </div>
      ) : (
        <div className="mt-2">
          <button
            type="button"
            id={controlId}
            onClick={() => setBrowsing(true)}
            className={cn(
              "flex h-9 w-full items-center justify-between gap-2 border bg-surface-void px-3 font-mono text-sm transition-colors hover:border-border-mid focus:outline-none focus-visible:ring-1 focus-visible:ring-primary",
              invalid ? "border-status-critical" : "border-border-dim",
            )}
          >
            <span className={cn("truncate", current === "" && "text-text-secondary")}>
              {current === "" ? "Select a Dockerfile..." : current}
            </span>
            <FolderIcon size={16} className="shrink-0 text-text-secondary" />
          </button>
          <Button
            type="button"
            variant="link"
            size="xs"
            className="mt-1 h-auto p-0 text-2xs"
            onClick={() => setCustomPath(true)}
          >
            Enter a custom path instead
          </Button>
          <FileBrowserDialog
            open={browsing}
            onOpenChange={setBrowsing}
            paths={dockerfiles}
            current={current}
            onSelect={pickFile}
          />
        </div>
      )}
      <p className="mt-1 text-2xs text-text-secondary">Path to your Dockerfile, relative to the build context.</p>
      <FieldMessages issues={issues} draftId={app.id} field="dockerfile" />
    </div>
  );
}

/**
 * Modal Dockerfile browser. `paths` is already narrowed to the repo's
 * Dockerfiles. With no filter it shows them in an expandable folder tree; typing
 * a filter flattens the view to matching paths. Selecting one resolves the pick.
 */
function FileBrowserDialog({
  open,
  onOpenChange,
  paths,
  current,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paths: readonly string[];
  current: string;
  onSelect: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  // Every folder that holds a Dockerfile is expanded by default, so likely
  // candidates are visible the moment the browser opens (the browser only mounts
  // once the tree has loaded, so `paths` is already populated here).
  const [expanded, setExpanded] = useState<Set<string>>(() => defaultExpandedDirs(paths));

  function handleOpenChange(next: boolean) {
    // Reset the filter and the expansion back to the Dockerfile folders on close,
    // so a later re-open starts fresh rather than from wherever the user left it.
    if (!next) {
      setQuery("");
      setExpanded(defaultExpandedDirs(paths));
    }
    onOpenChange(next);
  }

  function toggleDir(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  const trimmed = query.trim().toLowerCase();
  const tree = trimmed === "" ? buildFileTree(paths) : [];
  const matches = trimmed === "" ? [] : paths.filter((path) => path.toLowerCase().includes(trimmed));

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogBackdrop />
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Select a Dockerfile</DialogTitle>
          <DialogDescription>Pick the Dockerfile to build this app from, anywhere in the repo.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 px-6 pb-2">
          <div className="relative">
            <MagnifyingGlassIcon
              size={14}
              className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 text-text-secondary"
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter Dockerfiles"
              className="pl-9 font-mono"
            />
          </div>
          <div className="max-h-96 overflow-y-auto border border-border-dim">
            {trimmed === "" ? (
              <FileTree
                nodes={tree}
                depth={0}
                expanded={expanded}
                current={current}
                onToggleDir={toggleDir}
                onSelect={onSelect}
              />
            ) : matches.length > 0 ? (
              matches.map((path) => (
                <FileRow
                  key={path}
                  label={path}
                  depth={0}
                  selected={path === current}
                  onSelect={() => onSelect(path)}
                />
              ))
            ) : (
              <p className="px-3 py-6 text-center text-2xs text-text-secondary">
                No Dockerfiles match &ldquo;{query.trim()}&rdquo;.
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FileTree({
  nodes,
  depth,
  expanded,
  current,
  onToggleDir,
  onSelect,
}: {
  nodes: FileTreeNode[];
  depth: number;
  expanded: Set<string>;
  current: string;
  onToggleDir: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  return (
    <>
      {nodes.map((node) =>
        node.isFile ? (
          <FileRow
            key={node.path}
            label={node.name}
            depth={depth}
            selected={node.path === current}
            onSelect={() => onSelect(node.path)}
          />
        ) : (
          <div key={node.path}>
            <button
              type="button"
              onClick={() => onToggleDir(node.path)}
              aria-expanded={expanded.has(node.path)}
              className="flex w-full items-center gap-1.5 py-1 pr-2 text-left text-sm hover:bg-surface-raised"
              style={{ paddingInlineStart: depth * TREE_INDENT_PX + TREE_BASE_PAD_PX }}
            >
              {expanded.has(node.path) ? (
                <CaretDownIcon size={12} className="shrink-0 text-text-secondary" />
              ) : (
                <CaretRightIcon size={12} className="shrink-0 text-text-secondary" />
              )}
              <FolderIcon
                size={14}
                weight={expanded.has(node.path) ? "fill" : "regular"}
                className="shrink-0 text-text-secondary"
              />
              <span className="truncate font-mono text-text-primary">{node.name}</span>
            </button>
            {expanded.has(node.path) ? (
              <FileTree
                nodes={node.children}
                depth={depth + 1}
                expanded={expanded}
                current={current}
                onToggleDir={onToggleDir}
                onSelect={onSelect}
              />
            ) : undefined}
          </div>
        ),
      )}
    </>
  );
}

function FileRow({
  label,
  depth,
  selected,
  onSelect,
}: {
  label: string;
  depth: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex w-full items-center gap-1.5 py-1 pr-2 text-left text-sm hover:bg-surface-raised",
        selected && "bg-accent-dim",
      )}
      style={{ paddingInlineStart: depth * TREE_INDENT_PX + TREE_BASE_PAD_PX }}
    >
      <FileIcon size={14} className="shrink-0 text-primary-ink" />
      <span className="truncate font-mono text-text-primary">{label}</span>
      {selected ? <CheckIcon size={13} weight="bold" className="ml-auto shrink-0 text-primary-ink" /> : undefined}
    </button>
  );
}

function ManualEditor({ app, issues, onChange }: Pick<BuildModeSectionProps, "app" | "issues" | "onChange">) {
  const spec = PREVIEWKIT_RUNTIME_CATALOG[app.runtime];

  function selectRuntime(id: PreviewkitRuntime) {
    const previous = PREVIEWKIT_RUNTIME_CATALOG[app.runtime];
    const next = PREVIEWKIT_RUNTIME_CATALOG[id];
    const patch: Partial<AppDraft> = { runtime: id, runtimeVersion: "" };
    // Replace the build script / entrypoint with the new runtime's defaults only
    // when the user hasn't diverged from the previous runtime's defaults.
    if (app.buildScript.trim() === "" || app.buildScript === previous.defaultBuildScript) {
      patch.buildScript = next.defaultBuildScript;
    }
    if (app.entrypoint.trim() === "" || app.entrypoint === previous.defaultEntrypoint) {
      patch.entrypoint = next.defaultEntrypoint;
    }
    onChange(app.id, patch);
  }

  return (
    <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0 space-y-5">
        <RuntimeTiles runtimes={PREVIEWKIT_RUNTIMES} selected={app.runtime} onSelect={selectRuntime} />

        <div className="max-w-xs">
          <Label htmlFor={`pk-app-${app.id}-runtime-version`}>Version</Label>
          <Input
            id={`pk-app-${app.id}-runtime-version`}
            list={`pk-app-${app.id}-runtime-versions`}
            value={app.runtimeVersion}
            placeholder={spec.defaultVersion}
            onChange={(event) => onChange(app.id, { runtimeVersion: event.target.value })}
            aria-invalid={hasFieldError(issues, app.id, "runtimeVersion")}
            className={cn("mt-2 font-mono", invalidClass(issues, app.id, "runtimeVersion"))}
          />
          <datalist id={`pk-app-${app.id}-runtime-versions`}>
            {spec.versions.map((version) => (
              <option key={version} value={version} />
            ))}
          </datalist>
          <p className="mt-1 text-2xs text-text-secondary">
            {spec.label} tag. Blank uses {spec.defaultVersion}; any published tag works.
          </p>
          <FieldMessages issues={issues} draftId={app.id} field="runtimeVersion" />
        </div>

        <div>
          <div className="flex items-center justify-between">
            <Label htmlFor={`pk-app-${app.id}-build-script`}>Build script</Label>
            <Badge variant="outline" className="font-mono text-4xs uppercase">
              bash
            </Badge>
          </div>
          <Textarea
            id={`pk-app-${app.id}-build-script`}
            rows={4}
            value={app.buildScript}
            placeholder={spec.defaultBuildScript}
            onChange={(event) => onChange(app.id, { buildScript: event.target.value })}
            className="mt-2 font-mono text-2xs"
          />
          <p className="mt-1 text-2xs text-text-secondary">Runs at image build, from the repo root. Optional.</p>
          <FieldMessages issues={issues} draftId={app.id} field="buildScript" />
        </div>

        <div>
          <Label htmlFor={`pk-app-${app.id}-entrypoint`}>Entrypoint</Label>
          <Input
            id={`pk-app-${app.id}-entrypoint`}
            value={app.entrypoint}
            placeholder={spec.defaultEntrypoint}
            onChange={(event) => onChange(app.id, { entrypoint: event.target.value })}
            aria-invalid={hasFieldError(issues, app.id, "entrypoint")}
            className={cn("mt-2 font-mono", invalidClass(issues, app.id, "entrypoint"))}
          />
          <p className="mt-1 text-2xs text-text-secondary">The command that starts the container.</p>
          <FieldMessages issues={issues} draftId={app.id} field="entrypoint" />
        </div>
      </div>

      <SpecRail app={app} spec={spec} />
    </div>
  );
}

function RuntimeTiles({
  runtimes,
  selected,
  onSelect,
}: {
  runtimes: readonly PreviewkitRuntimeSpec[];
  selected: PreviewkitRuntime;
  onSelect: (id: PreviewkitRuntime) => void;
}) {
  return (
    <div>
      <Label>Runtime</Label>
      <div className="mt-2 grid grid-cols-2 gap-2 xl:grid-cols-3">
        {runtimes.map((runtime) => {
          const active = runtime.id === selected;
          return (
            <button
              key={runtime.id}
              type="button"
              onClick={() => onSelect(runtime.id)}
              aria-pressed={active}
              className={cn(
                "flex items-center gap-3 border p-3 text-left transition-colors",
                active
                  ? "border-primary bg-primary/10"
                  : "border-border-dim bg-surface-void hover:border-border-mid hover:bg-surface-raised",
              )}
            >
              <span
                className={cn(
                  "inline-flex h-11 w-12 shrink-0 items-center justify-center font-mono text-sm font-bold",
                  active ? "bg-primary text-primary-foreground" : "bg-surface-raised text-text-secondary",
                )}
              >
                {runtime.abbr}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium text-text-primary">{runtime.label}</span>
                <span className="block font-mono text-3xs text-text-secondary">
                  {runtime.raw ? "bare image" : runtime.defaultVersion}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-2xs text-text-secondary">
        Pick a language, or Debian for a bare image you set up yourself.
      </p>
    </div>
  );
}

function SpecRail({ app, spec }: { app: AppDraft; spec: PreviewkitRuntimeSpec }) {
  const [showToolbelt, setShowToolbelt] = useState(false);
  const nameDisplay = app.name.trim() === "" ? "untitled-app" : app.name.trim();
  const image = previewkitRuntimeImage(
    app.runtime,
    app.runtimeVersion.trim() === "" ? undefined : app.runtimeVersion.trim(),
  );
  const entrypoint = app.entrypoint.trim() === "" ? spec.defaultEntrypoint : app.entrypoint.trim();
  // Drop any common-toolbelt entry the runtime already lists as a primary tool so
  // it is not shown twice (e.g. make appears in both for some runtimes).
  const toolbelt = PREVIEWKIT_TOOLBELT[spec.base].display.filter((tool) => !spec.tools.includes(tool));

  return (
    <div className="h-fit border border-border-dim bg-surface-base lg:sticky lg:top-20">
      <div className="flex items-center gap-2 border-b border-border-dim px-4 py-2.5">
        <span className="size-1.5 bg-primary" />
        <span className="font-mono text-3xs font-bold uppercase tracking-widest text-text-secondary">Build spec</span>
      </div>
      <div className="space-y-2 px-4 py-3 font-mono text-2xs">
        <SpecRow label="runtime">
          <span className="text-primary-ink">
            {spec.label} · {app.runtimeVersion.trim() === "" ? spec.defaultVersion : app.runtimeVersion.trim()}
          </span>
        </SpecRow>
        <SpecRow label="image">
          <a
            href={spec.dockerHubUrl}
            target="_blank"
            rel="noopener"
            className="inline-flex items-center gap-1 truncate text-text-primary underline decoration-dotted underline-offset-2 hover:text-primary-ink"
          >
            {image}
            <ArrowSquareOutIcon size={11} className="shrink-0" />
          </a>
        </SpecRow>
        <SpecRow label="context">
          <span className="text-text-primary">repo root</span>
        </SpecRow>
        <SpecRow label="workdir">
          <span className="truncate text-text-primary">/workspace/{nameDisplay}</span>
        </SpecRow>
        <SpecRow label="entry">
          <span className="truncate text-text-primary">{entrypoint}</span>
        </SpecRow>
      </div>
      <div className="border-t border-border-dim px-4 py-3">
        <p className="font-mono text-4xs font-bold uppercase tracking-widest text-text-secondary">Installed for you</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {spec.tools.map((tool) => (
            <ToolChip key={tool} tool={tool} />
          ))}
          {showToolbelt ? toolbelt.map((tool) => <ToolChip key={tool} tool={tool} dim />) : undefined}
        </div>
        {toolbelt.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowToolbelt(!showToolbelt)}
            className="mt-2 font-mono text-4xs uppercase tracking-widest text-primary-ink hover:opacity-80"
          >
            {showToolbelt ? "Show less" : `+ ${toolbelt.length} common tools`}
          </button>
        ) : undefined}
      </div>
    </div>
  );
}

function SpecRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 gap-3">
      <span className="w-14 shrink-0 text-text-secondary">{label}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </div>
  );
}

function ToolChip({ tool, dim = false }: { tool: string; dim?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 border border-border-mid px-1.5 py-0.5 font-mono text-4xs",
        dim ? "text-text-secondary" : "text-text-primary",
      )}
    >
      <span className={cn("size-1", dim ? "bg-border-highlight" : "bg-primary")} />
      {tool}
    </span>
  );
}

function hasFieldError(issues: DraftIssues, draftId: number, field: AppDraftField): boolean {
  return issues.fieldErrors.has(fieldIssueKey(draftId, field));
}

function invalidClass(issues: DraftIssues, draftId: number, field: AppDraftField): string | undefined {
  return hasFieldError(issues, draftId, field) ? "border-status-critical" : undefined;
}
