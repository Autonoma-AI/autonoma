import { Button, Input, cn } from "@autonoma/blacklight";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { FileTextIcon } from "@phosphor-icons/react/FileText";
import { FolderIcon } from "@phosphor-icons/react/Folder";
import { FolderDashedIcon } from "@phosphor-icons/react/FolderDashed";
import { FolderOpenIcon } from "@phosphor-icons/react/FolderOpen";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { useFolders } from "lib/query/folders.queries";
import { createContext, useContext, useState } from "react";
import type { ChildNode, FolderNode, TestCaseRecord } from "../../tests/-tests-tree/tree-types";
import { buildTree, collectAllFolderIds, filterChildren } from "../../tests/-tests-tree/tree-utils";

// ─── Tree Context ───────────────────────────────────────────────────────────

interface EditTreeContextValue {
  selectedTestId?: string;
  onSelectTest: (testCaseId: string) => void;
  expandedFolders: Set<string>;
  toggleFolder: (folderId: string) => void;
  changesByTestCaseId: Map<string, "added" | "removed" | "updated">;
}

const EditTreeContext = createContext<EditTreeContextValue | undefined>(undefined);

function useEditTreeContext() {
  const ctx = useContext(EditTreeContext);
  if (ctx == null) throw new Error("useEditTreeContext must be used within EditTreePanel");
  return ctx;
}

// ─── Panel ──────────────────────────────────────────────────────────────────

interface EditTreePanelProps {
  testCases: TestCaseRecord[];
  selectedTestId?: string;
  onSelectTest: (testCaseId: string) => void;
  onOpenAddDialog?: () => void;
  changesByTestCaseId: Map<string, "added" | "removed" | "updated">;
}

export function EditTreePanel({
  testCases,
  selectedTestId,
  onSelectTest,
  onOpenAddDialog,
  changesByTestCaseId,
}: EditTreePanelProps) {
  const { data: folders } = useFolders();

  const [search, setSearch] = useState("");
  const [manualExpanded, setManualExpanded] = useState<Set<string>>(new Set());

  const tree = buildTree(folders, testCases);
  const lower = search.trim().toLowerCase();
  const isSearching = lower.length > 0;
  const filteredTree = isSearching ? filterChildren(tree, lower) : tree;

  const allFolderIds = isSearching ? new Set(collectAllFolderIds(tree)) : undefined;
  const expandedFolders = allFolderIds ?? manualExpanded;

  function toggleFolder(folderId: string) {
    setManualExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }

  const hasNoData = folders.length === 0 && testCases.length === 0;

  if (hasNoData) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-text-tertiary">
          <FolderDashedIcon size={32} />
          <p className="text-center text-sm">No tests yet</p>
          {onOpenAddDialog != null && (
            <Button variant="default" size="sm" onClick={onOpenAddDialog}>
              Add test
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <EditTreeContext
      value={{
        selectedTestId,
        onSelectTest,
        expandedFolders,
        toggleFolder,
        changesByTestCaseId,
      }}
    >
      <div className="flex h-full flex-col">
        <div className="sticky top-0 z-20 flex shrink-0 gap-2 border-b border-border-mid bg-surface-raised p-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tests..."
            className="h-8 flex-1 text-sm"
          />
          {onOpenAddDialog != null && (
            <Button variant="outline" size="sm" className="h-8 shrink-0 px-2" onClick={onOpenAddDialog}>
              <PlusIcon size={16} />
            </Button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {filteredTree.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-text-tertiary">
              <p className="text-center text-sm">No results for &ldquo;{search.trim()}&rdquo;</p>
            </div>
          )}
          {filteredTree.map((child) => (
            <EditChildRow key={`${"children" in child ? "folder" : "test"}:${child.id}`} node={child} level={0} />
          ))}
        </div>
      </div>
    </EditTreeContext>
  );
}

// ─── Tree Row Components ─────────────────────────────────────────────────────

interface EditChildRowProps {
  node: ChildNode;
  level: number;
}

function EditChildRow({ node, level }: EditChildRowProps) {
  if ("children" in node) {
    return <EditFolderRow node={node} level={level} />;
  }
  return <EditTestRow node={node} level={level} />;
}

function EditFolderRow({ node, level }: { node: FolderNode; level: number }) {
  const { expandedFolders, toggleFolder } = useEditTreeContext();
  const isExpanded = expandedFolders.has(node.id);

  return (
    <div>
      <button
        type="button"
        onClick={() => toggleFolder(node.id)}
        className="group flex w-full items-center gap-1.5 py-1.5 pr-2 text-left text-sm transition-colors hover:bg-surface-base"
        style={{ paddingLeft: `${level * 16 + 12}px` }}
      >
        <span className="w-4 shrink-0 text-text-tertiary hover:text-text-secondary">
          {isExpanded ? <CaretDownIcon size={14} /> : <CaretRightIcon size={14} />}
        </span>
        {isExpanded ? (
          <FolderOpenIcon size={14} className="shrink-0 text-text-secondary" />
        ) : (
          <FolderIcon size={14} className="shrink-0 text-text-tertiary" />
        )}
        <span className="truncate text-text-secondary">{node.name}</span>
        <span className="ml-auto shrink-0 text-xs text-text-tertiary">{node.children.length}</span>
      </button>

      {isExpanded &&
        node.children.map((child) => (
          <EditChildRow key={`${"children" in child ? "folder" : "test"}:${child.id}`} node={child} level={level + 1} />
        ))}
    </div>
  );
}

const CHANGE_DOT_COLORS = {
  added: "bg-status-success",
  updated: "bg-status-warn",
  removed: "bg-status-critical",
} as const;

function EditTestRow({ node, level }: { node: TestCaseRecord; level: number }) {
  const { selectedTestId, onSelectTest, changesByTestCaseId } = useEditTreeContext();
  const isSelected = selectedTestId === node.id;
  const changeType = changesByTestCaseId.get(node.id);
  const isRemoved = changeType === "removed";

  return (
    <button
      onClick={() => onSelectTest(node.id)}
      type="button"
      className={cn(
        "group flex w-full items-center gap-1.5 py-1.5 pr-2 text-left text-sm transition-colors hover:bg-surface-base",
        isSelected && "bg-surface-base",
      )}
      style={{ paddingLeft: `${level * 16 + 12}px` }}
    >
      <span className="w-4 shrink-0" />
      <FileTextIcon size={14} className={cn("shrink-0 text-text-tertiary", isRemoved && "opacity-50")} />
      <span
        className={cn(
          "truncate",
          isSelected ? "font-medium text-text-primary" : "text-text-secondary",
          isRemoved && "text-text-tertiary line-through opacity-60",
        )}
      >
        {node.name}
      </span>
      {changeType != null && (
        <span className={cn("ml-auto size-2 shrink-0 rounded-full", CHANGE_DOT_COLORS[changeType])} />
      )}
    </button>
  );
}
