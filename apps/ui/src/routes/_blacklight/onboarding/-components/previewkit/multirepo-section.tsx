import {
  Badge,
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@autonoma/blacklight";
import { GitBranchIcon } from "@phosphor-icons/react/GitBranch";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { useGithubRepositories } from "lib/query/github.queries";
import { useState } from "react";
import { nextDraftId, type BranchConventionDraft, type RepoDraft } from "./topology-draft";

interface MultirepoSectionProps {
  repos: RepoDraft[];
  branchConvention: BranchConventionDraft;
  /** Full name of the Application's primary repo (excluded from the picker). */
  primaryRepoFullName?: string;
  /** Number of apps mapped to each repo alias, for the remove confirmation. */
  appCountByRepoKey: Map<string, number>;
  onReposChange: (repos: RepoDraft[]) => void;
  onBranchConventionChange: (convention: BranchConventionDraft) => void;
}

/**
 * Dependency repos for multirepo topologies. Each added repo gets its own app
 * group in the apps section and its own config revision on save; PreviewKit
 * merges every repo's apps into one preview environment per PR.
 *
 * NOTE: Not yet wired into `previewkit-config.tsx` - multirepo configuration
 * from the UI is intentionally deferred to a planned follow-up PR. The backend
 * (savePreviewkitConfig `dependencyDocuments`) and topology draft model already
 * support it; this component is the UI surface that the follow-up will mount.
 */
export function MultirepoSection({
  repos,
  branchConvention,
  primaryRepoFullName,
  appCountByRepoKey,
  onReposChange,
  onBranchConventionChange,
}: MultirepoSectionProps) {
  const { data: installationRepos } = useGithubRepositories();
  const [selectedRepoFullName, setSelectedRepoFullName] = useState("");
  const [confirmRemoveId, setConfirmRemoveId] = useState<number | undefined>(undefined);

  const usedFullNames = new Set([primaryRepoFullName, ...repos.map((repo) => repo.repo)]);
  const availableRepos = installationRepos.filter((repo) => !usedFullNames.has(repo.fullName));

  function addRepo() {
    const repo = installationRepos.find((candidate) => candidate.fullName === selectedRepoFullName);
    if (repo == null) return;
    const draft: RepoDraft = {
      id: nextDraftId(),
      name: toK8sAlias(repo.name, repos),
      repo: repo.fullName,
      fallbackBranch: repo.defaultBranch,
      githubRepositoryId: repo.id,
    };
    onReposChange([...repos, draft]);
    setSelectedRepoFullName("");
  }

  function updateRepo(id: number, patch: Partial<RepoDraft>) {
    onReposChange(repos.map((repo) => (repo.id === id ? { ...repo, ...patch } : repo)));
  }

  function removeRepo(id: number) {
    onReposChange(repos.filter((repo) => repo.id !== id));
    setConfirmRemoveId(undefined);
  }

  return (
    <section className="border border-border-dim bg-surface-base">
      <div className="flex items-center justify-between border-b border-border-dim bg-surface-raised px-5 py-4">
        <h3 className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">Dependency repos</h3>
        <span className="font-mono text-2xs text-text-secondary">multirepo topologies</span>
      </div>

      <div className="space-y-4 p-5">
        {repos.length === 0 ? (
          <p className="text-sm text-text-secondary">
            All apps come from the primary repo. Add a dependency repo when parts of your stack (API, workers) live in
            other repositories - they deploy into the same preview environment.
          </p>
        ) : (
          repos.map((repo) => {
            const appCount = appCountByRepoKey.get(repo.name) ?? 0;
            return (
              <div key={repo.id} className="border border-border-dim p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <GitBranchIcon size={16} className="text-primary-ink" />
                  <span className="truncate font-mono text-sm text-text-primary" title={repo.repo}>
                    {repo.repo}
                  </span>
                  <Badge variant="outline">
                    {appCount} {appCount === 1 ? "app" : "apps"}
                  </Badge>
                  {confirmRemoveId === repo.id ? (
                    <span className="ml-auto flex items-center gap-2">
                      <span className="text-2xs text-status-critical">
                        {appCount > 0
                          ? `Removes ${appCount} mapped ${appCount === 1 ? "app" : "apps"}.`
                          : "Remove repo?"}
                      </span>
                      <Button variant="destructive" size="xs" onClick={() => removeRepo(repo.id)}>
                        confirm
                      </Button>
                      <Button variant="ghost" size="xs" onClick={() => setConfirmRemoveId(undefined)}>
                        cancel
                      </Button>
                    </span>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      title="Remove repo"
                      className="ml-auto hover:text-status-critical"
                      onClick={() => setConfirmRemoveId(repo.id)}
                    >
                      <TrashIcon size={14} />
                    </Button>
                  )}
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor={`pk-repo-${repo.id}-name`}>Alias</Label>
                    <Input
                      id={`pk-repo-${repo.id}-name`}
                      value={repo.name}
                      onChange={(event) => updateRepo(repo.id, { name: event.target.value })}
                      placeholder="api"
                      className="font-mono"
                    />
                  </div>
                  <div>
                    <Label htmlFor={`pk-repo-${repo.id}-fallback`}>Fallback branch</Label>
                    <Input
                      id={`pk-repo-${repo.id}-fallback`}
                      value={repo.fallbackBranch}
                      onChange={(event) => updateRepo(repo.id, { fallbackBranch: event.target.value })}
                      placeholder="main"
                      className="font-mono"
                    />
                  </div>
                </div>
              </div>
            );
          })
        )}

        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-64 flex-1">
            <Label htmlFor="pk-add-dependency-repo">Add dependency repo</Label>
            <Select value={selectedRepoFullName} onValueChange={(value) => setSelectedRepoFullName(value ?? "")}>
              <SelectTrigger id="pk-add-dependency-repo">
                <SelectValue
                  placeholder={availableRepos.length === 0 ? "No other repos available" : "Select a repository"}
                />
              </SelectTrigger>
              <SelectContent>
                {availableRepos.map((repo) => (
                  <SelectItem key={repo.id} value={repo.fullName}>
                    {repo.fullName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" className="gap-2" onClick={addRepo} disabled={selectedRepoFullName === ""}>
            <PlusIcon size={14} weight="bold" />
            Add repo
          </Button>
        </div>

        {repos.length > 0 ? (
          <BranchConventionEditor convention={branchConvention} onChange={onBranchConventionChange} />
        ) : undefined}
      </div>
    </section>
  );
}

function BranchConventionEditor({
  convention,
  onChange,
}: {
  convention: BranchConventionDraft;
  onChange: (convention: BranchConventionDraft) => void;
}) {
  function handleTypeChange(type: string | null) {
    if (type === "regex") {
      onChange({ type: "regex", pattern: "", replacement: "" });
    } else if (type === "same_branch_name" || type === "manual" || type === "none") {
      onChange({ type });
    }
  }

  return (
    <div className="border-t border-border-dim pt-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="pk-branch-convention">Branch matching</Label>
          <Select value={convention.type} onValueChange={handleTypeChange}>
            <SelectTrigger id="pk-branch-convention">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Fallback branch only</SelectItem>
              <SelectItem value="same_branch_name">Same branch name</SelectItem>
              <SelectItem value="regex">Regex rewrite</SelectItem>
              <SelectItem value="manual">Manual</SelectItem>
            </SelectContent>
          </Select>
          <p className="mt-1 text-2xs text-text-secondary">
            How PreviewKit picks each dependency repo's branch for a PR preview.
          </p>
        </div>
        {convention.type === "regex" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="pk-branch-pattern">Pattern</Label>
              <Input
                id="pk-branch-pattern"
                value={convention.pattern}
                onChange={(event) => onChange({ ...convention, pattern: event.target.value })}
                placeholder="^feature/(.+)$"
                className="font-mono"
              />
            </div>
            <div>
              <Label htmlFor="pk-branch-replacement">Replacement</Label>
              <Input
                id="pk-branch-replacement"
                value={convention.replacement}
                onChange={(event) => onChange({ ...convention, replacement: event.target.value })}
                placeholder="$1"
                className="font-mono"
              />
            </div>
          </div>
        ) : undefined}
      </div>
    </div>
  );
}

function toK8sAlias(name: string, existing: RepoDraft[]): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const sanitized = base === "" ? "repo" : base;
  if (!existing.some((repo) => repo.name === sanitized)) return sanitized;
  let suffix = 2;
  while (existing.some((repo) => repo.name === `${sanitized}-${suffix}`)) suffix += 1;
  return `${sanitized}-${suffix}`;
}
