import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Skeleton,
  cn,
} from "@autonoma/blacklight";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { GitBranchIcon } from "@phosphor-icons/react/GitBranch";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useBranches } from "lib/query/branches.queries";
import { Suspense } from "react";
import { useMainBranch } from "../-use-main-branch";
import { useSelectedBranchName } from "../-use-selected-branch";
import { useCurrentApplication } from "../../-use-current-application";

/**
 * Scopes the whole Tests page to a git branch. Lists the app's main branch plus every open pull request, since
 * tests can differ per branch. The choice lives in the `?branch=` search param (see -use-selected-branch), so
 * selecting a branch re-runs the detail loader and re-scopes the tree, plan, runs, and new/modified markers.
 */
export function BranchPicker() {
  const selectedBranchName = useSelectedBranchName();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex h-8 items-center gap-2 border border-border-mid bg-surface-base px-3 font-mono text-xs text-text-primary transition-colors hover:bg-surface-raised">
        <GitBranchIcon size={14} className="text-text-secondary" />
        <span className="max-w-56 truncate">{selectedBranchName}</span>
        <CaretDownIcon size={10} className="text-text-secondary" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        {/* Plain heading, not a DropdownMenuGroupLabel: Base UI's Menu.GroupLabel must live inside a Menu.Group. */}
        <div className="px-2.5 py-1 font-mono text-4xs font-bold uppercase tracking-wider text-text-secondary">
          Switch branch
        </div>
        <DropdownMenuSeparator />
        <Suspense fallback={<BranchListSkeleton />}>
          <BranchList selectedBranchName={selectedBranchName} />
        </Suspense>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BranchList({ selectedBranchName }: { selectedBranchName: string }) {
  const app = useCurrentApplication();
  const mainBranch = useMainBranch();
  const { data: openBranches } = useBranches("open");
  const navigate = useNavigate();
  const { appSlug } = useParams({ from: "/_blacklight/_app-shell/app/$appSlug" });
  // `shouldThrow: false` returns the typed params on the detail route, or undefined on the index - no `as` cast.
  const testSlug = useParams({
    from: "/_blacklight/_app-shell/app/$appSlug/tests/$testSlug",
    shouldThrow: false,
  })?.testSlug;

  function select(branchName: string) {
    // main is the baseline, so it clears the param rather than pinning `?branch=main` in the URL.
    const branch = branchName === app.mainBranch.name ? undefined : branchName;
    if (testSlug != null) {
      void navigate({
        to: "/app/$appSlug/tests/$testSlug",
        params: { appSlug, testSlug },
        search: { branch },
      });
      return;
    }
    void navigate({ to: "/app/$appSlug/tests", params: { appSlug }, search: { branch } });
  }

  const prBranches = openBranches.filter((b) => b.name !== app.mainBranch.name);

  return (
    <>
      <BranchOption
        name={app.mainBranch.name}
        testCount={mainBranch.activeSnapshot.testCaseAssignments.length}
        isCurrent={selectedBranchName === app.mainBranch.name}
        onSelect={() => select(app.mainBranch.name)}
      />
      {prBranches.length > 0 && <DropdownMenuSeparator />}
      {prBranches.map((b) => (
        <BranchOption
          key={b.id}
          name={b.name}
          testCount={b.activeSnapshot?._count.testCaseAssignments ?? 0}
          isCurrent={selectedBranchName === b.name}
          onSelect={() => select(b.name)}
        />
      ))}
    </>
  );
}

function BranchOption({
  name,
  testCount,
  isCurrent,
  onSelect,
}: {
  name: string;
  testCount: number;
  isCurrent: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem onClick={onSelect} className="gap-2.5">
      {isCurrent ? (
        <CheckIcon size={13} className="shrink-0 text-primary-ink" />
      ) : (
        <span className="w-[13px] shrink-0" />
      )}
      <span
        className={cn(
          "min-w-0 flex-1 truncate font-mono text-xs",
          isCurrent ? "text-text-primary" : "text-text-secondary",
        )}
      >
        {name}
      </span>
      <span className="shrink-0 font-mono text-3xs text-text-secondary">{testCount}</span>
    </DropdownMenuItem>
  );
}

function BranchListSkeleton() {
  return (
    <div className="flex flex-col gap-1.5 p-2">
      {["b1", "b2", "b3"].map((id) => (
        <Skeleton key={id} className="h-6 w-full" />
      ))}
    </div>
  );
}
