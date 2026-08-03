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
  Panel,
  PanelBody,
  PanelHeader,
  PanelTitle,
} from "@autonoma/blacklight";
import { ClipboardTextIcon } from "@phosphor-icons/react/ClipboardText";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { useAuth } from "lib/auth";
import { useApiKeys, useCreateApiKey, useDeleteApiKey } from "lib/query/api-keys.queries";
import { Suspense, useState } from "react";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Past this, an exact date reads better than a day count. */
const DAYS_CONSIDERED_RECENT = 30;

/**
 * Self-contained API keys management panel: create, list, copy-once, and delete.
 * API keys are organization-scoped (not tied to any single application), so this
 * panel renders identically under the org-level `/settings/api-keys` route and the
 * per-app settings tab - both read and write the same org keys.
 */
export function ApiKeysPanel() {
  const [createOpen, setCreateOpen] = useState(false);
  const [createdKey, setCreatedKey] = useState<string>();

  return (
    <div className="max-w-3xl space-y-4">
      {createdKey != null && <CreatedKeyBanner rawKey={createdKey} onDismiss={() => setCreatedKey(undefined)} />}

      <Panel>
        <PanelHeader className="flex items-center justify-between">
          <PanelTitle>API Keys</PanelTitle>
          <Button variant="accent" className="gap-1.5" onClick={() => setCreateOpen(true)}>
            <PlusIcon size={14} weight="bold" />
            Create API Key
          </Button>
        </PanelHeader>
        <PanelBody>
          <p className="mb-4 text-xs text-text-secondary">
            API keys are used to authenticate requests to the Autonoma API. Keep them secret and rotate them regularly.
          </p>
          <Suspense
            fallback={<p className="py-8 text-center font-mono text-xs text-text-secondary">Loading keys...</p>}
          >
            <ApiKeysList />
          </Suspense>
        </PanelBody>
      </Panel>

      <CreateKeyDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={setCreatedKey} />
    </div>
  );
}

function CreatedKeyBanner({ rawKey, onDismiss }: { rawKey: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    void navigator.clipboard.writeText(rawKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="border border-status-success/30 bg-status-success/5 p-4">
      <p className="font-mono text-xs font-medium text-status-success">
        API key created - copy it now, it won't be shown again.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <code className="flex-1 truncate rounded border border-border-dim bg-surface-base px-3 py-2 font-mono text-xs text-text-primary">
          {rawKey}
        </code>
        <Button variant="outline" size="sm" onClick={handleCopy} className="shrink-0 gap-1.5">
          <ClipboardTextIcon size={14} />
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="mt-2 font-mono text-3xs text-text-secondary hover:text-text-primary"
      >
        Dismiss
      </button>
    </div>
  );
}

function CreateKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (key: string) => void;
}) {
  const [name, setName] = useState("");
  const createApiKey = useCreateApiKey();

  function handleCreate() {
    if (name.trim().length === 0) return;

    createApiKey.mutate(
      { name: name.trim() },
      {
        onSuccess: (data) => {
          onCreated(data.key);
          setName("");
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogBackdrop />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create API Key</DialogTitle>
          <DialogDescription>Give your API key a name to identify it later.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-2">
            <Label htmlFor="key-name" className="font-mono text-2xs uppercase tracking-widest text-text-secondary">
              Name
            </Label>
            <Input
              id="key-name"
              placeholder="e.g. CI Pipeline, Alpha Environment"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
              }}
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button onClick={handleCreate} disabled={name.trim().length === 0 || createApiKey.isPending}>
            {createApiKey.isPending ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Anyone in the organization may delete any key, but a key acts as whoever created it,
 * so deleting a colleague's key revokes a credential they may still be depending on.
 * When the key is not the caller's own, name the creator and show how recently it was
 * used, so the decision is made with the two facts that actually matter.
 */
function DeleteKeyDialog({
  open,
  onOpenChange,
  keyId,
  keyName,
  createdBy,
  lastRequest,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  keyId: string;
  keyName: string;
  /** The creator's name, only when the key belongs to someone other than the caller. */
  createdBy?: string;
  lastRequest: Date | null;
}) {
  const deleteApiKey = useDeleteApiKey();

  function handleDelete() {
    deleteApiKey.mutate(
      { keyId },
      {
        onSuccess: () => {
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogBackdrop />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete API Key</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete <strong>{keyName}</strong>? Any integrations using this key will stop
            working.
          </DialogDescription>
        </DialogHeader>
        {createdBy != null && (
          <DialogBody>
            <div className="flex items-start gap-2.5 border-l-2 border-status-warn bg-status-warn/10 px-3 py-2.5">
              <WarningCircleIcon size={15} className="mt-0.5 shrink-0 text-status-warn" />
              <div className="flex flex-col gap-1">
                <p className="text-xs text-text-primary">
                  This key was created by <strong>{createdBy}</strong>, and may still be in use.
                </p>
                <p className="font-mono text-3xs text-text-secondary">{describeLastUse(lastRequest)}</p>
              </div>
            </div>
          </DialogBody>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button variant="destructive" onClick={handleDelete} disabled={deleteApiKey.isPending}>
            {deleteApiKey.isPending ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * How recently the key was actually used, which is the signal for whether deleting it
 * will break something right now. "Never used" is the safe case and says so plainly
 * rather than leaving the line blank.
 */
function describeLastUse(lastRequest: Date | null): string {
  if (lastRequest == null) return "Never used";

  const days = Math.floor((Date.now() - new Date(lastRequest).getTime()) / MS_PER_DAY);
  if (days <= 0) return "Last used today";
  if (days === 1) return "Last used yesterday";
  if (days < DAYS_CONSIDERED_RECENT) return `Last used ${days} days ago`;
  return `Last used ${new Date(lastRequest).toLocaleDateString()}`;
}

function ApiKeyRow({
  apiKey,
}: {
  apiKey: {
    id: string;
    name: string | null;
    start: string | null;
    createdAt: Date;
    lastRequest: Date | null;
    user: { id: string; name: string | null; email: string } | null;
  };
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const { user } = useAuth();
  const displayName = apiKey.name ?? "Unnamed key";
  const owner = apiKey.user?.name ?? apiKey.user?.email;
  // Presentation only - anyone in the organization may delete any key. This decides
  // whether the confirm dialog warns that someone else may be depending on it.
  const isSomeoneElses = apiKey.user != null && apiKey.user.id !== user?.id;

  return (
    <div className="flex items-center justify-between px-1 py-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-text-primary">{displayName}</span>
        <div className="flex items-center gap-3 font-mono text-3xs text-text-secondary">
          <span>{apiKey.start}...</span>
          <span>Created {new Date(apiKey.createdAt).toLocaleDateString()}</span>
          {apiKey.lastRequest != null && <span>Last used {new Date(apiKey.lastRequest).toLocaleDateString()}</span>}
          {owner != null && <span>by {owner}</span>}
        </div>
      </div>
      <button
        type="button"
        onClick={() => setDeleteOpen(true)}
        className="text-text-secondary transition-colors hover:text-status-critical"
        aria-label={`Delete API key ${displayName}`}
      >
        <TrashIcon size={16} />
      </button>
      <DeleteKeyDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        keyId={apiKey.id}
        keyName={displayName}
        createdBy={isSomeoneElses ? owner : undefined}
        lastRequest={apiKey.lastRequest}
      />
    </div>
  );
}

function ApiKeysList() {
  const { data: keys } = useApiKeys();

  if (keys.length === 0) {
    return (
      <div className="py-8 text-center">
        <p className="font-mono text-xs text-text-secondary">No API keys yet. Create one to get started.</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-border-dim">
      {keys.map((key) => (
        <ApiKeyRow key={key.id} apiKey={key} />
      ))}
    </div>
  );
}
