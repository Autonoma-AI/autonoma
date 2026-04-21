import { Button, Input, Panel, PanelBody, PanelHeader, PanelTitle, Skeleton } from "@autonoma/blacklight";
import { KeyIcon } from "@phosphor-icons/react/Key";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { createFileRoute } from "@tanstack/react-router";
import { type SecretSummary, useSecrets } from "lib/query/secrets.queries";
import { Suspense, useMemo, useState } from "react";
import { useCurrentApplication } from "../../-use-current-application";
import { SettingsTabNav } from "../settings/-settings-tab-nav";
import { ApiIntegration } from "./-api-integration";
import { DeleteSecretDialog } from "./-delete-secret-dialog";
import { SecretDialog } from "./-secret-dialog";
import { SecretRow } from "./-secret-row";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/secrets/")({
  component: SecretsPage,
});

function SecretsPage() {
  const { appSlug } = Route.useParams();
  const app = useCurrentApplication();

  return (
    <div className="flex flex-col gap-6">
      <SettingsTabNav activeTab="secrets" appSlug={appSlug} />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <Panel>
          <PanelHeader>
            <div>
              <PanelTitle>Environment Variables</PanelTitle>
              <p className="mt-1 font-mono text-xs text-text-secondary">
                Store secrets for <span className="text-text-primary">{app.name}</span>. Use the UI or fetch them at
                runtime via the API.
              </p>
            </div>
          </PanelHeader>
          <PanelBody>
            <Suspense fallback={<SecretsListSkeleton />}>
              <SecretsList applicationId={app.id} />
            </Suspense>
          </PanelBody>
        </Panel>

        <Panel className="xl:sticky xl:top-6 xl:self-start">
          <PanelHeader>
            <PanelTitle>Accessing via API</PanelTitle>
          </PanelHeader>
          <PanelBody>
            <ApiIntegration applicationId={app.id} />
          </PanelBody>
        </Panel>
      </div>
    </div>
  );
}

function SecretsList({ applicationId }: { applicationId: string }) {
  const { data: secrets } = useSecrets(applicationId);
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<SecretSummary>();
  const [deleting, setDeleting] = useState<SecretSummary>();

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q.length === 0) return secrets;
    return secrets.filter((s) => s.key.toLowerCase().includes(q));
  }, [secrets, search]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="relative w-72">
          <MagnifyingGlassIcon
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
          />
          <Input
            type="text"
            placeholder="Search keys..."
            className="pl-8"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button variant="accent" className="gap-1.5" onClick={() => setAddOpen(true)}>
          <PlusIcon size={14} weight="bold" />
          Add Environment Variable
        </Button>
      </div>

      {secrets.length === 0 ? (
        <EmptyState onAdd={() => setAddOpen(true)} />
      ) : filtered.length === 0 ? (
        <div className="rounded-md border border-border-dim bg-surface-base px-4 py-10 text-center">
          <p className="font-mono text-xs text-text-tertiary">No keys match "{search}"</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border-dim bg-surface-base">
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto] gap-4 border-b border-border-dim bg-surface-raised px-4 py-2 font-mono text-2xs uppercase tracking-widest text-text-tertiary">
            <span>Key</span>
            <span>Value</span>
            <span className="pr-2 text-right">Actions</span>
          </div>
          {filtered.map((secret) => (
            <SecretRow key={secret.key} secret={secret} onEdit={setEditing} onDelete={setDeleting} />
          ))}
        </div>
      )}

      <SecretDialog applicationId={applicationId} open={addOpen} onOpenChange={setAddOpen} />
      {editing !== undefined && (
        <SecretDialog
          applicationId={applicationId}
          open={editing !== undefined}
          onOpenChange={(open) => {
            if (!open) setEditing(undefined);
          }}
          initialKey={editing.key}
          title="Update Environment Variable"
          description="Enter a new value to replace the existing one. The previous value cannot be recovered."
        />
      )}
      <DeleteSecretDialog
        applicationId={applicationId}
        open={deleting != null}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined);
        }}
        secretKey={deleting?.key}
      />
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border-dim bg-surface-base px-6 py-16 text-center">
      <div className="rounded-full border border-border-dim bg-surface-raised p-3 text-text-tertiary">
        <KeyIcon size={20} />
      </div>
      <div>
        <p className="text-sm font-medium text-text-primary">No environment variables yet</p>
        <p className="mt-1 font-mono text-xs text-text-tertiary">
          Paste a <code>.env</code> file or add keys one at a time.
        </p>
      </div>
      <Button variant="accent" className="gap-1.5" onClick={onAdd}>
        <PlusIcon size={14} weight="bold" />
        Add Environment Variable
      </Button>
    </div>
  );
}

function SecretsListSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-9 w-52" />
      </div>
      <div className="overflow-hidden rounded-md border border-border-dim bg-surface-base">
        {Array.from({ length: 4 }, (_, i) => (
          <div
            key={i}
            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto] gap-4 border-b border-border-dim px-4 py-3 last:border-b-0"
          >
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-7 w-full" />
            <Skeleton className="h-7 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}
