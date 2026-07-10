import {
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
  cn,
} from "@autonoma/blacklight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { GitBranchIcon } from "@phosphor-icons/react/GitBranch";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useGithubConfig, useGithubRepositories } from "lib/query/github.queries";
import { trpc } from "lib/trpc";
import { type FormEvent, useState } from "react";
import { nextDraftId, repoAliasFrom, type RepoDraft } from "./topology-draft";

// Cap the install-tab close poll so it can never leak indefinitely (~5 min).
const INSTALL_POLL_INTERVAL_MS = 800;
const INSTALL_POLL_MAX_TICKS = 375;
const MULTIREPO_DOCS_URL = "https://docs.autonoma.app/previewkit/multirepo/";

interface AddAppDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Full name (`owner/repo`) of the primary repo, excluded from the picker. */
  primaryRepoFullName?: string;
  /** Dependency repos already in the config (each has at least one app). */
  repos: RepoDraft[];
  /** Adds an app to a repo that is already part of the config (its alias). */
  onAddToExistingRepo: (alias: string) => void;
  /** Registers a new dependency repo and seeds its first app. */
  onAddToNewRepo: (repo: RepoDraft) => void;
}

/**
 * Asks which repo a new app comes from, in place, when adding an app from a repo
 * other than the primary one. Existing dependency repos can be reused; picking a
 * newly-connected repo captures its alias and fallback branch here so the repo's
 * settings live next to the app instead of in a separate top-of-page band.
 */
export function AddAppDialog({
  open,
  onOpenChange,
  primaryRepoFullName,
  repos,
  onAddToExistingRepo,
  onAddToNewRepo,
}: AddAppDialogProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: installationRepos } = useGithubRepositories();
  // Where GitHub returns to after granting the app access to more repos.
  const { data: githubConfig } = useGithubConfig(router.state.location.href);
  // `dep:<alias>` for an existing dependency repo, `new:<fullName>` for a repo to add.
  const [selection, setSelection] = useState<string | undefined>(undefined);
  const [alias, setAlias] = useState("");
  const [fallbackBranch, setFallbackBranch] = useState("");

  const usedFullNames = new Set([primaryRepoFullName, ...repos.map((repo) => repo.repo)]);
  const availableRepos = installationRepos.filter((repo) => !usedFullNames.has(repo.fullName));
  const installUrl = githubConfig.installUrl;
  const existingAliases = repos.map((repo) => repo.name);

  const selectedNewRepo =
    selection?.startsWith("new:") === true
      ? availableRepos.find((repo) => `new:${repo.fullName}` === selection)
      : undefined;

  function reset() {
    setSelection(undefined);
    setAlias("");
    setFallbackBranch("");
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function selectNewRepo(fullName: string, name: string, defaultBranch: string) {
    setSelection(`new:${fullName}`);
    setAlias(repoAliasFrom(name, existingAliases));
    setFallbackBranch(defaultBranch);
  }

  // Open the GitHub App install in a separate tab so the in-progress config draft
  // in this tab is never destroyed by a full-page redirect. The repo list refetches
  // on window focus (see useGithubRepositories); polling the tab's close is a
  // backstop that refreshes even if the user never refocuses before the picker.
  function openGithubInstall() {
    if (installUrl == null) return;
    const installTab = window.open(installUrl, "_blank");
    if (installTab == null) return;
    let ticks = 0;
    const timer = window.setInterval(() => {
      ticks += 1;
      if (!installTab.closed && ticks < INSTALL_POLL_MAX_TICKS) return;
      window.clearInterval(timer);
      void queryClient.invalidateQueries({ queryKey: trpc.github.listRepositories.queryKey() });
    }, INSTALL_POLL_INTERVAL_MS);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (selection == null) return;
    if (selectedNewRepo != null) {
      const trimmedAlias = alias.trim();
      const draft: RepoDraft = {
        id: nextDraftId(),
        name: trimmedAlias === "" ? repoAliasFrom(selectedNewRepo.name, existingAliases) : trimmedAlias,
        repo: selectedNewRepo.fullName,
        fallbackBranch: fallbackBranch.trim() === "" ? selectedNewRepo.defaultBranch : fallbackBranch.trim(),
        githubRepositoryId: selectedNewRepo.id,
      };
      onAddToNewRepo(draft);
    } else if (selection.startsWith("dep:")) {
      onAddToExistingRepo(selection.slice("dep:".length));
    }
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogBackdrop />
      <DialogContent className="max-w-lg">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Add an app from another repo</DialogTitle>
            <DialogDescription>
              Pick the repository this app is built from. Its apps deploy into the same preview environment as your
              primary repo.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 px-6 pb-2">
            {repos.length === 0 && availableRepos.length === 0 ? (
              <p className="text-sm text-text-secondary">
                No other repos are connected to the PreviewKit GitHub App yet. Grant it access to the repo you need -
                this tab keeps your progress.
              </p>
            ) : (
              <div className="space-y-2">
                {repos.map((repo) => (
                  <RepoOption
                    key={`dep:${repo.name}`}
                    selected={selection === `dep:${repo.name}`}
                    title={repo.repo}
                    subtitle={`Already added · alias ${repo.name}`}
                    onSelect={() => setSelection(`dep:${repo.name}`)}
                  />
                ))}
                {availableRepos.map((repo) => (
                  <RepoOption
                    key={`new:${repo.fullName}`}
                    selected={selection === `new:${repo.fullName}`}
                    title={repo.fullName}
                    subtitle="Connect to this preview"
                    onSelect={() => selectNewRepo(repo.fullName, repo.name, repo.defaultBranch)}
                  />
                ))}
              </div>
            )}

            {selectedNewRepo != null ? (
              <div className="space-y-3 border border-border-dim bg-surface-raised p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="pk-add-app-alias">Alias</Label>
                    <Input
                      id="pk-add-app-alias"
                      value={alias}
                      onChange={(event) => setAlias(event.target.value)}
                      placeholder="api"
                      className="font-mono"
                    />
                    <p className="mt-1 text-2xs text-text-secondary">
                      Short name for this repo in resource names. Must be unique.
                    </p>
                  </div>
                  <div>
                    <Label htmlFor="pk-add-app-fallback">Fallback branch</Label>
                    <Input
                      id="pk-add-app-fallback"
                      value={fallbackBranch}
                      onChange={(event) => setFallbackBranch(event.target.value)}
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
              </div>
            ) : undefined}

            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-fit gap-2 text-text-secondary"
              onClick={openGithubInstall}
              disabled={installUrl == null}
            >
              <GitBranchIcon size={14} />
              Connect another repo on GitHub
              <ArrowSquareOutIcon size={13} />
            </Button>
          </div>

          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
            <Button type="submit" disabled={selection == null}>
              Add app
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RepoOption({
  selected,
  title,
  subtitle,
  onSelect,
}: {
  selected: boolean;
  title: string;
  subtitle: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-3 border px-4 py-3 text-left transition-colors",
        selected ? "border-primary-ink bg-accent-dim" : "border-border-dim hover:border-primary-ink/50",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-sm text-text-primary" title={title}>
          {title}
        </p>
        <p className="text-2xs text-text-secondary">{subtitle}</p>
      </div>
      {selected ? <CheckCircleIcon size={18} weight="fill" className="shrink-0 text-primary-ink" /> : undefined}
    </button>
  );
}
