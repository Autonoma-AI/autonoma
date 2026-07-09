import {
  Button,
  Dialog,
  DialogBackdrop,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Textarea,
} from "@autonoma/blacklight";
import { useState } from "react";
import { parseDotenv } from "../../../../onboarding/-components/previewkit/topology-draft";

interface PasteEnvDialogProps {
  /** Receives the parsed `KEY=value` pairs; the manager merges them into the app. */
  onImport: (entries: Array<{ key: string; value: string }>) => void;
}

/**
 * Bulk-add variables by pasting a `.env` file, instead of adding keys one at a
 * time. Parses live so the count updates as the user pastes; the manager decides
 * secret-vs-connection and merges (see `envRowsFromDotenv`).
 */
export function PasteEnvDialog({ onImport }: PasteEnvDialogProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const entries = parseDotenv(text);

  function handleImport() {
    if (entries.length === 0) return;
    onImport(entries);
    setText("");
    setOpen(false);
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Paste .env
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogBackdrop />
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Paste a .env file</DialogTitle>
            <DialogDescription>
              Add every variable at once. Each <span className="font-mono">KEY=value</span> becomes a secret; a value
              with a <span className="font-mono">{"{{name.property}}"}</span> token becomes a connection. Existing keys
              are updated. Values are stored encrypted.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={12}
              placeholder={
                "DATABASE_URL=postgres://...\nSTRIPE_SECRET_KEY=sk_live_...\nNEXT_PUBLIC_API_URL=https://..."
              }
              className="resize-y font-mono text-2xs"
            />
            <p className="mt-2 text-2xs text-text-secondary">
              {entries.length} variable{entries.length === 1 ? "" : "s"} detected
            </p>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="cta" size="sm" disabled={entries.length === 0} onClick={handleImport}>
              Import{entries.length > 0 ? ` ${entries.length}` : ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
