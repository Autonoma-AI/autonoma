import {
  Button,
  Input,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from "@autonoma/blacklight";
import { KeyIcon } from "@phosphor-icons/react/Key";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { createFileRoute } from "@tanstack/react-router";
import { type SecretSummary, useSecretApps, useSecrets } from "lib/query/secrets.queries";
import { Suspense, useState } from "react";
import { useCurrentApplication } from "../../-use-current-application";
import { SettingsTabNav } from "../settings/-settings-tab-nav";
import { AddAppDialog } from "./-add-app-dialog";
import { ApiIntegration } from "./-api-integration";
import { DeleteSecretDialog } from "./-delete-secret-dialog";
import { EditSecretDialog } from "./-edit-secret-dialog";
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
      <Suspense fallback={<SecretsManagerSkeleton />}>
        <SecretsManager applicationId={app.id} appLabel={app.name} />
      </Suspense>
    </div>
  );
}

// A single Application holds many per-app secret bundles (one per app declared
// in `.preview.yaml`), keyed by appName - which rarely equals the Application's
// slug. The picker chooses the bundle and drives both the editable list and the
// API examples, so you always act on the bundle you can see.
function SecretsManager({ applicationId, appLabel }: { applicationId: string; appLabel: string }) {
  const { data: apps } = useSecretApps(applicationId);
  const [selectedApp, setSelectedApp] = useState<string | undefined>(apps[0]);
  const [addAppOpen, setAddAppOpen] = useState(false);

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
      <Panel>
        <PanelHeader>
          <div className="flex w-full flex-wrap items-start justify-between gap-3">
            <div>
              <PanelTitle>Environment Variables</PanelTitle>
              <p className="mt-1 font-mono text-xs text-text-secondary">
                Per-app secrets for <span className="text-text-primary">{appLabel}</span>. Use the UI or fetch them at
                runtime via the API.
              </p>
            </div>
            <AppPicker
              apps={apps}
              selectedApp={selectedApp}
              onSelect={setSelectedApp}
              onAddApp={() => setAddAppOpen(true)}
            />
          </div>
        </PanelHeader>
        <PanelBody>
          {selectedApp == null ? (
            <NoAppsState onAddApp={() => setAddAppOpen(true)} />
          ) : (
            <Suspense fallback={<SecretsListSkeleton />}>
              <SecretsList applicationId={applicationId} appName={selectedApp} />
            </Suspense>
          )}
        </PanelBody>
      </Panel>

      <Panel className="xl:sticky xl:top-6 xl:self-start">
        <PanelHeader>
          <PanelTitle>Accessing via API</PanelTitle>
        </PanelHeader>
        <PanelBody>
          <ApiIntegration applicationId={applicationId} appName={selectedApp ?? "{app}"} />
        </PanelBody>
      </Panel>

      <AddAppDialog
        open={addAppOpen}
        onOpenChange={setAddAppOpen}
        existingApps={apps}
        onCreated={(name) => {
          setSelectedApp(name);
          setAddAppOpen(false);
        }}
      />
    </div>
  );
}

function AppPicker({
  apps,
  selectedApp,
  onSelect,
  onAddApp,
}: {
  apps: string[];
  selectedApp: string | undefined;
  onSelect: (app: string) => void;
  onAddApp: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      {apps.length > 0 && (
        <Select<string>
          value={selectedApp}
          onValueChange={(value) => {
            if (value != null) onSelect(value);
          }}
        >
          <SelectTrigger className="w-44">
            <SelectValue>{selectedApp}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {apps.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Button variant="outline" className="gap-1.5" onClick={onAddApp}>
        <PlusIcon size={14} weight="bold" />
        New App
      </Button>
    </div>
  );
}

function SecretsList({ applicationId, appName }: { applicationId: string; appName: string }) {
  const { data: secrets } = useSecrets(applicationId, appName);
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<SecretSummary>();
  const [deleting, setDeleting] = useState<SecretSummary>();

  const query = search.trim().toLowerCase();
  const filtered = query.length === 0 ? secrets : secrets.filter((s) => s.key.toLowerCase().includes(query));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="relative w-72">
          <MagnifyingGlassIcon
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary"
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
          <p className="font-mono text-xs text-text-secondary">No keys match "{search}"</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border-dim bg-surface-base">
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto] gap-4 border-b border-border-dim bg-surface-raised px-4 py-2 font-mono text-2xs uppercase tracking-widest text-text-secondary">
            <span>Key</span>
            <span>Value</span>
            <span className="pr-2 text-right">Actions</span>
          </div>
          {filtered.map((secret) => (
            <SecretRow key={secret.key} secret={secret} onEdit={setEditing} onDelete={setDeleting} />
          ))}
        </div>
      )}

      <SecretDialog applicationId={applicationId} appName={appName} open={addOpen} onOpenChange={setAddOpen} />
      <EditSecretDialog
        applicationId={applicationId}
        appName={appName}
        open={editing != null}
        onOpenChange={(open) => {
          if (!open) setEditing(undefined);
        }}
        secretKey={editing?.key}
      />
      <DeleteSecretDialog
        applicationId={applicationId}
        appName={appName}
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
      <div className="rounded-full border border-border-dim bg-surface-raised p-3 text-text-secondary">
        <KeyIcon size={20} />
      </div>
      <div>
        <p className="text-sm font-medium text-text-primary">No environment variables yet</p>
        <p className="mt-1 font-mono text-xs text-text-secondary">
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

function NoAppsState({ onAddApp }: { onAddApp: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border-dim bg-surface-base px-6 py-16 text-center">
      <div className="rounded-full border border-border-dim bg-surface-raised p-3 text-text-secondary">
        <KeyIcon size={20} />
      </div>
      <div>
        <p className="text-sm font-medium text-text-primary">No app secret bundles yet</p>
        <p className="mt-1 font-mono text-xs text-text-secondary">
          Secrets are grouped per app, as declared in <code>.preview.yaml</code>. Create one to get started.
        </p>
      </div>
      <Button variant="accent" className="gap-1.5" onClick={onAddApp}>
        <PlusIcon size={14} weight="bold" />
        New App
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

function SecretsManagerSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
      <Panel>
        <PanelHeader>
          <div className="flex w-full items-start justify-between gap-3">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-5 w-44" />
              <Skeleton className="h-4 w-72" />
            </div>
            <Skeleton className="h-9 w-44" />
          </div>
        </PanelHeader>
        <PanelBody>
          <SecretsListSkeleton />
        </PanelBody>
      </Panel>
      <Panel className="xl:sticky xl:top-6 xl:self-start">
        <PanelHeader>
          <PanelTitle>Accessing via API</PanelTitle>
        </PanelHeader>
        <PanelBody>
          <div className="flex flex-col gap-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        </PanelBody>
      </Panel>
    </div>
  );
}
