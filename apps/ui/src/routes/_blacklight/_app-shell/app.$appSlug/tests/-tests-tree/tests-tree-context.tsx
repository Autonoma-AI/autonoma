import { Skeleton } from "@autonoma/blacklight";
import { useNavigate, useParams } from "@tanstack/react-router";
import { type ReactNode, Suspense, createContext, useContext, useState } from "react";
import { useCurrentApplication } from "../../../-use-current-application";
import { CreateFolderDialog } from "./dialogs/create-folder-dialog";
import { DeleteFolderDialog, DeleteTestDialog } from "./dialogs/delete-dialog";
import { MoveDialog } from "./dialogs/move-dialog";
import { RenameDialog } from "./dialogs/rename-dialog";

export interface TestsTreeContextValue {
  expandedFolders: Set<string>;
  toggleFolder: (id: string) => void;
  toggleFolderGroup: (ids: string[], expand: boolean) => void;
  setExpandedFolders: (folders: Set<string>) => void;

  selectedTestSlug: string | undefined;
  selectTest: (slug: string) => void;

  openCreateFolder: (parentId?: string) => void;
  openRename: (type: "folder" | "test", id: string, currentName: string) => void;
  openMoveFolder: (folderId: string, name: string) => void;
  openDeleteFolder: (folderId: string, folderName: string, testCount: number, subfolderCount: number) => void;
  openDeleteTest: (testId: string, testName: string) => void;
}

const TestsTreeContext = createContext<TestsTreeContextValue | undefined>(undefined);

export function useTestsTree() {
  const ctx = useContext(TestsTreeContext);
  if (ctx == null) {
    throw new Error("useTestsTree must be used within TestsTreeProvider");
  }
  return ctx;
}

interface RenameState {
  type: "folder" | "test";
  id: string;
  currentName: string;
}

interface DeleteFolderState {
  folderId: string;
  folderName: string;
  testCount: number;
  subfolderCount: number;
}

interface DeleteTestState {
  testId: string;
  testName: string;
}

interface MoveState {
  folderId: string;
  name: string;
}

export function TestsTreeProvider({ children }: { children: ReactNode }) {
  const currentApp = useCurrentApplication();
  const navigate = useNavigate();
  const { appSlug } = useParams({ from: "/_blacklight/_app-shell/app/$appSlug" });
  // `shouldThrow: false` returns the typed params on the detail route, or undefined on the index - no `as` cast.
  const selectedTestSlug = useParams({
    from: "/_blacklight/_app-shell/app/$appSlug/tests/$testSlug",
    shouldThrow: false,
  })?.testSlug;

  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  function toggleFolder(folderId: string) {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }

  function toggleFolderGroup(folderIds: string[], expand: boolean) {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      for (const id of folderIds) {
        if (expand) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  function selectTest(slug: string) {
    // Preserve the `?branch=` search param so selecting a test keeps the current branch scope.
    void navigate({
      to: "/app/$appSlug/tests/$testSlug",
      params: { appSlug, testSlug: slug },
      search: (prev) => prev,
    });
  }

  // Dialog state
  const [createFolderParentId, setCreateFolderParentId] = useState<string | null>(null);
  const [rename, setRename] = useState<RenameState | null>(null);
  const [moveFolder, setMoveFolder] = useState<MoveState | null>(null);
  const [deleteFolder, setDeleteFolder] = useState<DeleteFolderState | null>(null);
  const [deleteTest, setDeleteTest] = useState<DeleteTestState | null>(null);

  const value: TestsTreeContextValue = {
    expandedFolders,
    toggleFolder,
    toggleFolderGroup,
    setExpandedFolders,
    selectedTestSlug,
    selectTest,
    openCreateFolder: (parentId) => setCreateFolderParentId(parentId ?? "__open__"),
    openRename: (type, id, currentName) => setRename({ type, id, currentName }),
    openMoveFolder: (folderId, name) => setMoveFolder({ folderId, name }),
    openDeleteFolder: (folderId, folderName, testCount, subfolderCount) =>
      setDeleteFolder({ folderId, folderName, testCount, subfolderCount }),
    openDeleteTest: (testId, testName) => setDeleteTest({ testId, testName }),
  };

  return (
    <TestsTreeContext.Provider value={value}>
      {children}

      {createFolderParentId != null && (
        <CreateFolderDialog
          open
          onOpenChange={(open) => !open && setCreateFolderParentId(null)}
          applicationId={currentApp.id}
          parentId={createFolderParentId === "__open__" ? undefined : createFolderParentId}
        />
      )}

      {rename != null && (
        <RenameDialog
          key={`${rename.type}-${rename.id}`}
          open
          onOpenChange={(open) => !open && setRename(null)}
          type={rename.type}
          id={rename.id}
          currentName={rename.currentName}
        />
      )}

      {moveFolder != null && (
        <Suspense
          fallback={
            <div className="flex flex-col gap-3 p-6">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-48" />
              <div className="flex flex-col gap-2">
                {["sk-1", "sk-2", "sk-3", "sk-4"].map((id) => (
                  <Skeleton key={id} className="h-9 w-full" />
                ))}
              </div>
            </div>
          }
        >
          <MoveDialog
            key={moveFolder.folderId}
            open
            onOpenChange={(open) => !open && setMoveFolder(null)}
            folderId={moveFolder.folderId}
            name={moveFolder.name}
          />
        </Suspense>
      )}

      {deleteFolder != null && (
        <DeleteFolderDialog
          open
          onOpenChange={(open) => !open && setDeleteFolder(null)}
          folderId={deleteFolder.folderId}
          folderName={deleteFolder.folderName}
          testCount={deleteFolder.testCount}
          subfolderCount={deleteFolder.subfolderCount}
        />
      )}

      {deleteTest != null && (
        <DeleteTestDialog
          open
          onOpenChange={(open) => !open && setDeleteTest(null)}
          testId={deleteTest.testId}
          testName={deleteTest.testName}
        />
      )}
    </TestsTreeContext.Provider>
  );
}
