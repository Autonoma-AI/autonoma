import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from "@autonoma/blacklight";
import type { Build, BuildFramework } from "@autonoma/types";

interface BuildSettingsSectionProps {
  /** Used to namespace input ids within an app card. */
  appId: number;
  /** App (package) name - shown in the turbo `--filter` default for root builds. */
  appName: string;
  /** Current build config, or undefined for the Railpack autodetect fallback. */
  build: Build | undefined;
  onChange: (build: Build | undefined) => void;
}

/**
 * Flat, UI-friendly view of an app's `build` config. The `framework` selector is
 * the single build-strategy choice; `auto` maps to "no build block" (Railpack
 * autodetect). Converted to/from the `Build` discriminated union by
 * {@link fromBuild} / {@link toBuild} so the component never spreads across the
 * union (which would need a cast).
 */
interface BuildForm {
  // This legacy form models the framework presets + dockerfile + auto. The manual
  // "runtime" escape hatch is authored in the app card's build-mode selector, not
  // here, so it is excluded from this form's framework choice.
  framework: Exclude<BuildFramework, "runtime"> | "auto";
  packageManager: "npm" | "pnpm" | "yarn";
  nodeVersion: string;
  installCommand?: string;
  buildCommand?: string;
  runCommand?: string;
  buildContext: "app" | "root";
  dockerfile: string;
}

const FRAMEWORK_OPTIONS: Array<{ value: BuildForm["framework"]; label: string }> = [
  { value: "auto", label: "Auto-detect (Railpack)" },
  { value: "node", label: "Node" },
  { value: "bun", label: "Bun" },
  { value: "next", label: "Next.js" },
  { value: "vite", label: "Vite" },
  { value: "dockerfile", label: "Custom Dockerfile" },
];

const PACKAGE_MANAGERS: Array<BuildForm["packageManager"]> = ["pnpm", "npm", "yarn"];
const NODE_VERSIONS = ["22", "20", "18", "24"];
const BUILD_CONTEXT_LABELS: Record<BuildForm["buildContext"], string> = {
  app: "App directory",
  root: "Repository root (workspace)",
};

/** One deployable app's build strategy: framework preset + derived/overridable commands. */
export function BuildSettingsSection({ appId, appName, build, onChange }: BuildSettingsSectionProps) {
  const form = fromBuild(build);
  const filterName = appName.trim() === "" ? "<app>" : appName.trim();
  const isNodeFramework = form.framework === "node" || form.framework === "next" || form.framework === "vite";
  const isGenerated = isNodeFramework || form.framework === "bun";

  function emit(patch: Partial<BuildForm>) {
    onChange(toBuild({ ...form, ...patch }));
  }

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor={`pk-app-${appId}-framework`}>Framework preset</Label>
        <Select<BuildForm["framework"]>
          value={form.framework}
          onValueChange={(framework) => {
            if (framework != null) emit({ framework });
          }}
        >
          <SelectTrigger id={`pk-app-${appId}-framework`} className="mt-2 w-full">
            <SelectValue>{frameworkLabel(form.framework)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {FRAMEWORK_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {form.framework === "auto" ? (
        <p className="text-2xs text-text-secondary">
          previewkit auto-detects the language and build with Railpack. An on-disk Dockerfile, if present, is used
          instead.
        </p>
      ) : undefined}

      {isNodeFramework ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor={`pk-app-${appId}-pm`}>Package manager</Label>
            <Select<BuildForm["packageManager"]>
              value={form.packageManager}
              onValueChange={(packageManager) => {
                if (packageManager != null) emit({ packageManager });
              }}
            >
              <SelectTrigger id={`pk-app-${appId}-pm`} className="mt-2 w-full">
                <SelectValue>{form.packageManager}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {PACKAGE_MANAGERS.map((pm) => (
                  <SelectItem key={pm} value={pm}>
                    {pm}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor={`pk-app-${appId}-node`}>Node.js version</Label>
            <Select<string>
              value={form.nodeVersion}
              onValueChange={(nodeVersion) => {
                if (nodeVersion != null) emit({ nodeVersion });
              }}
            >
              <SelectTrigger id={`pk-app-${appId}-node`} className="mt-2 w-full">
                <SelectValue>{`${form.nodeVersion}.x`}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {NODE_VERSIONS.map((version) => (
                  <SelectItem key={version} value={version}>
                    {`${version}.x`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      ) : undefined}

      {isGenerated ? (
        <div className="space-y-4">
          <OverrideRow
            id={`pk-app-${appId}-install`}
            label="Install command"
            value={form.installCommand}
            defaultValue={deriveInstall(form)}
            onChange={(installCommand) => emit({ installCommand })}
          />
          <OverrideRow
            id={`pk-app-${appId}-build`}
            label="Build command"
            value={form.buildCommand}
            defaultValue={deriveBuild(form, filterName)}
            onChange={(buildCommand) => emit({ buildCommand })}
          />
          <OverrideRow
            id={`pk-app-${appId}-run`}
            label="Run command"
            value={form.runCommand}
            defaultValue={deriveRun(form, filterName)}
            onChange={(runCommand) => emit({ runCommand })}
          />
        </div>
      ) : undefined}

      {form.framework === "dockerfile" ? (
        <div>
          <Label htmlFor={`pk-app-${appId}-dockerfile-path`}>Dockerfile path</Label>
          <Input
            id={`pk-app-${appId}-dockerfile-path`}
            className="mt-2"
            value={form.dockerfile}
            onChange={(event) => emit({ dockerfile: event.target.value })}
            placeholder="./Dockerfile"
          />
          <p className="mt-1 text-2xs text-text-secondary">
            Your Dockerfile owns the build and runtime; the path is relative to the build context.
          </p>
        </div>
      ) : undefined}

      {form.framework !== "auto" ? (
        <div>
          <Label htmlFor={`pk-app-${appId}-build-context`}>Build context</Label>
          <Select<BuildForm["buildContext"]>
            value={form.buildContext}
            onValueChange={(buildContext) => {
              if (buildContext != null) emit({ buildContext });
            }}
          >
            <SelectTrigger id={`pk-app-${appId}-build-context`} className="mt-2 w-full">
              <SelectValue>{BUILD_CONTEXT_LABELS[form.buildContext]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="app">{BUILD_CONTEXT_LABELS.app}</SelectItem>
              <SelectItem value="root">{BUILD_CONTEXT_LABELS.root}</SelectItem>
            </SelectContent>
          </Select>
          {form.buildContext === "root" ? (
            <p className="mt-1 text-2xs text-text-secondary">
              Builds from the repository root so workspace dependencies resolve - use it for turbo / workspace
              monorepos, where the build and run commands are turbo-filtered to this app.
            </p>
          ) : undefined}
        </div>
      ) : undefined}
    </div>
  );
}

function OverrideRow({
  id,
  label,
  value,
  defaultValue,
  onChange,
}: {
  id: string;
  label: string;
  value: string | undefined;
  defaultValue: string;
  onChange: (value: string | undefined) => void;
}) {
  const overridden = value !== undefined;
  return (
    <div>
      <div className="flex items-center justify-between">
        <Label htmlFor={id}>{label}</Label>
        <div className="flex items-center gap-2">
          <span className="text-2xs text-text-secondary">Override</span>
          <Switch
            id={`${id}-override`}
            checked={overridden}
            onCheckedChange={(on) => onChange(on ? defaultValue : undefined)}
            aria-label={`Override ${label.toLowerCase()}`}
          />
        </div>
      </div>
      <Input
        id={id}
        className="mt-2"
        value={value ?? ""}
        placeholder={`${defaultValue} (default)`}
        disabled={!overridden}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function frameworkLabel(framework: BuildForm["framework"]): string {
  return FRAMEWORK_OPTIONS.find((option) => option.value === framework)?.label ?? "";
}

function toolFor(form: BuildForm): string {
  return form.framework === "bun" ? "bun" : form.packageManager;
}

function deriveInstall(form: BuildForm): string {
  const tool = toolFor(form);
  if (tool === "bun") return "bun install";
  if (tool === "npm") return "npm ci";
  return `${tool} install --frozen-lockfile`;
}

function deriveBuild(form: BuildForm, filterName: string): string {
  const tool = toolFor(form);
  if (form.buildContext === "root") return `${tool} turbo run build --filter=${filterName}`;
  return `${tool} run build`;
}

function deriveRun(form: BuildForm, filterName: string): string {
  const tool = toolFor(form);
  if (form.buildContext === "root") return `${tool} turbo run start --filter=${filterName}`;
  if (form.framework === "vite") return `${tool} run preview`;
  return `${tool} start`;
}

function fromBuild(build: Build | undefined): BuildForm {
  const base: BuildForm = {
    framework: "auto",
    packageManager: "pnpm",
    nodeVersion: "22",
    buildContext: "app",
    dockerfile: "",
  };
  if (build == null) return base;
  if (build.framework === "dockerfile") {
    return { ...base, framework: "dockerfile", buildContext: build.build_context, dockerfile: build.dockerfile };
  }
  if (build.framework === "bun") {
    return {
      ...base,
      framework: "bun",
      buildContext: build.build_context,
      installCommand: build.install_command,
      buildCommand: build.build_command,
      runCommand: build.run_command,
    };
  }
  if (build.framework === "runtime") {
    // Manual-runtime builds are authored in the app card's build-mode selector,
    // not this legacy preset form. Surface it as the auto default here rather than
    // mis-reading it as a node preset; the parent keeps the original build block
    // unless the user actively changes the framework in this form.
    return base;
  }
  return {
    ...base,
    framework: build.framework,
    packageManager: build.package_manager,
    nodeVersion: build.node_version,
    buildContext: build.build_context,
    installCommand: build.install_command,
    buildCommand: build.build_command,
    runCommand: build.run_command,
  };
}

function toBuild(form: BuildForm): Build | undefined {
  switch (form.framework) {
    case "auto":
      return undefined;
    case "dockerfile":
      return { framework: "dockerfile", dockerfile: form.dockerfile.trim(), build_context: form.buildContext };
    case "bun":
      return {
        framework: "bun",
        build_context: form.buildContext,
        install_command: form.installCommand,
        build_command: form.buildCommand,
        run_command: form.runCommand,
      };
    case "node":
      return nodeBuild("node", form);
    case "next":
      return nodeBuild("next", form);
    case "vite":
      return nodeBuild("vite", form);
  }
}

function nodeBuild(framework: "node", form: BuildForm): Build;
function nodeBuild(framework: "next", form: BuildForm): Build;
function nodeBuild(framework: "vite", form: BuildForm): Build;
function nodeBuild(framework: "node" | "next" | "vite", form: BuildForm): Build {
  const common = {
    package_manager: form.packageManager,
    node_version: form.nodeVersion,
    build_context: form.buildContext,
    install_command: form.installCommand,
    build_command: form.buildCommand,
    run_command: form.runCommand,
  };
  if (framework === "node") return { framework: "node", ...common };
  if (framework === "next") return { framework: "next", ...common };
  return { framework: "vite", ...common };
}
