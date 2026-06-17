import { Button, Input, Label, Skeleton } from "@autonoma/blacklight";
import { KeyIcon } from "@phosphor-icons/react/Key";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import {
  useDeletePreviewkitSecret,
  usePreviewkitSecrets,
  useUpsertPreviewkitSecrets,
} from "lib/onboarding/onboarding-api";
import { toastManager } from "lib/toast-manager";
import { Suspense, useEffect, useRef, useState } from "react";

export interface SecretsApp {
  name: string;
  /**
   * The Application that owns this app's config revision: the onboarding
   * Application for primary-repo apps, the dependency repo's Application for
   * multirepo apps. Secrets are stored and validated against the owner.
   */
  applicationId: string;
}

interface SecretsSectionProps {
  /** Apps across all repo groups (names are unique across the merged topology). */
  apps: SecretsApp[];
  configSaved: boolean;
  focusSection?: "config" | "secrets" | "logs";
  focusApp?: string;
  showRecoveryWarning?: boolean;
  onFocusHandled?: () => void;
}

/** Write-only per-app secrets, scoped to app names in each owning Application's active config revision. */
export function SecretsSection({
  apps,
  configSaved,
  focusSection,
  focusApp,
  showRecoveryWarning,
  onFocusHandled,
}: SecretsSectionProps) {
  const [selectedAppName, setSelectedAppName] = useState(apps[0]?.name ?? "");
  const effectiveApp = apps.find((app) => app.name === selectedAppName) ?? apps[0];
  const sectionRef = useRef<HTMLElement>(null);
  const shouldFocusSecrets = focusSection === "secrets";

  useEffect(() => {
    if (!shouldFocusSecrets) return;
    const targetApp = apps.find((app) => app.name === focusApp);
    if (targetApp != null && targetApp.name !== selectedAppName) setSelectedAppName(targetApp.name);
  }, [apps, focusApp, selectedAppName, shouldFocusSecrets]);

  useEffect(() => {
    if (!shouldFocusSecrets) return;
    sectionRef.current?.scrollIntoView({ block: "start" });
  }, [shouldFocusSecrets]);

  return (
    <section ref={sectionRef} id="previewkit-secrets" className="mt-8 border border-border-dim bg-surface-base">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-dim bg-surface-raised px-5 py-4">
        <div>
          <h2 className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">Secrets</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Values are write-only and mounted as environment variables.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {apps.map((app) => (
            <Button
              key={app.name}
              variant={effectiveApp?.name === app.name ? "accent" : "outline"}
              size="xs"
              onClick={() => setSelectedAppName(app.name)}
            >
              {app.name}
            </Button>
          ))}
        </div>
      </div>
      {showRecoveryWarning ? (
        <div className="border-l-2 border-status-warn bg-status-warn/10 px-5 py-4">
          <p className="font-mono text-2xs uppercase tracking-widest text-status-warn">Check secrets</p>
          <p className="mt-2 text-sm text-text-secondary">
            Deploy failed because a secret may be missing. Check runtime and build-time values for each app.
          </p>
        </div>
      ) : undefined}
      {!configSaved ? (
        <div className="border-l-2 border-primary-ink bg-primary-ink/10 px-5 py-4">
          <p className="font-mono text-2xs uppercase tracking-widest text-primary-ink">Save config first</p>
          <p className="mt-2 text-sm text-text-secondary">
            Secrets are scoped to app names in the active PreviewKit config revision.
          </p>
        </div>
      ) : effectiveApp != null ? (
        <Suspense fallback={<SecretsSkeleton />}>
          <SecretsTable
            applicationId={effectiveApp.applicationId}
            appName={effectiveApp.name}
            shouldFocusKeyInput={shouldFocusSecrets}
            onFocusHandled={onFocusHandled}
          />
        </Suspense>
      ) : (
        <div className="p-5 text-sm text-text-secondary">Add an app before managing secrets.</div>
      )}
    </section>
  );
}

function SecretsSkeleton() {
  return (
    <div className="space-y-3 p-5">
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-12 w-full" />
    </div>
  );
}

function SecretsTable({
  applicationId,
  appName,
  shouldFocusKeyInput,
  onFocusHandled,
}: {
  applicationId: string;
  appName: string;
  shouldFocusKeyInput: boolean;
  onFocusHandled?: () => void;
}) {
  const { data: secrets } = usePreviewkitSecrets(applicationId, appName);
  const upsert = useUpsertPreviewkitSecrets();
  const deleteSecret = useDeletePreviewkitSecret();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const keyInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!shouldFocusKeyInput) return;
    keyInputRef.current?.focus();
    onFocusHandled?.();
  }, [appName, onFocusHandled, shouldFocusKeyInput]);

  function saveSecret(secretKey: string, secretValue: string) {
    upsert.mutate(
      { applicationId, appName, items: [{ key: secretKey, value: secretValue }] },
      {
        onSuccess: () => {
          setKey("");
          setValue("");
          toastManager.add({ type: "success", title: "Secret saved" });
        },
      },
    );
  }

  return (
    <div className="divide-y divide-border-dim">
      {secrets.length === 0 ? (
        <div className="p-5 text-sm text-text-secondary">No secrets saved for {appName} yet.</div>
      ) : (
        secrets.map((secret) => (
          <SecretRow
            key={secret.key}
            secretKey={secret.key}
            maskedLength={secret.maskedLength}
            onSave={saveSecret}
            onDelete={() => deleteSecret.mutate({ applicationId, appName, key: secret.key })}
            disabled={upsert.isPending || deleteSecret.isPending}
          />
        ))
      )}
      <div className="grid gap-3 p-5 md:grid-cols-[minmax(12rem,0.7fr)_minmax(12rem,1fr)_auto]">
        <div>
          <Label htmlFor="previewkit-secret-key">Key</Label>
          <Input
            id="previewkit-secret-key"
            ref={keyInputRef}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder="DATABASE_URL"
          />
        </div>
        <div>
          <Label htmlFor="previewkit-secret-value">Value</Label>
          <Input
            id="previewkit-secret-value"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="write-only value"
            type="password"
          />
        </div>
        <Button
          variant="accent"
          className="mt-6 gap-2"
          onClick={() => saveSecret(key, value)}
          disabled={key.length === 0 || value.length === 0 || upsert.isPending}
        >
          <PlusIcon size={15} weight="bold" />
          Add secret
        </Button>
      </div>
    </div>
  );
}

function SecretRow({
  secretKey,
  maskedLength,
  onSave,
  onDelete,
  disabled,
}: {
  secretKey: string;
  maskedLength: number;
  onSave: (key: string, value: string) => void;
  onDelete: () => void;
  disabled: boolean;
}) {
  const [value, setValue] = useState("");
  const masked = "•".repeat(Math.max(maskedLength, 8));

  return (
    <div className="grid gap-3 p-5 md:grid-cols-[minmax(12rem,0.7fr)_minmax(12rem,1fr)_auto_auto]">
      <div className="flex items-center gap-3">
        <KeyIcon size={16} className="text-primary-ink" />
        <div>
          <p className="font-mono text-sm text-text-primary">{secretKey}</p>
          <p className="font-mono text-2xs text-text-secondary">{masked}</p>
        </div>
      </div>
      <Input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="new write-only value"
        type="password"
      />
      <Button variant="outline" onClick={() => onSave(secretKey, value)} disabled={value.length === 0 || disabled}>
        Save value
      </Button>
      <Button variant="outline" className="gap-2" onClick={onDelete} disabled={disabled}>
        <TrashIcon size={14} />
        Delete
      </Button>
    </div>
  );
}
