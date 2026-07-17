import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@autonoma/blacklight";
import { GitBranchIcon } from "@phosphor-icons/react/GitBranch";
import { useDeployBranches, useSetDeployBranch } from "lib/onboarding/onboarding-api";
import { toastManager } from "lib/toast-manager";
import { useState } from "react";

// Above this many branches the dropdown grows a filter input (which doubles as
// free-text entry for a branch that isn't in the listed page).
const BRANCH_SEARCH_THRESHOLD = 8;

interface DeployBranchFieldProps {
  applicationId: string;
  /** The app's currently stored deploy branch (from getPreviewkitConfig). */
  currentBranch?: string;
  /** The linked repo's default branch, used as the fallback default. */
  defaultBranch?: string;
}

/**
 * Picks the branch the base preview (environment 0) deploys from, from the repo's
 * real branches (default branch first). Defaults to the repo's default branch.
 * Saving the branch is deliberately separate from deploying: choosing here persists
 * it; the Review step's "Save and deploy" is what actually deploys.
 */
export function DeployBranchField({ applicationId, currentBranch, defaultBranch }: DeployBranchFieldProps) {
  const branchesQuery = useDeployBranches(applicationId);
  const setBranch = useSetDeployBranch();

  const options = branchesQuery.data;
  const repoDefault = options?.defaultBranch ?? defaultBranch;
  const selected = currentBranch ?? repoDefault ?? "";
  // Always include the current selection so the Select can render it even when the
  // repo's branch page didn't (truncated repo, or the list is still loading).
  const branches = uniqueBranches([selected, repoDefault, ...(options?.branches ?? [])]);

  function choose(branch: string | null) {
    const next = branch?.trim() ?? "";
    if (next === "" || next === selected) return;
    setBranch.mutate(
      { applicationId, branch: next },
      {
        onSuccess: (result) => toastManager.add({ type: "success", title: `Deploy branch set to ${result.branch}` }),
      },
    );
  }

  return (
    <div className="border border-border-dim bg-surface-base p-4 lg:p-5">
      <div className="mb-3 flex items-center gap-2">
        <GitBranchIcon size={16} className="text-primary-ink" />
        <span className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">Deploy branch</span>
      </div>
      <p className="mb-3 max-w-xl text-2xs text-text-secondary">
        The branch this app's preview deploys from. Defaults to the repo's default branch
        {repoDefault != null ? (
          <>
            {" "}
            (<span className="font-mono text-text-primary">{repoDefault}</span>)
          </>
        ) : undefined}
        . Setting it here doesn't deploy - deploy from the review step below.
      </p>
      <div className="max-w-md">
        <Label htmlFor="pk-deploy-branch">Branch</Label>
        <Select value={selected} onValueChange={choose} disabled={setBranch.isPending}>
          <SelectTrigger id="pk-deploy-branch" className="font-mono">
            <SelectValue placeholder="Select a branch" />
          </SelectTrigger>
          <SelectContent>
            <BranchSelectItems branches={branches} repoDefault={repoDefault} truncated={options?.truncated ?? false} />
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

/**
 * The dropdown body: a filter once the list is long (whose query also becomes a
 * free-text "Use '<branch>'" entry, so a branch not in the listed page can still
 * be chosen - important for repos with more branches than one page), then each
 * branch with the repo default flagged.
 */
function BranchSelectItems({
  branches,
  repoDefault,
  truncated,
}: {
  branches: string[];
  repoDefault?: string;
  truncated: boolean;
}) {
  const [query, setQuery] = useState("");
  const showSearch = truncated || branches.length >= BRANCH_SEARCH_THRESHOLD;
  const trimmed = query.trim();
  const visible =
    trimmed === "" ? branches : branches.filter((name) => name.toLowerCase().includes(trimmed.toLowerCase()));
  const canUseCustom = trimmed !== "" && !branches.some((name) => name === trimmed);

  return (
    <>
      {showSearch && (
        <div className="px-1 pb-1 pt-0.5">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter or type a branch name"
            className="h-7 font-mono text-2xs"
            // eslint-disable-next-line jsx-a11y/no-autofocus -- the popup just opened at the user's request; focusing its filter is the expected behavior
            autoFocus
            onKeyDown={(e) => {
              // Keep printable keys local to the input - the Select's typeahead
              // would otherwise hijack them. Arrows/Enter/Escape still bubble.
              const isListNavigationKey =
                e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === "Escape";
              if (!isListNavigationKey) e.stopPropagation();
            }}
          />
        </div>
      )}
      {canUseCustom && (
        <SelectItem value={trimmed} className="font-mono">
          Use "{trimmed}"
        </SelectItem>
      )}
      {(canUseCustom || showSearch) && visible.length > 0 && <SelectSeparator />}
      {visible.map((name) => (
        <SelectItem key={name} value={name} className="font-mono">
          {name}
          {name === repoDefault && <span className="ml-1.5 font-sans text-text-secondary">- default</span>}
        </SelectItem>
      ))}
      {visible.length === 0 && !canUseCustom && (
        <p className="px-2.5 py-1.5 text-2xs text-text-secondary">No branches match "{trimmed}"</p>
      )}
    </>
  );
}

function uniqueBranches(names: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    const trimmed = name?.trim();
    if (trimmed == null || trimmed === "" || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}
