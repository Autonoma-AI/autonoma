import { Button, Input, Label, Panel, PanelBody } from "@autonoma/blacklight";
import { cn } from "@autonoma/blacklight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { ClipboardTextIcon } from "@phosphor-icons/react/ClipboardText";
import { FolderOpenIcon } from "@phosphor-icons/react/FolderOpen";
import { SpinnerGapIcon } from "@phosphor-icons/react/SpinnerGap";
import { TerminalWindowIcon } from "@phosphor-icons/react/TerminalWindow";
import { UploadSimpleIcon } from "@phosphor-icons/react/UploadSimple";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCreateMinimalApplication } from "lib/query/applications.queries";
import { trpc, trpcClient } from "lib/trpc";
import posthog from "posthog-js";
import { useEffect, useRef, useState } from "react";
import { OnboardingPageHeader } from "./-components/onboarding-page-header";

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

export function CliSetupPage({ appId }: CliSetupProps) {
  const [applicationId, setApplicationId] = useState(appId ?? "");
  const hasApp = applicationId.length > 0;

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
    return <NameStep onCreated={(id) => setApplicationId(id)} />;
  }

  return <SetupStep applicationId={applicationId} />;
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
        description="Give your application a name. You'll run the Autonoma CLI to generate test artifacts, then upload them."
      />

      <form onSubmit={handleSubmit} className="mt-10 flex max-w-md flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Label htmlFor="app-name" className="font-mono text-2xs uppercase tracking-widest text-text-tertiary">
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
  const [copied, setCopied] = useState(false);
  const [uploadState, setUploadState] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [uploadError, setUploadError] = useState<string>();
  const [uploadedFiles, setUploadedFiles] = useState<string[]>([]);
  const [apiKey, setApiKey] = useState<string>();
  const [setupId, setSetupId] = useState<string>();
  const hasCreatedSetup = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (hasCreatedSetup.current) return;
    hasCreatedSetup.current = true;

    async function bootstrap() {
      const keyResult = await trpcClient.apiKeys.create.mutate({ name: `cli-setup-${Date.now()}` });
      setApiKey(keyResult.key);

      const setupResult = await fetch("/v1/setup/setups", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${keyResult.key}`,
        },
        body: JSON.stringify({ applicationId }),
      });
      const setup = (await setupResult.json()) as { id: string };
      setSetupId(setup.id);
    }

    void bootstrap();
  }, [applicationId]);

  const command = "OPENROUTER_API_KEY=your-key-here npx @autonoma-ai/planner@latest";

  function handleCopy() {
    void navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
        (f) => f.path.startsWith("qa-tests/") && f.name.endsWith(".md") && f.name !== "INDEX.md",
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
    void navigate({ to: "/onboarding", search: { step: "scenario-dry-run", appId: applicationId } });
  }

  return (
    <>
      <OnboardingPageHeader
        title="Set up your application"
        description="Run the CLI in your project directory, then upload the generated artifacts."
      />

      <div className="mt-10 flex max-w-2xl flex-col gap-8">
        <Panel>
          <PanelBody className="flex flex-col gap-4 p-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <TerminalWindowIcon size={20} weight="duotone" className="text-primary-ink" />
                <span className="font-mono text-2xs uppercase tracking-widest text-text-tertiary">
                  1. Run in your project root
                </span>
              </div>
              <Button variant="outline" size="xs" className="gap-1.5" onClick={handleCopy}>
                {copied ? (
                  <>
                    <CheckCircleIcon size={14} className="text-status-success" />
                    Copied
                  </>
                ) : (
                  <>
                    <ClipboardTextIcon size={14} />
                    Copy
                  </>
                )}
              </Button>
            </div>

            <pre className="whitespace-pre-wrap break-all rounded-lg border border-border-dim bg-surface-void p-4 font-mono text-xs leading-relaxed text-text-primary">
              {command}
            </pre>

            <p className="font-mono text-3xs text-text-tertiary">
              The CLI requires an{" "}
              <a
                href="https://openrouter.ai"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary-ink underline underline-offset-2 transition-colors hover:text-text-primary"
              >
                OpenRouter
              </a>{" "}
              API key. Create one at{" "}
              <a
                href="https://openrouter.ai/keys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary-ink underline underline-offset-2 transition-colors hover:text-text-primary"
              >
                openrouter.ai/keys
              </a>{" "}
              and replace <code className="text-text-secondary">your-key-here</code> in the command above.
            </p>

            <p className="font-mono text-3xs text-text-tertiary">
              The CLI generates artifacts in <code className="text-text-secondary">~/.autonoma/your-app/</code>. Upload
              that folder below when it finishes.
            </p>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelBody className="flex flex-col gap-4 p-6">
            <div className="flex items-center gap-3">
              <UploadSimpleIcon size={20} weight="duotone" className="text-primary-ink" />
              <span className="font-mono text-2xs uppercase tracking-widest text-text-tertiary">
                2. Upload artifacts
              </span>
            </div>

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
              <>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={setupId == null}
                  className="flex cursor-pointer flex-col items-center gap-3 rounded-lg border border-dashed border-border-mid p-8 transition-colors hover:border-primary-ink hover:bg-primary-ink/5 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <FolderOpenIcon size={32} weight="duotone" className="text-text-tertiary" />
                  <div className="text-center">
                    <p className="text-sm font-medium text-text-primary">
                      Select your <code className="font-mono text-primary-ink">~/.autonoma/your-app/</code> folder
                    </p>
                    <p className="mt-1 font-mono text-3xs text-text-tertiary">
                      The CLI generates this folder after running successfully.
                    </p>
                  </div>
                </button>

                <div className="rounded-lg border border-border-dim bg-surface-void/50 p-4">
                  <p className="mb-2 font-mono text-3xs uppercase tracking-widest text-text-tertiary">
                    Expected folder structure
                  </p>
                  <pre className="font-mono text-3xs leading-relaxed text-text-secondary">
                    {`~/.autonoma/your-app/
├── recipe.json          # Scenario recipes (required)
├── qa-tests/            # Test case markdown files
│   ├── INDEX.md
│   └── .../*.md
├── AUTONOMA.md          # Knowledge base
└── scenarios.md         # Scenario descriptions`}
                  </pre>
                </div>
              </>
            )}

            {uploadState === "uploading" && (
              <div className="flex items-center gap-3 rounded-lg border border-border-dim p-6">
                <SpinnerGapIcon size={20} className="animate-spin text-text-tertiary" />
                <p className="text-sm text-text-secondary">Uploading artifacts...</p>
              </div>
            )}

            {uploadState === "done" && (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3 rounded-lg border border-status-success/20 bg-status-success/5 p-4">
                  <CheckCircleIcon size={20} weight="fill" className="text-status-success" />
                  <div>
                    <p className="text-sm font-medium text-text-primary">
                      {uploadedFiles.length} file{uploadedFiles.length !== 1 ? "s" : ""} uploaded
                    </p>
                  </div>
                </div>
              </div>
            )}

            {uploadState === "error" && (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3 rounded-lg border border-status-critical/20 bg-status-critical/5 p-4">
                  <WarningCircleIcon size={20} weight="fill" className="text-status-critical" />
                  <div>
                    <p className="text-sm font-medium text-text-primary">Upload failed</p>
                    {uploadError != null && <p className="font-mono text-3xs text-text-tertiary">{uploadError}</p>}
                  </div>
                </div>
                <Button variant="outline" size="xs" onClick={() => setUploadState("idle")}>
                  Try again
                </Button>
              </div>
            )}
          </PanelBody>
        </Panel>

        {uploadState === "done" && (
          <Button className="gap-2 self-end" onClick={handleContinue}>
            Continue
            <ArrowRightIcon size={16} />
          </Button>
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
