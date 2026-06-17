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
import { AppNameSchema } from "@autonoma/types";
import { useState } from "react";

interface AddAppDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingApps: string[];
  onCreated: (appName: string) => void;
}

// "Creating" an app here just selects a new bundle name; the bundle row is
// persisted lazily when the first variable is saved (upsert auto-creates it).
export function AddAppDialog({ open, onOpenChange, existingApps, onCreated }: AddAppDialogProps) {
  const [name, setName] = useState("");
  const trimmed = name.trim();

  const parsed = AppNameSchema.safeParse(trimmed);
  const isDuplicate = existingApps.includes(trimmed);
  const error = resolveError(trimmed, parsed.success ? undefined : parsed.error.issues[0]?.message, isDuplicate);
  const canCreate = parsed.success && !isDuplicate;

  function handleCreate() {
    if (!canCreate) return;
    onCreated(trimmed);
    setName("");
  }

  function handleOpenChange(next: boolean) {
    if (!next) setName("");
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogBackdrop />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New App</DialogTitle>
          <DialogDescription>
            Secrets are grouped per app, matching the app names declared in your{" "}
            <code className="font-mono">.preview.yaml</code>.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form
            className="flex flex-col gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              handleCreate();
            }}
          >
            <Label className="font-mono text-2xs uppercase tracking-widest text-text-secondary">App name</Label>
            <Input
              placeholder="web"
              className="font-mono text-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            {error != null && <p className="font-mono text-3xs text-status-critical">{error}</p>}
          </form>
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button onClick={handleCreate} disabled={!canCreate}>
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function resolveError(trimmed: string, schemaError: string | undefined, isDuplicate: boolean): string | undefined {
  if (trimmed.length === 0) return undefined;
  if (schemaError != null) return schemaError;
  if (isDuplicate) return "An app with this name already exists.";
  return undefined;
}
