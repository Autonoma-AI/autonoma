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
import { createFileRoute } from "@tanstack/react-router";
import { useApiKeys, useCreateApiKey, useDeleteApiKey } from "lib/query/api-keys.queries";
import { Suspense, useState } from "react";
import { SettingsTabNav } from "../settings/-settings-tab-nav";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/api-keys/")({
  component: ApiKeysPage,
});

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
        className="mt-2 font-mono text-3xs text-text-tertiary hover:text-text-secondary"
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
            <Label htmlFor="key-name" className="font-mono text-2xs uppercase tracking-widest text-text-tertiary">
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

function DeleteKeyDialog({
  open,
  onOpenChange,
  keyId,
  keyName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  keyId: string;
  keyName: string;
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
  const displayName = apiKey.name ?? "Unnamed key";

  return (
    <div className="flex items-center justify-between px-1 py-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-text-primary">{displayName}</span>
        <div className="flex items-center gap-3 font-mono text-3xs text-text-tertiary">
          <span>{apiKey.start}...</span>
          <span>Created {new Date(apiKey.createdAt).toLocaleDateString()}</span>
          {apiKey.lastRequest != null && <span>Last used {new Date(apiKey.lastRequest).toLocaleDateString()}</span>}
          {apiKey.user != null && <span>{apiKey.user.name ?? apiKey.user.email}</span>}
        </div>
      </div>
      <button
        type="button"
        onClick={() => setDeleteOpen(true)}
        className="text-text-tertiary transition-colors hover:text-status-critical"
        aria-label={`Delete API key ${displayName}`}
      >
        <TrashIcon size={16} />
      </button>
      <DeleteKeyDialog open={deleteOpen} onOpenChange={setDeleteOpen} keyId={apiKey.id} keyName={displayName} />
    </div>
  );
}

function ApiKeysList() {
  const { data: keys } = useApiKeys();

  if (keys.length === 0) {
    return (
      <div className="py-8 text-center">
        <p className="font-mono text-xs text-text-tertiary">No API keys yet. Create one to get started.</p>
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

function ApiKeysContent() {
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
          <Suspense fallback={<p className="py-8 text-center font-mono text-xs text-text-tertiary">Loading keys...</p>}>
            <ApiKeysList />
          </Suspense>
        </PanelBody>
      </Panel>

      <CreateKeyDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={setCreatedKey} />
    </div>
  );
}

function ApiKeysPage() {
  const { appSlug } = Route.useParams();

  return (
    <div className="flex flex-col gap-6">
      <SettingsTabNav activeTab="api-keys" appSlug={appSlug} />
      <ApiKeysContent />
    </div>
  );
}
