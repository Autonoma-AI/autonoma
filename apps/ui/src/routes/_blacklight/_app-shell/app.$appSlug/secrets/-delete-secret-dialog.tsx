import {
  Button,
  Dialog,
  DialogBackdrop,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@autonoma/blacklight";
import { useDeleteSecret } from "lib/query/secrets.queries";
import { useEffect, useState } from "react";

interface DeleteSecretDialogProps {
  applicationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  secretKey: string | undefined;
}

export function DeleteSecretDialog({ applicationId, open, onOpenChange, secretKey }: DeleteSecretDialogProps) {
  const deleteSecret = useDeleteSecret(applicationId);
  const [confirmation, setConfirmation] = useState("");

  useEffect(() => {
    if (!open) setConfirmation("");
  }, [open]);

  const matches = secretKey != null && confirmation === secretKey;

  function handleDelete() {
    if (secretKey == null || !matches) return;
    deleteSecret.mutate(
      { applicationId, key: secretKey },
      {
        onSuccess: () => onOpenChange(false),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogBackdrop />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete secret</DialogTitle>
          <DialogDescription>
            This action cannot be undone. Applications relying on{" "}
            <code className="font-mono text-text-primary">{secretKey}</code> will stop working immediately.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-2">
            <Label htmlFor="delete-confirm" className="font-mono text-2xs uppercase tracking-widest text-text-tertiary">
              Type <span className="text-text-primary">{secretKey}</span> to confirm
            </Label>
            <Input
              id="delete-confirm"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && matches) handleDelete();
              }}
              placeholder={secretKey}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button variant="destructive" onClick={handleDelete} disabled={!matches || deleteSecret.isPending}>
            {deleteSecret.isPending ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
