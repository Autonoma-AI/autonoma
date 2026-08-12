import { Badge, Button, Label, Tooltip, TooltipContent, TooltipTrigger, badgeVariants, cn } from "@autonoma/blacklight";
import { type UploadArtifactsBody, UploadScenarioRecipeVersionsBodySchema } from "@autonoma/types";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { FolderOpenIcon } from "@phosphor-icons/react/FolderOpen";
import { SpinnerGapIcon } from "@phosphor-icons/react/SpinnerGap";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { getApiOrigin } from "lib/api-origin";
import { useAuth } from "lib/auth";
import { buildPlannerCommand, type CommandShell } from "lib/onboarding/planner-command";
import { useCommandShell } from "lib/onboarding/use-command-shell";
import {
  usePrepareCliSetup,
  useUpdateSetup,
  useUploadScenarioRecipeVersions,
  useUploadSetupArtifacts,
} from "lib/query/app-generations.queries";
import { useApplicationSharedSecret } from "lib/query/applications.queries";
import { useEffect, useRef, useState } from "react";
import { CommandBlock } from "./command-block";
import { DocLink } from "./prose";
import { testCaseFolder } from "./test-case-folder";

const ARTIFACT_DETAILS: Record<string, { label: string; description: string }> = {
  recipe: {
    label: "recipe.json",
    description: "Environment-factory recipes - how to seed and tear down test data for each scenario.",
  },
  tests: { label: "qa-tests/", description: "The generated end-to-end test cases, as markdown." },
  kb: { label: "AUTONOMA.md", description: "A knowledge base of your app's pages and flows." },
  scenarios: { label: "scenarios.md", description: "Named test-data scenarios derived from the knowledge base." },
};

const PLANNER_DOCS_URL = "https://docs.autonoma.app/test-planner/";

export interface ArtifactStatus {
  complete: boolean;
  stepComplete: boolean;
  artifacts: Array<{ key: string; received: boolean }>;
}

export interface ArtifactsStepBodyProps {
  applicationId: string;
  artifacts: ArtifactStatus;
  /** The setup id pinned in the URL, so a refresh reuses the same CLI setup. */
  pinnedSetupId?: string;
  onSetupIdResolved: (setupId: string) => void;
}

export function ArtifactsStepBody({
  applicationId,
  artifacts,
  pinnedSetupId,
  onSetupIdResolved,
}: ArtifactsStepBodyProps) {
  const { user, isAdmin } = useAuth();
  const { data: sharedSecretData } = useApplicationSharedSecret(applicationId);
  const setup = useCliSetup(applicationId, pinnedSetupId, onSetupIdResolved);
  // One shell for both blocks on this screen: whoever is on Windows is on Windows for
  // the re-upload command too.
  const [shell, setShell] = useCommandShell();

  const sharedSecret = sharedSecretData?.sharedSecret;
  // AUTONOMA_API_TOKEN authenticates the CLI against our managed LLM proxy, so it
  // is now required for the planner to run (not just to upload artifacts). Only
  // surface a runnable command once that token has been provisioned.
  // Built from the shared source the connect screen also uses: the two screens hand
  // out the same command, and a variable present on one and missing from the other is
  // a run that silently does less.
  const commandEnv =
    setup.status === "ready"
      ? {
          apiUrl: getApiOrigin(),
          apiToken: setup.apiKey,
          generationId: setup.setupId,
          applicationId,
          sharedSecret,
          distinctId: user?.id,
        }
      : undefined;

  // Passed as builders rather than strings: the shell is chosen by the same click that
  // copies, so the block has to be able to render a form it is not currently showing.
  const buildRunCommand = (forShell: CommandShell) =>
    commandEnv != null ? buildPlannerCommand(commandEnv, { shell: forShell }) : undefined;
  // `upload` has to reach the planner invocation itself. On the Windows shells the
  // variables are separate lines, so appending it to the whole command would hand it
  // to `set` instead.
  const buildUploadCommand = (forShell: CommandShell) =>
    commandEnv != null ? buildPlannerCommand(commandEnv, { shell: forShell, subcommand: "upload" }) : undefined;

  // One derived list feeds the chips, the count and the heading, so none of them can
  // disagree and no artifact total is hardcoded.
  const artifactRows = Object.entries(ARTIFACT_DETAILS).map(([key, detail]) => ({
    key,
    label: detail.label,
    description: detail.description,
    received: artifacts.artifacts.find((a) => a.key === key)?.received === true,
  }));
  const receivedCount = artifactRows.filter((row) => row.received).length;
  const allArtifactsReceived = receivedCount === artifactRows.length;
  const missingArtifacts = artifactRows.filter((row) => !row.received).map((row) => row.label);
  // The CLI run finished but not everything landed (typically the recipe) - surface
  // it and how to recover, rather than leaving the step silently un-completeable.
  const showIncompleteUploadHint = artifacts.complete && !artifacts.stepComplete;

  // Only npx is offered, deliberately. Running the planner in a throwaway `node:22`
  // container cannot work as things stand: there is no editor in the image, and it
  // has no route back to the host to make requests. A container tab becomes possible
  // once the CLI supports running inside one.
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label>Run in your terminal</Label>
        <CommandBlock buildCommand={buildRunCommand} shell={shell} onShellChange={setShell} />
      </div>

      {setup.status === "loading" && (
        <p className="font-mono text-3xs text-text-secondary">
          Preparing your access token so the CLI can run on your Autonoma credits...
        </p>
      )}
      {setup.status === "error" && (
        <p className="font-mono text-3xs text-status-critical">
          Couldn't prepare your access token - the planner needs it to run. Refresh to try again.
        </p>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Label>{allArtifactsReceived ? "Uploaded" : "Waiting for uploads"}</Label>
          <Badge variant="outline" className="text-3xs">
            {receivedCount}/{artifactRows.length}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {artifactRows.map((row) => (
            <ArtifactChip key={row.key} label={row.label} description={row.description} received={row.received} />
          ))}
        </div>
        <p className="mt-1 text-2xs text-text-secondary">
          <DocLink href={PLANNER_DOCS_URL}>Learn more about the planner and what it generates</DocLink>
        </p>
      </div>

      {showIncompleteUploadHint && (
        <div className="flex flex-col gap-2 border border-status-warn/30 bg-status-warn/5 px-4 py-3">
          <div className="flex items-start gap-2">
            <WarningCircleIcon size={16} weight="fill" className="mt-0.5 shrink-0 text-status-warn" />
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-text-primary">
                The CLI finished, but some artifacts didn't upload
              </p>
              <p className="text-2xs text-text-secondary">
                Missing: {missingArtifacts.join(", ")}. The recipe usually fails when the planner can't validate an
                environment-factory (e.g. a model with no registered factory) or the upload was rejected - and without
                it dry-run has no scenarios to provision. Re-run the planner, or re-upload the already-generated
                artifacts (idempotent - safe to run again):
              </p>
            </div>
          </div>
          <CommandBlock buildCommand={buildUploadCommand} shell={shell} onShellChange={setShell} />
        </div>
      )}

      {isAdmin && (
        <AdminManualUpload
          applicationId={applicationId}
          setupId={setup.status === "ready" ? setup.setupId : undefined}
        />
      )}
    </div>
  );
}

/**
 * One artifact the planner is expected to upload, as a chip that fills in once it
 * lands. What each file is lives in the tooltip rather than a line of its own -
 * four descriptions stacked under four filenames buried the actual instruction.
 *
 * The trigger is a button purely so the description is reachable without a mouse -
 * it has no click behaviour. A plain span would not take focus, and the tooltip
 * would never open for keyboard users.
 */
function ArtifactChip({ label, description, received }: { label: string; description: string; received: boolean }) {
  const toneClass = received ? "border-status-success/40 text-status-success" : "text-text-secondary";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              badgeVariants({ variant: "outline" }),
              "cursor-default gap-1.5 font-mono text-2xs",
              toneClass,
            )}
          />
        }
      >
        {received ? (
          <CheckIcon size={12} weight="bold" className="text-status-success" />
        ) : (
          <span className="size-2 rounded-full border border-border-mid" />
        )}
        {label}
      </TooltipTrigger>
      {/* Opens downward into empty space; the default upward placement covers the copy CTA. */}
      <TooltipContent side="bottom" align="start" className="max-w-xs">
        {description}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Defensively default each recipe's `validation.phase` to "ok" (the planner CLI
 * sometimes omits it). Operates on the parsed-but-unvalidated JSON so the strict
 * `UploadScenarioRecipeVersionsBodySchema.parse` below can succeed.
 */
function defaultRecipePhases(file: unknown): unknown {
  if (typeof file !== "object" || file == null || !("recipes" in file) || !Array.isArray(file.recipes)) {
    return file;
  }
  for (const recipe of file.recipes) {
    if (
      typeof recipe === "object" &&
      recipe != null &&
      "validation" in recipe &&
      typeof recipe.validation === "object" &&
      recipe.validation != null &&
      !("phase" in recipe.validation)
    ) {
      Object.assign(recipe.validation, { phase: "ok" });
    }
  }
  return file;
}

/**
 * Internal-only escape hatch for @autonoma.app admins: pick a generated
 * `~/.autonoma/<app>/` folder and upload its recipe + artifacts directly,
 * instead of running the CLI. Uses the session-authed tRPC setup mutations.
 */
function AdminManualUpload({ applicationId, setupId }: { applicationId: string; setupId?: string }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [uploadState, setUploadState] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [uploadError, setUploadError] = useState<string>();
  const [uploadedFiles, setUploadedFiles] = useState<string[]>([]);

  const uploadRecipe = useUploadScenarioRecipeVersions();
  const uploadArtifacts = useUploadSetupArtifacts();
  const updateSetup = useUpdateSetup(applicationId);

  const ready = setupId != null;

  function setInputRef(el: HTMLInputElement | null) {
    fileInputRef.current = el;
    if (el != null) {
      el.setAttribute("webkitdirectory", "");
      el.setAttribute("directory", "");
    }
  }

  async function handleFolderUpload(files: FileList) {
    if (setupId == null) return;
    setUploadState("uploading");
    setUploadError(undefined);

    try {
      const fileEntries = await readAllFiles(files);
      setUploadedFiles(fileEntries.map((f) => f.name));

      const recipeFile = fileEntries.find((f) => f.name === "recipe.json");
      if (recipeFile != null) {
        const body = UploadScenarioRecipeVersionsBodySchema.parse(defaultRecipePhases(JSON.parse(recipeFile.content)));
        await uploadRecipe.mutateAsync({ setupId, body });
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

      const artifactsBody: UploadArtifactsBody = {};
      if (testCases.length > 0) {
        // Derive the folder the same way the CLI does - relative to `qa-tests/`, not the
        // raw directory path - so the API's (folder, name) dedupe key matches a CLI run's
        // and a manual re-upload doesn't duplicate every test case.
        artifactsBody.testCases = testCases.map((f) => ({
          name: f.name,
          content: f.content,
          folder: testCaseFolder(f.path),
        }));
      }
      if (skills.length > 0) {
        artifactsBody.skills = skills.map((f) => ({ name: f.name, content: f.content }));
      }
      if (artifacts.length > 0) {
        artifactsBody.artifacts = artifacts.map((f) => ({ name: f.name, content: f.content }));
      }

      if (testCases.length + skills.length + artifacts.length > 0) {
        await uploadArtifacts.mutateAsync({ setupId, body: artifactsBody });
      }

      await updateSetup.mutateAsync({ setupId, body: { status: "completed" } });

      setUploadState("done");
    } catch (err) {
      setUploadState("error");
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    }
  }

  return (
    <div className="flex flex-col gap-3 border-t border-border-dim pt-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 self-start font-mono text-3xs uppercase tracking-widest text-text-secondary transition-colors hover:text-text-primary"
      >
        <CaretDownIcon size={12} className={cn("transition-transform", open && "rotate-180")} />
        Upload manually (internal)
      </button>

      {open && (
        <div className="border border-border-dim bg-surface-base p-4">
          <input
            ref={setInputRef}
            type="file"
            className="hidden"
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
              disabled={!ready}
              className="flex w-full cursor-pointer flex-col items-center gap-3 border border-dashed border-border-mid p-8 transition-colors hover:border-primary-ink hover:bg-primary-ink/5 disabled:cursor-not-allowed disabled:opacity-50"
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
            <div className="flex items-center gap-3 border border-status-success/20 bg-status-success/5 p-4">
              <CheckCircleIcon size={20} weight="fill" className="text-status-success" />
              <p className="text-sm font-medium text-text-primary">
                {uploadedFiles.length} file{uploadedFiles.length !== 1 ? "s" : ""} uploaded
              </p>
            </div>
          )}

          {uploadState === "error" && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3 border border-status-critical/20 bg-status-critical/5 p-4">
                <WarningCircleIcon size={20} weight="fill" className="text-status-critical" />
                <div>
                  <p className="text-sm font-medium text-text-primary">Upload failed</p>
                  {uploadError != null && <p className="font-mono text-3xs text-text-secondary">{uploadError}</p>}
                </div>
              </div>
              <Button variant="outline" size="xs" onClick={() => setUploadState("idle")}>
                Try again
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ParsedFile {
  name: string;
  path: string;
  content: string;
}

async function readAllFiles(fileList: FileList): Promise<ParsedFile[]> {
  // Each file's read is independent, so run them concurrently rather than paying the
  // full latency of every read in sequence - a generated app folder is dozens of files.
  const entries = await Promise.all(
    Array.from(fileList).map(async (file): Promise<ParsedFile | undefined> => {
      const parts = file.webkitRelativePath.split("/");
      // Skip the top-level folder name (the selected directory itself).
      const pathWithinDir = parts.slice(1).join("/");
      if (pathWithinDir === "") return undefined;

      const content = await file.text();
      const fileName = parts[parts.length - 1] ?? file.name;
      return { name: fileName, path: pathWithinDir, content };
    }),
  );
  return entries.filter((entry) => entry != null);
}

/**
 * Discriminated, so `ready` is the only shape that carries credentials and carries
 * them non-optionally. As a flat interface with optional fields, `status === "ready"`
 * narrowed nothing and a command could be built holding the string "undefined".
 */
type CliSetupState = { status: "loading" } | { status: "error" } | { status: "ready"; apiKey: string; setupId: string };

/**
 * Mints an API key + setup once (on mount, via tRPC) so the CLI command can
 * always be shown with a working upload token. The command renders immediately;
 * the token fills in when this resolves. Errors surface through Sentry via the
 * shared mutation cache hook.
 */
function useCliSetup(
  applicationId: string,
  pinnedSetupId: string | undefined,
  onSetupIdResolved: (setupId: string) => void,
): CliSetupState {
  const prepare = usePrepareCliSetup();
  const { mutate, isIdle, isError, data } = prepare;

  useEffect(() => {
    // Kick off once when idle; the mutation's own lifecycle is the dedupe guard.
    // Pass the URL's setup id so the server reuses that setup instead of minting a
    // new one (stable AUTONOMA_GENERATION_ID across refreshes).
    if (isIdle) mutate({ applicationId, pinnedSetupId });
  }, [applicationId, isIdle, mutate, pinnedSetupId]);

  // Reflect the resolved setup id back into the URL so a refresh reuses it.
  const resolvedSetupId = data?.setupId;
  useEffect(() => {
    if (resolvedSetupId == null || resolvedSetupId === pinnedSetupId) return;
    onSetupIdResolved(resolvedSetupId);
  }, [resolvedSetupId, pinnedSetupId, onSetupIdResolved]);

  if (isError) return { status: "error" };
  if (data != null) return { status: "ready", apiKey: data.apiKey, setupId: data.setupId };
  return { status: "loading" };
}
