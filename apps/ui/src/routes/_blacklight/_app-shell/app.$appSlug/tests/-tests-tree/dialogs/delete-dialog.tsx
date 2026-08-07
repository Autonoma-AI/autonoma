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
} from "@autonoma/blacklight";
import { useDeleteFolder } from "lib/query/folders.queries";
import { useDeleteTest } from "lib/query/tests.queries";
import { useSelectedBranch } from "../../../-use-selected-branch";
import { useAppNavigate } from "../../../../-use-app-navigate";

interface DeleteFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folderId: string;
  folderName: string;
  testCount: number;
  subfolderCount: number;
}

export function DeleteFolderDialog({
  open,
  onOpenChange,
  folderId,
  folderName,
  testCount,
  subfolderCount,
}: DeleteFolderDialogProps) {
  const appNavigate = useAppNavigate();
  const deleteFolder = useDeleteFolder(folderId);

  function handleDelete() {
    deleteFolder.mutate(
      { folderId },
      {
        onSuccess: () => {
          onOpenChange(false);
          void appNavigate({ to: "/app/$appSlug/tests" });
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogBackdrop />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete folder &quot;{folderName}&quot;?</DialogTitle>
          <DialogDescription>
            This will delete {testCount} {testCount === 1 ? "test" : "tests"} and {subfolderCount}{" "}
            {subfolderCount === 1 ? "subfolder" : "subfolders"}. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {deleteFolder.error != null && (
          <p className="px-6 text-sm text-status-critical">{deleteFolder.error.message}</p>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button variant="destructive" onClick={handleDelete} disabled={deleteFolder.isPending}>
            {deleteFolder.isPending ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface DeleteTestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  testId: string;
  testName: string;
}

export function DeleteTestDialog({ open, onOpenChange, testId, testName }: DeleteTestDialogProps) {
  const appNavigate = useAppNavigate();
  const branch = useSelectedBranch();
  const deleteTest = useDeleteTest();

  function handleDelete() {
    deleteTest.mutate(
      { testId, branchId: branch.id },
      {
        onSuccess: () => {
          onOpenChange(false);
          void appNavigate({ to: "/app/$appSlug/tests" });
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogBackdrop />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete test &quot;{testName}&quot;?</DialogTitle>
          <DialogDescription>
            It stops running on <span className="font-mono">{branch.name}</span>. Its past runs and findings are kept.
          </DialogDescription>
        </DialogHeader>
        {deleteTest.error != null && <p className="px-6 text-sm text-status-critical">{deleteTest.error.message}</p>}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button variant="destructive" onClick={handleDelete} disabled={deleteTest.isPending}>
            {deleteTest.isPending ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
