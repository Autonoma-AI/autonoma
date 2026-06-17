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
import { EyeIcon } from "@phosphor-icons/react/Eye";
import { EyeSlashIcon } from "@phosphor-icons/react/EyeSlash";
import { useUpsertSecrets } from "lib/query/secrets.queries";
import { useState } from "react";

interface EditSecretDialogProps {
  applicationId: string;
  appName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  secretKey: string | undefined;
}

// Editing is intentionally scoped to a single secret's value: no multi-row,
// no .env import. Use the Add dialog to introduce new keys in bulk.
export function EditSecretDialog({ applicationId, appName, open, onOpenChange, secretKey }: EditSecretDialogProps) {
  const [value, setValue] = useState("");
  const [visible, setVisible] = useState(false);
  const upsertSecrets = useUpsertSecrets(applicationId, appName);

  const canSave = value.length > 0 && secretKey != null && !upsertSecrets.isPending;

  function handleSave() {
    if (!canSave || secretKey == null) return;
    upsertSecrets.mutate(
      { applicationId, appName, items: [{ key: secretKey, value }] },
      {
        onSuccess: () => onOpenChange(false),
      },
    );
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      setValue("");
      setVisible(false);
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogBackdrop />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Update Environment Variable</DialogTitle>
          <DialogDescription>
            Enter a new value to replace the existing one. The previous value cannot be recovered.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              handleSave();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label className="font-mono text-2xs uppercase tracking-widest text-text-secondary">Key</Label>
              <div className="truncate rounded-md border border-border-dim bg-surface-base px-3 py-2 font-mono text-sm text-text-primary">
                {secretKey}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="font-mono text-2xs uppercase tracking-widest text-text-secondary">New value</Label>
              <div className="relative">
                <Input
                  type={visible ? "text" : "password"}
                  placeholder="secret value"
                  className="pr-9 font-mono text-sm"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setVisible(!visible)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary"
                  aria-label={visible ? "Hide value" : "Show value"}
                >
                  {visible ? <EyeSlashIcon size={14} /> : <EyeIcon size={14} />}
                </button>
              </div>
            </div>
          </form>
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button onClick={handleSave} disabled={!canSave}>
            {upsertSecrets.isPending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
