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
} from "@autonoma/blacklight";
import { useNavigate } from "@tanstack/react-router";
import { useDeleteApplication } from "lib/query/applications.queries";
import { useState } from "react";

interface DeleteApplicationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applicationId: string;
  applicationName: string;
  // When provided, runs after a successful delete instead of navigating home.
  // Onboarding uses this to stay on the repo picker while the freed repo refreshes.
  onDeleted?: () => void;
}

export function DeleteApplicationDialog({
  open,
  onOpenChange,
  applicationId,
  applicationName,
  onDeleted,
}: DeleteApplicationDialogProps) {
  const deleteApplication = useDeleteApplication();
  const navigate = useNavigate();
  const [confirmation, setConfirmation] = useState("");

  const canDelete = confirmation === applicationName;

  function handleDelete(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canDelete) return;
    deleteApplication.mutate(
      { id: applicationId },
      {
        onSuccess: () => {
          onOpenChange(false);
          setConfirmation("");
          if (onDeleted != null) {
            onDeleted();
            return;
          }
          void navigate({ to: "/" });
        },
      },
    );
  }

  function handleOpenChange(nextOpen: boolean) {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setConfirmation("");
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogBackdrop />
      <DialogContent>
        <form onSubmit={handleDelete}>
          <DialogHeader>
            <DialogTitle>Delete application &quot;{applicationName}&quot;?</DialogTitle>
            <DialogDescription>
              This will hide the application and all its data. Type{" "}
              <span className="font-mono font-medium text-text-primary">{applicationName}</span> to confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="px-6 pb-4">
            <Input
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              placeholder={applicationName}
              autoFocus
            />
          </div>
          {deleteApplication.error != null && (
            <p className="px-6 pb-4 text-sm text-status-critical">{deleteApplication.error.message}</p>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
            <Button type="submit" variant="destructive" disabled={!canDelete || deleteApplication.isPending}>
              {deleteApplication.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
