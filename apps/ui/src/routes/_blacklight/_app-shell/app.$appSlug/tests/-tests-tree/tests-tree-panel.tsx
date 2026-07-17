import { Button, Input } from "@autonoma/blacklight";
import { FolderDashedIcon } from "@phosphor-icons/react/FolderDashed";
import { FolderPlusIcon } from "@phosphor-icons/react/FolderPlus";
import { MinusCircleIcon } from "@phosphor-icons/react/MinusCircle";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useAuth } from "lib/auth";
import { trpc } from "lib/trpc";
import { useEffect, useRef, useState } from "react";
import { useTestChanges } from "../-use-test-changes";
import { useSelectedBranch } from "../../-use-selected-branch";
import { useCurrentApplication } from "../../../-use-current-application";
import { ChildRow } from "./child-row";
import { useTestsTree } from "./tests-tree-context";
import type { FolderNode, TestCaseRecord } from "./tree-types";
import { buildTree, collectAllFolderIds, filterChildren } from "./tree-utils";

export function TestsTreePanel() {
  const { setExpandedFolders, openCreateFolder, selectedTestSlug, selectTest } = useTestsTree();
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { isAdmin } = useAuth();

  const currentApp = useCurrentApplication();
  const { data: folders } = useSuspenseQuery(trpc.folders.list.queryOptions({ applicationId: currentApp.id }));
  const branch = useSelectedBranch();
  const changes = useTestChanges();

  const testCases: TestCaseRecord[] = branch.activeSnapshot.testCaseAssignments.map(
    (a: { testCase: { id: string; name: string; slug: string; folderId: string } }) => ({
      id: a.testCase.id,
      name: a.testCase.name,
      slug: a.testCase.slug,
      folderId: a.testCase.folderId,
    }),
  );

  const tree = buildTree(folders, testCases);

  const lower = search.trim().toLowerCase();
  const filteredTree = lower.length > 0 ? filterChildren(tree, lower) : tree;

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;

      const slugs = filteredTree.filter((n): n is TestCaseRecord => !("children" in n)).map((n) => n.slug);
      if (slugs.length === 0) return;

      e.preventDefault();

      const currentIndex = selectedTestSlug != null ? slugs.indexOf(selectedTestSlug) : -1;
      const nextIndex =
        e.key === "ArrowDown" ? Math.min(currentIndex + 1, slugs.length - 1) : Math.max(currentIndex - 1, 0);

      if (nextIndex === currentIndex) return;

      const nextSlug = slugs[nextIndex];
      if (nextSlug == null) return;

      selectTest(nextSlug);
      requestAnimationFrame(() => {
        document.querySelector(`[data-test-slug="${nextSlug}"]`)?.scrollIntoView({ block: "nearest" });
      });
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [filteredTree, selectedTestSlug, selectTest]);

  const isSearching = search.trim().length > 0;
  const prevSearchRef = useRef(isSearching);
  useEffect(() => {
    if (isSearching && !prevSearchRef.current) {
      setExpandedFolders(new Set(collectAllFolderIds(tree)));
    }
    if (!isSearching && prevSearchRef.current) {
      setExpandedFolders(new Set());
    }
    prevSearchRef.current = isSearching;
  }, [isSearching, tree, setExpandedFolders]);

  const hasNoData = folders.length === 0 && testCases.length === 0;
  const hasNoResults = !hasNoData && filteredTree.length === 0;

  if (hasNoData) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-text-tertiary">
          <FolderDashedIcon size={32} />
          <p className="text-center text-sm">No tests yet</p>
          {isAdmin && (
            <Button variant="default" size="sm" onClick={() => openCreateFolder()}>
              New folder
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="sticky top-0 z-20 flex shrink-0 gap-2 border-b border-border-mid bg-surface-raised p-2">
        <Input
          ref={inputRef}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tests..."
          className="h-8 flex-1 text-sm"
        />
        {isAdmin && (
          <Button variant="outline" size="sm" className="h-8 shrink-0 px-2" onClick={() => openCreateFolder()}>
            <FolderPlusIcon size={16} />
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {hasNoResults && (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-text-tertiary">
            <p className="text-center text-sm">No results for &ldquo;{search.trim()}&rdquo;</p>
          </div>
        )}
        {filteredTree.map((child) => (
          <ChildRow
            key={`${"children" in child ? "folder" : "test"}:${child.id}`}
            node={child}
            level={0}
            siblingFolderIds={filteredTree.filter((c): c is FolderNode => "children" in c).map((c) => c.id)}
          />
        ))}

        {!isSearching && changes.removed.length > 0 && (
          <div className="mt-2 border-t border-border-dim pt-2">
            <div className="px-4 py-1 font-mono text-3xs font-semibold uppercase tracking-widest text-text-secondary">
              Removed on this branch
            </div>
            {changes.removed.map((t) => (
              <div
                key={t.id}
                className="flex items-center gap-1.5 py-1.5 pr-2 pl-7 text-sm text-status-critical"
                title="Removed on this branch"
              >
                <MinusCircleIcon size={14} className="shrink-0" />
                <span className="truncate line-through">{t.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
