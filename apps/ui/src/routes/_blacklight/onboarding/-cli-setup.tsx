import {
  Badge,
  BrailleSpinner,
  Button,
  Input,
  Label,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTitle,
} from "@autonoma/blacklight";
import { cn } from "@autonoma/blacklight";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CircleDashedIcon } from "@phosphor-icons/react/CircleDashed";
import { ClipboardTextIcon } from "@phosphor-icons/react/ClipboardText";
import { CloudArrowUpIcon } from "@phosphor-icons/react/CloudArrowUp";
import { FolderOpenIcon } from "@phosphor-icons/react/FolderOpen";
import { SpinnerGapIcon } from "@phosphor-icons/react/SpinnerGap";
import { TerminalWindowIcon } from "@phosphor-icons/react/TerminalWindow";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useAuth } from "lib/auth";
import { buildOnboardingSearch } from "lib/onboarding/onboarding-search";
import { useArtifactStatus } from "lib/query/app-generations.queries";
import { useApplicationSharedSecret, useCreateMinimalApplication } from "lib/query/applications.queries";
import { trpc, trpcClient } from "lib/trpc";
import posthog from "posthog-js";
import { useEffect, useRef, useState } from "react";
import { OnboardingPageHeader } from "./-components/onboarding-page-header";

// Display metadata for each artifact the CLI uploads, keyed by the `key` the
// `artifactStatus` query returns. Order matches the query's response.
const ARTIFACT_LABELS: Record<string, { name: string; desc: string }> = {
  recipe: { name: "recipe.json", desc: "How your test data is created" },
  tests: { name: "qa-tests/", desc: "Generated test cases" },
  kb: { name: "AUTONOMA.md", desc: "What your app does" },
  scenarios: { name: "scenarios.md", desc: "The data your tests run against" },
};

interface CliSetupProps {
  appId?: string;
}

// Module-scope guard: "started onboarding" is the top-of-funnel signup signal.
// Anchored on an explicit event (not a URL or tRPC procedure name) so it
// survives route/query-param/procedure refactors. Fires once per page load —
// StrictMode double-invokes effects and the reset flow remounts this page, and
// the insight counts unique users, so a hard guard keeps it clean either way.
let hasTrackedOnboardingStarted = false;

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const value = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))?.[1];
  return value != null ? decodeURIComponent(value) : null;
}

function extractId(value: unknown): string | undefined {
  if (typeof value === "object" && value != null && "id" in value && typeof value.id === "string") {
    return value.id;
  }
  return undefined;
}

export function CliSetupPage({ appId }: CliSetupProps) {
  const navigate = useNavigate();
  const hasApp = appId != null && appId.length > 0;

  useEffect(() => {
    if (hasTrackedOnboardingStarted) return;
    hasTrackedOnboardingStarted = true;

    // Source breakdown (Direct/Search/Social/AI) is person-level
    // ($initial_referring_domain, stitched from the website via ph_id), so it
    // attaches automatically. referring_blog/hypothesis come from the
    // cross-domain cookies main.tsx writes, for blog-level attribution.
    posthog.capture("onboarding_started", {
      step: "cli-setup",
      referring_blog: readCookie("autonoma_referring_blog"),
      hypothesis: readCookie("autonoma_hypothesis"),
    });
  }, []);

  if (!hasApp) {
    return (
      <NameStep
        onCreated={(id) => {
          // Put the new app id in the URL so a refresh keeps us in the CLI setup
          // instead of dropping back to "create application".
          void navigate({ to: "/onboarding", search: buildOnboardingSearch("cli-setup", id) });
        }}
      />
    );
  }

  return <SetupStep applicationId={appId} />;
}

function maskSecret(value: string): string {
  if (value.length <= 4) return "••••••••";
  return `${value.slice(0, 4)}••••••••`;
}

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function NameStep({ onCreated }: { onCreated: (appId: string) => void }) {
  const [name, setName] = useState("");
  const [conflictError, setConflictError] = useState(false);
  const createApp = useCreateMinimalApplication();
  const { data: applications } = useSuspenseQuery(trpc.applications.list.queryOptions());

  const slug = toSlug(name.trim());
  const isTaken = conflictError || (slug.length > 0 && applications.some((app) => app.slug === slug));

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (name.trim().length === 0 || isTaken) return;
    createApp.mutate(
      { name: name.trim() },
      {
        onSuccess: (data) => onCreated(data.id),
        onError: (error) => {
          if (error.data?.code === "CONFLICT") {
            setConflictError(true);
          }
        },
      },
    );
  }

  return (
    <>
      <OnboardingPageHeader
        title="Create your application"
        description="Give your application a name, then connect the repository Autonoma will deploy with PreviewKit."
      />

      <form onSubmit={handleSubmit} className="mt-10 flex max-w-md flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Label htmlFor="app-name" className="font-mono text-2xs uppercase tracking-widest text-text-secondary">
            Application name
          </Label>
          <Input
            id="app-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setConflictError(false);
            }}
            placeholder="my-web-app"
            autoFocus
            className={cn(isTaken && "border-status-critical focus-visible:ring-status-critical")}
          />
          {isTaken && (
            <p className="font-mono text-3xs text-status-critical">
              An application named "{slug}" already exists. Choose a different name.
            </p>
          )}
        </div>
        <Button type="submit" disabled={name.trim().length === 0 || isTaken || createApp.isPending}>
          {createApp.isPending ? "Creating..." : "Create application"}
        </Button>
      </form>
    </>
  );
}

function SetupStep({ applicationId }: { applicationId: string }) {
  const navigate = useNavigate();
  const { user, isAdmin } = useAuth();
  const { data: sharedSecretData } = useApplicationSharedSecret(applicationId);
  const sharedSecret = sharedSecretData?.sharedSecret;
  const { data: artifactStatus } = useArtifactStatus(applicationId);
  const [copied, setCopied] = useState(false);
  const [stepOneExpanded, setStepOneExpanded] = useState(false);
  const [manualUploadOpen, setManualUploadOpen] = useState(false);
  const [uploadState, setUploadState] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [uploadError, setUploadError] = useState<string>();
  const [uploadedFiles, setUploadedFiles] = useState<string[]>([]);
  // apiKey + setupId live in the URL search params (not localStorage), so a
  // refresh keeps the same setup the CLI uploads to and the same command.
  const { apiKey, setupId } = useSearch({ from: "/_blacklight/onboarding" });
  const hasCreatedSetup = useRef(false);
  const hasAdvanced = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (hasCreatedSetup.current) return;
    // Credentials already in the URL (just created, or restored on refresh) -
    // reuse them so we keep the same setup the CLI uploads to.
    if (apiKey != null && setupId != null) return;
    hasCreatedSetup.current = true;

    async function bootstrap() {
      const keyResult = await trpcClient.apiKeys.create.mutate({ name: `cli-setup-${Date.now()}` });

      const setupResult = await fetch("/v1/setup/setups", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${keyResult.key}`,
        },
        body: JSON.stringify({ applicationId }),
      });
      const setup: unknown = await setupResult.json();
      const newSetupId = extractId(setup);
      if (newSetupId == null) throw new Error("Setup creation returned no id");

      // Persist in the URL search params (replace, not a new history entry) so a
      // refresh reuses the same setup + command.
      await navigate({
        to: "/onboarding",
        replace: true,
        search: buildOnboardingSearch("cli-setup", applicationId, { apiKey: keyResult.key, setupId: newSetupId }),
      });
    }

    bootstrap().catch((err: unknown) => {
      hasCreatedSetup.current = false;
      console.error("Failed to bootstrap CLI setup", err);
    });
  }, [apiKey, setupId, applicationId, navigate]);

  // Auto-advance once the CLI has uploaded everything and marked the setup
  // complete. The short delay lets the user register the "all received" state
  // before the page moves on.
  useEffect(() => {
    if (!artifactStatus.complete || hasAdvanced.current) return;
    hasAdvanced.current = true;
    const timeout = setTimeout(() => {
      void navigate({ to: "/onboarding", search: buildOnboardingSearch("scenario-dry-run", applicationId) });
    }, 1500);
    return () => clearTimeout(timeout);
  }, [artifactStatus.complete, applicationId, navigate]);

  // The command can only run once the upload credentials exist (API key + setup).
  const commandReady = apiKey != null && setupId != null;

  // The shared secret is generated server-side at app creation and surfaced here so the
  // CLI has it during its test-the-implementation step. The user sets the same value as
  // AUTONOMA_SHARED_SECRET on their deployment so the webhook can verify Autonoma's requests.
  const sharedSecretEnv = sharedSecret != null ? `AUTONOMA_SHARED_SECRET=${sharedSecret} ` : "";
  // Pass the user's PostHog distinct id (same id the app identifies by, see __root.tsx)
  // so the CLI's step events attach to the same person and the signup funnel extends
  // into the CLI instead of breaking at an anonymous, separate identity.
  const distinctIdEnv = user != null ? `AUTONOMA_DISTINCT_ID=${user.id} ` : "";
  // The token + setup id let the CLI upload its artifacts itself when it finishes,
  // against this pre-created API key + setup. AUTONOMA_GENERATION_ID is the setup id.
  // The CLI defaults its endpoint to production; override with AUTONOMA_API_URL.
  const uploadEnv = commandReady ? `AUTONOMA_API_TOKEN=${apiKey} AUTONOMA_GENERATION_ID=${setupId} ` : "";
  // OPENROUTER_API_KEY is intentionally not in the command - the CLI prompts for
  // it on first run and caches it to ~/.autonoma/.env.
  const command = `${sharedSecretEnv}${distinctIdEnv}${uploadEnv}npx @autonoma-ai/planner@latest`;

  // Render a redacted command so the long secret/token don't fill the block or leak on screen.
  // Copy still writes the real values via `command`.
  const displaySharedSecretEnv = sharedSecret != null ? `AUTONOMA_SHARED_SECRET=${maskSecret(sharedSecret)} ` : "";
  const displayDistinctIdEnv = user != null ? `AUTONOMA_DISTINCT_ID=${maskSecret(user.id)} ` : "";
  const displayUploadEnv = commandReady
    ? `AUTONOMA_API_TOKEN=${maskSecret(apiKey)} AUTONOMA_GENERATION_ID=${setupId} `
    : "";
  const displayCommand = `${displaySharedSecretEnv}${displayDistinctIdEnv}${displayUploadEnv}npx @autonoma-ai/planner@latest`;

  function handleCopy() {
    if (!commandReady) return;
    void navigator.clipboard.writeText(command);
    setCopied(true);
    // Collapse Step 1 so attention moves to the waiting state in Step 2.
    setStepOneExpanded(false);
  }

  async function handleFolderUpload(files: FileList) {
    if (apiKey == null || setupId == null) return;

    setUploadState("uploading");
    setUploadError(undefined);

    try {
      const fileEntries = await readAllFiles(files);
      const names = fileEntries.map((f) => f.name);
      setUploadedFiles(names);

      const recipeFile = fileEntries.find((f) => f.name === "recipe.json");
      if (recipeFile != null) {
        const recipeData = JSON.parse(recipeFile.content) as {
          recipes?: { validation?: Record<string, unknown> }[];
        };
        for (const recipe of recipeData.recipes ?? []) {
          if (recipe.validation != null && recipe.validation.phase == null) {
            recipe.validation.phase = "ok";
          }
        }
        await postToSetup(`/setups/${setupId}/scenario-recipe-versions`, apiKey, recipeData);
      }

      const testCases = fileEntries.filter(
        (f) =>
          (f.path.startsWith("qa-tests/") || f.path.startsWith("autonoma/qa-tests/")) &&
          f.name.endsWith(".md") &&
          f.name !== "INDEX.md",
      );
      const skills = fileEntries.filter((f) => f.path.startsWith("skills/") || f.path.startsWith("autonoma/skills/"));
      const artifacts = fileEntries.filter(
        (f) => f.name === "AUTONOMA.md" || f.name === "scenarios.md" || f.name === "entity-audit.md",
      );

      const artifactsBody: Record<string, { name: string; content: string; folder?: string }[]> = {};
      if (testCases.length > 0) {
        artifactsBody.testCases = testCases.map((f) => ({
          name: f.name,
          content: f.content,
          folder: f.folder,
        }));
      }
      if (skills.length > 0) {
        artifactsBody.skills = skills.map((f) => ({ name: f.name, content: f.content }));
      }
      if (artifacts.length > 0) {
        artifactsBody.artifacts = artifacts.map((f) => ({ name: f.name, content: f.content }));
      }

      if (Object.keys(artifactsBody).length > 0) {
        await postToSetup(`/setups/${setupId}/artifacts`, apiKey, artifactsBody);
      }

      setUploadState("done");
    } catch (err) {
      setUploadState("error");
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    }
  }

  function handleContinue() {
    void navigate({ to: "/onboarding", search: buildOnboardingSearch("scenario-dry-run", applicationId) });
  }

  const nextIdx = artifactStatus.artifacts.findIndex((artifact) => !artifact.received);
  const stepOneCollapsed = copied && !stepOneExpanded;

  return (
    <>
      <OnboardingPageHeader
        title="Set up your application"
        description="Run the CLI in your project root. It generates your test artifacts and uploads them here automatically - just keep going in your terminal."
      />

      <div className="mt-10 flex max-w-2xl flex-col gap-8">
        {/* Step 1 - the command. Collapses once copied so focus shifts to Step 2. */}
        <Panel className={cn("transition-opacity duration-300", stepOneCollapsed && "opacity-60 hover:opacity-100")}>
          <PanelHeader>
            <PanelTitle>
              <TerminalWindowIcon size={14} weight="duotone" className="text-primary-ink" />1 · Run in your project root
            </PanelTitle>
            <div className="flex items-center gap-2">
              {copied && (
                <Badge variant="success" className="gap-1">
                  <CheckCircleIcon size={11} weight="fill" />
                  Command copied
                </Badge>
              )}
              {copied ? (
                <Button variant="ghost" size="xs" onClick={() => setStepOneExpanded((v) => !v)}>
                  {stepOneExpanded ? "Hide" : "Show"}
                </Button>
              ) : (
                <Button
                  size="xs"
                  className={cn("gap-1.5", commandReady && "animate-pulse")}
                  disabled={!commandReady}
                  onClick={handleCopy}
                >
                  <ClipboardTextIcon size={14} />
                  {commandReady ? "Copy command" : "Preparing..."}
                </Button>
              )}
            </div>
          </PanelHeader>

          <div
            className={cn(
              "overflow-hidden transition-all duration-[400ms] ease-out",
              stepOneCollapsed ? "max-h-0 opacity-0" : "max-h-[640px] opacity-100",
            )}
          >
            <PanelBody className="flex flex-col gap-4">
              <pre className="whitespace-pre-wrap break-all border border-border-dim bg-surface-void p-4 font-mono text-xs leading-relaxed text-text-primary">
                {displayCommand}
              </pre>

              <p className="font-mono text-3xs text-text-secondary">
                The CLI prompts for an{" "}
                <a
                  href="https://openrouter.ai/keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary-ink underline underline-offset-2 transition-colors hover:text-text-primary"
                >
                  OpenRouter
                </a>{" "}
                API key on first run and remembers it - you won't need to paste it again.
              </p>

              <p className="border-l-2 border-primary bg-primary-ink/5 px-3 py-2 font-mono text-3xs leading-relaxed text-text-secondary">
                The CLI uploads your artifacts here automatically when it finishes. A full run can take an hour or more
                - you can close this tab and come back; this page keeps waiting.
              </p>
            </PanelBody>
          </div>
        </Panel>

        {/* Step 2 - the waiting state. Polls every 5s and auto-advances when complete. */}
        <Panel
          className={cn(
            "transition-shadow duration-500",
            copied &&
              !artifactStatus.complete &&
              "border-border-mid shadow-[0_0_0_1px_rgba(194,232,18,0.07),0_0_28px_rgba(194,232,18,0.05)]",
          )}
        >
          <PanelHeader>
            <PanelTitle>
              <CloudArrowUpIcon size={14} weight="duotone" className="text-primary-ink" />2 · Receiving artifacts
            </PanelTitle>
            {artifactStatus.complete ? (
              <span className="flex items-center gap-1.5 font-mono text-2xs uppercase tracking-wider text-status-success">
                <CheckCircleIcon size={12} weight="fill" />
                All received
              </span>
            ) : (
              <span className="flex items-center gap-1.5 font-mono text-2xs uppercase tracking-wider text-text-secondary">
                <BrailleSpinner size="sm" />
                Waiting for CLI
              </span>
            )}
          </PanelHeader>

          <PanelBody className="flex flex-col gap-4">
            <p className="font-mono text-3xs text-text-secondary">
              The CLI reads your app, maps your data models, and writes a test suite. Each piece shows up here as it
              finishes - this page updates on its own.
            </p>

            <ul className="flex flex-col">
              {artifactStatus.artifacts.map((artifact, i) => {
                const label = ARTIFACT_LABELS[artifact.key] ?? { name: artifact.key, desc: "" };
                const isNext = !artifactStatus.complete && i === nextIdx;
                const meta = artifact.received ? (artifact.meta ?? "received") : isNext ? "receiving..." : "pending";
                return (
                  <li
                    key={artifact.key}
                    className={cn(
                      "grid grid-cols-[20px_minmax(0,150px)_1fr_auto] items-center gap-3 border-b border-border-dim py-3 transition-opacity duration-300 last:border-b-0",
                      artifact.received || isNext ? "opacity-100" : "opacity-60",
                    )}
                  >
                    <span className="flex items-center justify-center">
                      {artifact.received ? (
                        <CheckCircleIcon size={16} weight="fill" className="text-status-success" />
                      ) : isNext ? (
                        <BrailleSpinner size="sm" className="text-text-secondary" />
                      ) : (
                        <CircleDashedIcon size={16} className="text-text-secondary" />
                      )}
                    </span>
                    <span
                      className={cn(
                        "font-mono text-xs",
                        artifact.received ? "text-text-primary" : "text-text-secondary",
                      )}
                    >
                      {label.name}
                    </span>
                    <span className="truncate font-mono text-3xs text-text-secondary">{label.desc}</span>
                    <span
                      className={cn(
                        "font-mono text-3xs",
                        artifact.received ? "text-status-success" : "text-text-secondary",
                      )}
                    >
                      {meta}
                    </span>
                  </li>
                );
              })}
            </ul>

            {artifactStatus.complete ? (
              <div className="flex items-center gap-3 border-l-2 border-status-success bg-status-success/5 px-4 py-3">
                <CheckCircleIcon size={16} weight="fill" className="shrink-0 text-status-success" />
                <span className="font-mono text-3xs leading-relaxed text-text-secondary">
                  All artifacts received. Continuing to{" "}
                  <strong className="font-medium text-text-primary">Deploy Autonoma SDK</strong>...
                </span>
                <BrailleSpinner size="sm" className="ml-auto text-status-success" />
              </div>
            ) : (
              <div className="flex items-start gap-3 border-l-2 border-primary bg-primary-ink/5 px-4 py-3">
                <TerminalWindowIcon size={16} weight="duotone" className="mt-0.5 shrink-0 text-primary-ink" />
                <span className="font-mono text-3xs leading-relaxed text-text-secondary">
                  Keep going in your terminal - answer the agent's prompts. Artifacts upload here automatically when
                  it's done.
                </span>
              </div>
            )}
          </PanelBody>
        </Panel>

        {/* Internal-only manual upload escape hatch (@autonoma.app admins). */}
        {isAdmin && (
          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={() => setManualUploadOpen((v) => !v)}
              className="flex items-center gap-1.5 self-start font-mono text-3xs uppercase tracking-widest text-text-secondary transition-colors hover:text-text-secondary"
            >
              <CaretDownIcon size={12} className={cn("transition-transform", manualUploadOpen && "rotate-180")} />
              Upload manually (internal)
            </button>

            {manualUploadOpen && (
              <Panel>
                <PanelBody className="flex flex-col gap-4">
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    {...({ webkitdirectory: "", directory: "" } as React.InputHTMLAttributes<HTMLInputElement>)}
                    onChange={(e) => {
                      if (e.target.files != null && e.target.files.length > 0) {
                        void handleFolderUpload(e.target.files);
                      }
                    }}
                  />

                  {uploadState === "idle" && (
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={setupId == null}
                      className="flex cursor-pointer flex-col items-center gap-3 border border-dashed border-border-mid p-8 transition-colors hover:border-primary-ink hover:bg-primary-ink/5 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <FolderOpenIcon size={32} weight="duotone" className="text-text-secondary" />
                      <div className="text-center">
                        <p className="text-sm font-medium text-text-primary">
                          Select a <code className="font-mono text-primary-ink">~/.autonoma/your-app/</code> folder
                        </p>
                        <p className="mt-1 font-mono text-3xs text-text-secondary">
                          Internal shortcut - uploads recipe + artifacts for this application.
                        </p>
                      </div>
                    </button>
                  )}

                  {uploadState === "uploading" && (
                    <div className="flex items-center gap-3 border border-border-dim p-6">
                      <SpinnerGapIcon size={20} className="animate-spin text-text-secondary" />
                      <p className="text-sm text-text-secondary">Uploading artifacts...</p>
                    </div>
                  )}

                  {uploadState === "done" && (
                    <div className="flex flex-col gap-3">
                      <div className="flex items-center gap-3 border border-status-success/20 bg-status-success/5 p-4">
                        <CheckCircleIcon size={20} weight="fill" className="text-status-success" />
                        <p className="text-sm font-medium text-text-primary">
                          {uploadedFiles.length} file{uploadedFiles.length !== 1 ? "s" : ""} uploaded
                        </p>
                      </div>
                      <Button size="xs" className="self-end" onClick={handleContinue}>
                        Continue
                      </Button>
                    </div>
                  )}

                  {uploadState === "error" && (
                    <div className="flex flex-col gap-3">
                      <div className="flex items-center gap-3 border border-status-critical/20 bg-status-critical/5 p-4">
                        <WarningCircleIcon size={20} weight="fill" className="text-status-critical" />
                        <div>
                          <p className="text-sm font-medium text-text-primary">Upload failed</p>
                          {uploadError != null && (
                            <p className="font-mono text-3xs text-text-secondary">{uploadError}</p>
                          )}
                        </div>
                      </div>
                      <Button variant="outline" size="xs" onClick={() => setUploadState("idle")}>
                        Try again
                      </Button>
                    </div>
                  )}
                </PanelBody>
              </Panel>
            )}
          </div>
        )}
      </div>
    </>
  );
}

interface ParsedFile {
  name: string;
  path: string;
  folder?: string;
  content: string;
}

async function readAllFiles(fileList: FileList): Promise<ParsedFile[]> {
  const results: ParsedFile[] = [];

  for (const file of Array.from(fileList)) {
    const relativePath = file.webkitRelativePath;
    const parts = relativePath.split("/");
    // Skip the top-level folder name (the selected directory itself)
    const pathWithinDir = parts.slice(1).join("/");
    if (pathWithinDir === "") continue;

    const content = await file.text();
    const fileName = parts[parts.length - 1] ?? file.name;
    const folderParts = parts.slice(1, -1);

    results.push({
      name: fileName,
      path: pathWithinDir,
      folder: folderParts.length > 0 ? folderParts.join("/") : undefined,
      content,
    });
  }

  return results;
}

async function postToSetup(path: string, token: string, body: unknown): Promise<void> {
  const res = await fetch(`/v1/setup${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upload failed (${res.status}): ${text}`);
  }
}
