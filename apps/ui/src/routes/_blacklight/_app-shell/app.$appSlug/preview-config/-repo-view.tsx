import { Badge, Button, Input, Label } from "@autonoma/blacklight";
import { GitBranchIcon } from "@phosphor-icons/react/GitBranch";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { useState } from "react";
import { BranchMatchingField } from "../../../onboarding/-components/previewkit/branch-matching-field";
import type { RepoDraft } from "../../../onboarding/-components/previewkit/topology-draft";
import { usePreviewDraft } from "./-draft-context";

/**
 * One dependency repo's pane: its alias and fallback branch, plus the (shared)
 * branch-matching rule that decides which branch of every dependency repo a PR
 * preview builds. The primary repo has no pane - it always builds the PR's own
 * branch - so this only ever shows dependency repos.
 */
export function RepoView({ repo }: { repo: RepoDraft }) {
  const { draft, appCountByRepoKey, setRepos, setBranchConvention } = usePreviewDraft();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const appCount = appCountByRepoKey.get(repo.name) ?? 0;

  // setRepos remaps each app's repoKey when a dependency repo's alias changes and
  // drops a removed repo's apps, so both edits go through the whole-list setter.
  function updateRepo(patch: Partial<RepoDraft>) {
    setRepos(draft.repos.map((candidate) => (candidate.id === repo.id ? { ...candidate, ...patch } : candidate)));
  }

  function removeRepo() {
    setRepos(draft.repos.filter((candidate) => candidate.id !== repo.id));
  }

  return (
    <div>
      <header className="flex flex-wrap items-center gap-3 border-b border-border-dim px-4 py-3 lg:px-6">
        <GitBranchIcon size={16} className="text-primary-ink" />
        <span className="truncate font-mono text-sm text-text-primary" title={repo.repo}>
          {repo.repo}
        </span>
        <Badge variant="outline">
          {appCount} {appCount === 1 ? "app" : "apps"}
        </Badge>
        {confirmRemove ? (
          <span className="ml-auto flex items-center gap-2">
            <span className="text-2xs text-status-critical">
              {appCount > 0 ? `Removes ${appCount} mapped ${appCount === 1 ? "app" : "apps"}.` : "Remove repo?"}
            </span>
            <Button variant="destructive" size="xs" onClick={removeRepo}>
              confirm
            </Button>
            <Button variant="ghost" size="xs" onClick={() => setConfirmRemove(false)}>
              cancel
            </Button>
          </span>
        ) : (
          <Button
            variant="ghost"
            size="icon-xs"
            title="Remove repo"
            className="ml-auto hover:text-status-critical"
            onClick={() => setConfirmRemove(true)}
          >
            <TrashIcon size={14} />
          </Button>
        )}
      </header>

      <div className="flex max-w-2xl flex-col gap-6 p-4 lg:p-6">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="pk-repo-alias">Alias</Label>
            <Input
              id="pk-repo-alias"
              value={repo.name}
              onChange={(event) => updateRepo({ name: event.target.value })}
              placeholder="api"
              className="font-mono"
            />
            <p className="mt-1 text-2xs text-text-secondary">
              Short name for this repo in resource names. Must be unique.
            </p>
          </div>
          <div>
            <Label htmlFor="pk-repo-fallback">Fallback branch</Label>
            <Input
              id="pk-repo-fallback"
              value={repo.fallbackBranch}
              onChange={(event) => updateRepo({ fallbackBranch: event.target.value })}
              placeholder="main"
              className="font-mono"
            />
            <p className="mt-1 text-2xs text-text-secondary">Built when branch matching finds no matching branch.</p>
          </div>
        </div>

        <BranchMatchingField convention={draft.branchConvention} onChange={setBranchConvention} />
      </div>
    </div>
  );
}
