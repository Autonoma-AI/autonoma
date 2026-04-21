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
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { UploadSimpleIcon } from "@phosphor-icons/react/UploadSimple";
import { useUpsertSecrets } from "lib/query/secrets.queries";
import { type ChangeEvent, type ClipboardEvent, useRef, useState } from "react";
import { looksLikeEnvFile, parseEnv } from "./-parse-env";

interface Row {
  id: number;
  key: string;
  value: string;
  visible: boolean;
}

interface SecretDialogProps {
  applicationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialKey?: string;
  initialValue?: string;
  title?: string;
  description?: string;
}

let rowIdCounter = 0;
function newRow(partial?: Partial<Row>): Row {
  rowIdCounter += 1;
  return { id: rowIdCounter, key: "", value: "", visible: false, ...partial };
}

export function SecretDialog({
  applicationId,
  open,
  onOpenChange,
  initialKey = "",
  initialValue = "",
  title = "Add Environment Variable",
  description,
}: SecretDialogProps) {
  const [rows, setRows] = useState<Row[]>(() => [newRow({ key: initialKey, value: initialValue })]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const upsertSecrets = useUpsertSecrets(applicationId);

  function replaceWithParsed(entries: { key: string; value: string }[]) {
    if (entries.length === 0) return;
    setRows(entries.map((entry) => newRow({ key: entry.key, value: entry.value })));
  }

  function handleKeyPaste(rowId: number, event: ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData("text");
    if (!looksLikeEnvFile(text)) return;
    event.preventDefault();
    const parsed = parseEnv(text);
    if (parsed.length === 0) return;
    setRows((prev) => {
      const next = prev.filter((r) => r.id !== rowId || r.key.length > 0 || r.value.length > 0);
      return [...next, ...parsed.map((p) => newRow({ key: p.key, value: p.value }))];
    });
  }

  function handleImportClick() {
    fileInputRef.current?.click();
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file == null) return;
    const text = await file.text();
    replaceWithParsed(parseEnv(text));
  }

  function updateRow(id: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function removeRow(id: number) {
    setRows((prev) => (prev.length === 1 ? prev : prev.filter((r) => r.id !== id)));
  }

  function addRow() {
    setRows((prev) => [...prev, newRow()]);
  }

  const items = rows
    .map((r) => ({ key: r.key.trim(), value: r.value }))
    .filter((r) => r.key.length > 0 && r.value.length > 0);

  const canSave = items.length > 0 && !upsertSecrets.isPending;

  function handleSave() {
    if (!canSave) return;
    upsertSecrets.mutate(
      { applicationId, items },
      {
        onSuccess: () => {
          setRows([newRow()]);
          onOpenChange(false);
        },
      },
    );
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      setRows([newRow({ key: initialKey, value: initialValue })]);
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogBackdrop />
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {description ?? (
              <>
                Add one or many variables. Paste a <code className="font-mono">.env</code> file into the key field to
                import multiple at once. Values are never displayed again after saving.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-[1fr_1fr_auto] gap-3">
                <Label className="font-mono text-2xs uppercase tracking-widest text-text-tertiary">Key</Label>
                <Label className="font-mono text-2xs uppercase tracking-widest text-text-tertiary">Value</Label>
                <span />
              </div>
              {rows.map((row) => (
                <div key={row.id} className="grid grid-cols-[1fr_1fr_auto] items-start gap-3">
                  <Input
                    placeholder="CLIENT_KEY"
                    className="font-mono text-sm"
                    value={row.key}
                    onChange={(e) => updateRow(row.id, { key: e.target.value })}
                    onPaste={(e) => handleKeyPaste(row.id, e)}
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <div className="relative">
                    <Input
                      type={row.visible ? "text" : "password"}
                      placeholder="secret value"
                      className="pr-9 font-mono text-sm"
                      value={row.value}
                      onChange={(e) => updateRow(row.id, { value: e.target.value })}
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      onClick={() => updateRow(row.id, { visible: !row.visible })}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-text-tertiary transition-colors hover:bg-surface-raised hover:text-text-primary"
                      aria-label={row.visible ? "Hide value" : "Show value"}
                    >
                      {row.visible ? <EyeSlashIcon size={14} /> : <EyeIcon size={14} />}
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeRow(row.id)}
                    disabled={rows.length === 1}
                    className="mt-2 text-text-tertiary transition-colors hover:text-status-critical disabled:cursor-not-allowed disabled:opacity-30"
                    aria-label="Remove row"
                  >
                    <TrashIcon size={16} />
                  </button>
                </div>
              ))}
            </div>

            <Button variant="outline" size="sm" className="w-fit gap-1.5" onClick={addRow}>
              <PlusIcon size={14} weight="bold" />
              Add Another
            </Button>

            <p className="border-t border-border-dim pt-4 font-mono text-3xs text-text-tertiary">
              Values are write-only. After saving, they can be updated or deleted but never revealed again.
            </p>
          </div>
        </DialogBody>
        <DialogFooter className="justify-between">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={handleImportClick}>
              <UploadSimpleIcon size={14} />
              Import
            </Button>
            <span className="hidden font-mono text-3xs text-text-tertiary sm:inline">
              or paste .env contents in Key input
            </span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".env,text/plain"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>
          <div className="flex items-center gap-2">
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button onClick={handleSave} disabled={!canSave}>
              {upsertSecrets.isPending ? "Saving..." : "Save"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
