import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Dialog,
  DialogBackdrop,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Skeleton,
  Textarea,
} from "@autonoma/blacklight";
import { GithubLogoIcon } from "@phosphor-icons/react/GithubLogo";
import { GlobeIcon } from "@phosphor-icons/react/Globe";
import { LinkBreakIcon } from "@phosphor-icons/react/LinkBreak";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { createFileRoute } from "@tanstack/react-router";
import { DeleteApplicationDialog } from "components/delete-application-dialog";
import { useUpdateApplicationData, useUpdateApplicationSettings } from "lib/query/applications.queries";
import {
  useApplicationRepositoryFromGitHub,
  useGithubRepositories,
  useLinkRepository,
  useUnlinkRepository,
} from "lib/query/github.queries";
import { Suspense, useEffect, useState } from "react";
import { useCurrentApplication } from "../../-use-current-application";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/settings/")({
  component: SettingsPage,
});

const MAX_INSTRUCTIONS_LENGTH = 2000;

const EXAMPLE_INSTRUCTIONS = [
  "Always use the email test-user@example.com when logging in.",
  "Dismiss cookie banners before interacting with the page.",
  "Wait for the loading spinner to disappear before asserting content.",
  "The app uses dark mode by default - do not toggle theme settings.",
];

const EXAMPLE_TEST_SCOPE_GUIDELINES = [
  "Do not generate tests for the /admin section.",
  "The checkout flow is business-critical - prioritize coverage there.",
  "Skip tests that depend on third-party email delivery.",
  "Avoid tests that hit billing or live payment integrations.",
];

function SettingsPage() {
  const currentApp = useCurrentApplication();
  const [savedInstructions, setSavedInstructions] = useState(currentApp.customInstructions ?? "");
  const [customInstructions, setCustomInstructions] = useState(currentApp.customInstructions ?? "");
  const [savedGuidelines, setSavedGuidelines] = useState(currentApp.testScopeGuidelines ?? "");
  const [testScopeGuidelines, setTestScopeGuidelines] = useState(currentApp.testScopeGuidelines ?? "");
  const updateSettings = useUpdateApplicationSettings();

  useEffect(() => {
    const instructions = currentApp.customInstructions ?? "";
    setSavedInstructions(instructions);
    setCustomInstructions(instructions);
  }, [currentApp.customInstructions]);

  useEffect(() => {
    const guidelines = currentApp.testScopeGuidelines ?? "";
    setSavedGuidelines(guidelines);
    setTestScopeGuidelines(guidelines);
  }, [currentApp.testScopeGuidelines]);

  const hasInstructionsChanges = customInstructions !== savedInstructions;
  const hasGuidelinesChanges = testScopeGuidelines !== savedGuidelines;

  function toNullable(value: string): string | null {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }

  function handleSaveInstructions() {
    const normalized = customInstructions.trim();
    updateSettings.mutate(
      {
        id: currentApp.id,
        customInstructions: toNullable(customInstructions),
        testScopeGuidelines: toNullable(savedGuidelines),
      },
      {
        onSuccess: () => {
          setSavedInstructions(normalized);
          setCustomInstructions(normalized);
        },
      },
    );
  }

  function handleSaveGuidelines() {
    const normalized = testScopeGuidelines.trim();
    updateSettings.mutate(
      {
        id: currentApp.id,
        customInstructions: toNullable(savedInstructions),
        testScopeGuidelines: toNullable(testScopeGuidelines),
      },
      {
        onSuccess: () => {
          setSavedGuidelines(normalized);
          setTestScopeGuidelines(normalized);
        },
      },
    );
  }

  function handleResetInstructions() {
    setCustomInstructions(savedInstructions);
  }

  function handleResetGuidelines() {
    setTestScopeGuidelines(savedGuidelines);
  }

  return (
    <div className="space-y-4">
      <WebDeploymentPanel />
      <LinkedRepositoryPanel />

      <Panel>
        <PanelHeader>
          <PanelTitle>Custom agent instructions</PanelTitle>
        </PanelHeader>
        <PanelBody className="space-y-4">
          <p className="text-xs text-text-secondary">
            These instructions are included with every test run for this application. Use them to provide context about
            your app, set default behaviors, or specify login credentials.
          </p>

          <div className="space-y-2">
            <Label
              htmlFor="custom-instructions"
              className="font-mono text-2xs uppercase tracking-widest text-text-secondary"
            >
              Instructions
            </Label>
            <Textarea
              id="custom-instructions"
              placeholder="Enter custom instructions for the test agent..."
              value={customInstructions}
              onChange={(e) => setCustomInstructions(e.target.value)}
              maxLength={MAX_INSTRUCTIONS_LENGTH}
              rows={8}
              className="resize-y font-mono text-xs"
            />
            <p className="text-right font-mono text-3xs text-text-secondary">
              {customInstructions.length} / {MAX_INSTRUCTIONS_LENGTH}
            </p>
          </div>

          <div className="rounded-md border border-border-dim bg-surface-base p-4">
            <p className="mb-3 font-mono text-2xs uppercase tracking-widest text-text-secondary">Examples</p>
            <ul className="space-y-2">
              {EXAMPLE_INSTRUCTIONS.map((example) => (
                <li key={example} className="flex items-start gap-2 text-xs text-text-secondary">
                  <span className="mt-1.5 block size-1 shrink-0 rounded-full bg-text-tertiary" />
                  <span>{example}</span>
                </li>
              ))}
            </ul>
          </div>

          <Separator />

          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              onClick={handleResetInstructions}
              disabled={!hasInstructionsChanges}
              aria-label="app-settings-instructions-reset"
            >
              Reset
            </Button>
            <Button
              onClick={handleSaveInstructions}
              disabled={!hasInstructionsChanges || updateSettings.isPending}
              aria-label="app-settings-instructions-save"
            >
              {updateSettings.isPending ? "Saving..." : "Save changes"}
            </Button>
          </div>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader>
          <PanelTitle>Test scope guidelines</PanelTitle>
        </PanelHeader>
        <PanelBody className="space-y-4">
          <p className="text-xs text-text-secondary">
            These guidelines are read by the agents that plan, generate, and modify your test suite. Use them to say
            what should not be tested, or what deserves extra coverage.
          </p>

          <div className="space-y-2">
            <Label
              htmlFor="test-scope-guidelines"
              className="font-mono text-2xs uppercase tracking-widest text-text-secondary"
            >
              Guidelines
            </Label>
            <Textarea
              id="test-scope-guidelines"
              placeholder="Enter guidelines for the plan-authoring agents..."
              value={testScopeGuidelines}
              onChange={(e) => setTestScopeGuidelines(e.target.value)}
              maxLength={MAX_INSTRUCTIONS_LENGTH}
              rows={8}
              className="resize-y font-mono text-xs"
            />
            <p className="text-right font-mono text-3xs text-text-secondary">
              {testScopeGuidelines.length} / {MAX_INSTRUCTIONS_LENGTH}
            </p>
          </div>

          <div className="rounded-md border border-border-dim bg-surface-base p-4">
            <p className="mb-3 font-mono text-2xs uppercase tracking-widest text-text-secondary">Examples</p>
            <ul className="space-y-2">
              {EXAMPLE_TEST_SCOPE_GUIDELINES.map((example) => (
                <li key={example} className="flex items-start gap-2 text-xs text-text-secondary">
                  <span className="mt-1.5 block size-1 shrink-0 rounded-full bg-text-tertiary" />
                  <span>{example}</span>
                </li>
              ))}
            </ul>
          </div>

          <Separator />

          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              onClick={handleResetGuidelines}
              disabled={!hasGuidelinesChanges}
              aria-label="app-settings-guidelines-reset"
            >
              Reset
            </Button>
            <Button
              onClick={handleSaveGuidelines}
              disabled={!hasGuidelinesChanges || updateSettings.isPending}
              aria-label="app-settings-guidelines-save"
            >
              {updateSettings.isPending ? "Saving..." : "Save changes"}
            </Button>
          </div>
        </PanelBody>
      </Panel>

      <Alert>
        <AlertTitle>How these are applied</AlertTitle>
        <AlertDescription>
          Agent instructions are appended to every test run prompt and apply at execution time. Testing guidelines are
          read by the agents that author and modify your test suite (diff analysis, healing, resolution).
        </AlertDescription>
      </Alert>

      <DangerZonePanel />
    </div>
  );
}

function ConfigureWebDeploymentDialog({
  open,
  onOpenChange,
  applicationId,
  initialUrl,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applicationId: string;
  initialUrl: string;
}) {
  const [url, setUrl] = useState(initialUrl);
  const updateData = useUpdateApplicationData();

  useEffect(() => {
    if (open) setUrl(initialUrl);
  }, [open, initialUrl]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    updateData.mutate(
      { id: applicationId, architecture: "WEB", url: url.trim() },
      {
        onSuccess: () => {
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogBackdrop />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configure deployment URL</DialogTitle>
          <DialogDescription>Enter the frontend URL that tests for this application run against.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <DialogBody className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="web-deployment-url">URL</Label>
              <Input
                id="web-deployment-url"
                type="url"
                placeholder="https://your-app.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" disabled={updateData.isPending || url.trim() === ""}>
              {updateData.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function WebDeploymentPanel() {
  const currentApp = useCurrentApplication();
  const savedUrl = currentApp.mainBranch.deployment?.webDeployment?.url ?? "";
  const [configureOpen, setConfigureOpen] = useState(false);

  if (currentApp.architecture !== "WEB") return null;

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Web deployment URL</PanelTitle>
      </PanelHeader>
      <PanelBody className="space-y-4">
        <p className="text-xs text-text-secondary">
          The frontend URL that tests for this application run against. Update it to point the test suite at a different
          deployment (for example, a staging or preview environment).
        </p>

        <div className="flex items-center gap-3 rounded-lg border border-border-dim bg-surface-base px-4 py-3">
          <GlobeIcon size={16} className="shrink-0 text-text-secondary" />
          <span className="min-w-0 flex-1 truncate font-mono text-sm text-text-secondary">
            {savedUrl === "" ? "No URL configured" : savedUrl}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfigureOpen(true)}
            aria-label="app-settings-web-deployment-url-configure"
          >
            <PencilSimpleIcon size={14} />
            Configure
          </Button>
        </div>
      </PanelBody>

      <ConfigureWebDeploymentDialog
        open={configureOpen}
        onOpenChange={setConfigureOpen}
        applicationId={currentApp.id}
        initialUrl={savedUrl}
      />
    </Panel>
  );
}

/**
 * Which repository this application watches. App-scoped, so it belongs here rather than with the GitHub App
 * installation, which is organization-wide - disconnecting that unlinks every repository from every app.
 */
function LinkedRepositoryPanel() {
  const currentApp = useCurrentApplication();
  const { data: repository, isPending } = useApplicationRepositoryFromGitHub(currentApp.id);
  const unlinkRepository = useUnlinkRepository();
  const [changeOpen, setChangeOpen] = useState(false);

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Linked repository</PanelTitle>
      </PanelHeader>
      <PanelBody className="space-y-4">
        <p className="text-xs text-text-secondary">
          The repository Autonoma watches for this application. Pull requests opened here are the ones it reviews.
        </p>

        <div className="flex items-center gap-3 rounded-lg border border-border-dim bg-surface-base px-4 py-3">
          <GithubLogoIcon size={16} className="shrink-0 text-text-secondary" />
          {isPending ? (
            <Skeleton className="h-4 min-w-0 flex-1" />
          ) : (
            <span className="min-w-0 flex-1 truncate font-mono text-sm text-text-secondary">
              {repository == null ? "No repository linked" : repository.fullName}
              {repository != null && (
                <span className="ml-2 text-2xs text-text-secondary">default branch: {repository.defaultBranch}</span>
              )}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setChangeOpen(true)}
            aria-label="app-settings-repository-change"
          >
            <PencilSimpleIcon size={14} />
            {repository == null ? "Link" : "Change"}
          </Button>
          {repository != null && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-text-secondary"
              onClick={() => unlinkRepository.mutate({ applicationId: currentApp.id })}
              disabled={unlinkRepository.isPending}
              aria-label="app-settings-repository-unlink"
            >
              <LinkBreakIcon size={14} />
              {unlinkRepository.isPending ? "Unlinking..." : "Unlink"}
            </Button>
          )}
        </div>
      </PanelBody>

      {/* Mounted only while open: the picker reads the org's whole repository list through a suspense query,
          so mounting it unconditionally would suspend the General page on every load. */}
      {changeOpen && <ChangeRepositoryDialog open onOpenChange={setChangeOpen} applicationId={currentApp.id} />}
    </Panel>
  );
}

function ChangeRepositoryDialog({
  open,
  onOpenChange,
  applicationId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applicationId: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogBackdrop />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link a repository</DialogTitle>
          <DialogDescription>Pull requests opened on this repository are the ones Autonoma reviews.</DialogDescription>
        </DialogHeader>
        <Suspense fallback={<RepositoryPickerSkeleton />}>
          <RepositoryPicker applicationId={applicationId} onDone={() => onOpenChange(false)} />
        </Suspense>
      </DialogContent>
    </Dialog>
  );
}

function RepositoryPicker({ applicationId, onDone }: { applicationId: string; onDone: () => void }) {
  const { data: repos } = useGithubRepositories();
  const linkRepository = useLinkRepository();
  const [selectedRepoId, setSelectedRepoId] = useState<number>();

  function handleSave() {
    if (selectedRepoId == null) return;
    linkRepository.mutate({ applicationId, githubRepoId: selectedRepoId }, { onSuccess: onDone });
  }

  return (
    <>
      <DialogBody className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="linked-repository">Repository</Label>
          <Select
            value={selectedRepoId != null ? String(selectedRepoId) : ""}
            onValueChange={(value) => {
              const parsed = Number(value);
              if (!Number.isNaN(parsed)) setSelectedRepoId(parsed);
            }}
          >
            <SelectTrigger id="linked-repository" className="w-full">
              <SelectValue placeholder="Select a repository">
                {repos.find((repo) => repo.id === selectedRepoId)?.fullName}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {repos.map((repo) => {
                const isLinkedToOtherApp = repo.applicationId != null && repo.applicationId !== applicationId;
                return (
                  <SelectItem key={repo.id} value={String(repo.id)} disabled={isLinkedToOtherApp}>
                    {isLinkedToOtherApp
                      ? `${repo.fullName} (linked to ${repo.applicationName ?? "another app"})`
                      : repo.fullName}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>
      </DialogBody>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <Button onClick={handleSave} disabled={selectedRepoId == null || linkRepository.isPending}>
          {linkRepository.isPending ? "Saving..." : "Link repository"}
        </Button>
      </DialogFooter>
    </>
  );
}

function RepositoryPickerSkeleton() {
  return (
    <DialogBody className="flex flex-col gap-2">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-9 w-full" />
    </DialogBody>
  );
}

function DangerZonePanel() {
  const currentApp = useCurrentApplication();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  return (
    <>
      <Panel>
        <PanelHeader>
          <PanelTitle>Danger zone</PanelTitle>
        </PanelHeader>
        <PanelBody>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-medium text-text-primary">Delete application</p>
              <p className="text-xs text-text-secondary">
                Permanently remove this application and all its data. This action cannot be undone.
              </p>
            </div>
            <Button variant="destructive" onClick={() => setDeleteDialogOpen(true)}>
              Delete
            </Button>
          </div>
        </PanelBody>
      </Panel>
      <DeleteApplicationDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        applicationId={currentApp.id}
        applicationName={currentApp.name}
      />
    </>
  );
}
