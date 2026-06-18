import { Button } from "@autonoma/blacklight";
import { previewConfigSchema, validatePreviewConfigSemantics, zodIssuesToConfigIssues } from "@autonoma/types";
import { FloppyDiskIcon } from "@phosphor-icons/react/FloppyDisk";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { usePreviewkitConfig, useSavePreviewkitConfig } from "lib/onboarding/onboarding-api";
import { toastManager } from "lib/toast-manager";
import { useState } from "react";
// Reuse the onboarding PreviewKit editor building blocks. These are
// route-excluded ("-") modules, so importing them from the settings subtree is
// a normal cross-module import - it keeps one source of truth for the topology
// draft model and the app/service cards.
import { AppCard } from "../../../onboarding/-components/previewkit/app-card";
import { ServicesSection } from "../../../onboarding/-components/previewkit/services-section";
import {
  PRIMARY_REPO_KEY,
  type AppDraft,
  type CompiledDocument,
  type DraftIssues,
  type TopologyDraft,
  documentsFromDraft,
  draftFromConfig,
  emptyAppDraft,
  emptyDraftIssues,
  isUntouchedStarterApp,
  mapIssuesToDraft,
  snapshotDocument,
} from "../../../onboarding/-components/previewkit/topology-draft";

/**
 * Persistent (post-onboarding) editor for an application's active PreviewKit
 * config, reachable from Settings -> Preview. Scope is this application only:
 * the draft is built from the primary document, so dependency repos keep their
 * own config (edited from their own app). Saving writes a new revision for this
 * application; multirepo declarations and domain/registry/hooks/addons survive
 * the round-trip via the draft's passthrough.
 */
export function PreviewConfigEditor({ appId }: { appId: string }) {
  const configQuery = usePreviewkitConfig(appId);
  const saveConfig = useSavePreviewkitConfig();

  const [draft, setDraft] = useState<TopologyDraft>(() =>
    draftFromConfig(configQuery.data.document, [], configQuery.data.saved ? "saved" : "starter"),
  );
  const [savedSnapshot, setSavedSnapshot] = useState(() =>
    snapshotDocument(documentsFromDraft(draft).primary.document),
  );

  const compiled = documentsFromDraft(draft);
  const issues = validatePrimaryDocument(compiled.primary);
  const hasUntouchedStarterApps = draft.apps.some(isUntouchedStarterApp);
  const hasBlockingIssues = issues.fieldErrors.size > 0 || issues.documentErrors.length > 0 || hasUntouchedStarterApps;
  const isDirty = snapshotDocument(compiled.primary.document) !== savedSnapshot;
  const canSave = isDirty && !hasBlockingIssues && !saveConfig.isPending;

  const deployableApps = draft.apps.filter((app) => !isUntouchedStarterApp(app));
  const allNames = [...deployableApps.map((app) => app.name), ...draft.services.map((service) => service.name)];
  const referenceTokens = [
    ...draft.services.flatMap((service) =>
      service.name.trim() !== ""
        ? [`{{${service.name}.url}}`, `{{${service.name}.host}}`, `{{${service.name}.port}}`]
        : [],
    ),
    ...deployableApps.flatMap((app) => (app.name.trim() !== "" ? [`{{${app.name}.url}}`] : [])),
  ];

  function updateApp(id: number, patch: Partial<AppDraft>) {
    setDraft((current) => ({
      ...current,
      apps: current.apps.map((app) =>
        app.id === id
          ? { ...app, ...patch, origin: app.origin === "starter" ? "manual" : (patch.origin ?? app.origin) }
          : app,
      ),
    }));
  }

  function setPrimaryApp(id: number) {
    setDraft((current) => ({
      ...current,
      apps: current.apps.map((app) => ({
        ...app,
        primary: app.id === id ? !app.primary : false,
        origin: app.id === id && app.origin === "starter" ? "manual" : app.origin,
      })),
    }));
  }

  function addApp() {
    setDraft((current) => ({ ...current, apps: [...current.apps, emptyAppDraft(PRIMARY_REPO_KEY)] }));
  }

  function removeApp(id: number) {
    setDraft((current) => ({ ...current, apps: current.apps.filter((app) => app.id !== id) }));
  }

  function handleSave() {
    if (!canSave) return;
    const primaryDocument = documentsFromDraft(draft).primary.document;
    saveConfig.mutate(
      { applicationId: appId, document: previewConfigSchema.parse(primaryDocument) },
      {
        onSuccess: () => {
          setSavedSnapshot(snapshotDocument(primaryDocument));
          toastManager.add({ type: "success", title: "PreviewKit config saved" });
        },
      },
    );
  }

  return (
    <div className="flex max-w-4xl flex-col gap-6 pb-24">
      <div className="space-y-4">
        {draft.apps.length === 0 ? (
          <p className="text-sm text-text-secondary">No apps configured yet. Add an app to get started.</p>
        ) : (
          draft.apps.map((app) => (
            <AppCard
              key={app.id}
              app={app}
              issues={issues}
              dependencyOptions={allNames.filter((name) => name.trim() !== "" && name !== app.name)}
              referenceTokens={referenceTokens}
              onChange={updateApp}
              onSetPrimary={setPrimaryApp}
              onRemove={removeApp}
            />
          ))
        )}
        <Button variant="outline" size="sm" className="w-fit gap-1.5" onClick={addApp}>
          <PlusIcon size={14} weight="bold" />
          Add app
        </Button>
      </div>

      <ServicesSection
        services={draft.services}
        onChange={(services) => setDraft((current) => ({ ...current, services }))}
      />

      {issues.documentErrors.length > 0 ? (
        <div className="border-l-2 border-status-critical bg-status-critical/10 px-4 py-3">
          <p className="font-mono text-2xs uppercase tracking-widest text-status-critical">Invalid config</p>
          {issues.documentErrors.map((message) => (
            <p key={message} className="mt-2 text-sm text-text-secondary">
              {message}
            </p>
          ))}
        </div>
      ) : undefined}
      {issues.documentWarnings.length > 0 ? (
        <div className="border-l-2 border-status-warn bg-status-warn/10 px-4 py-3">
          <p className="font-mono text-2xs uppercase tracking-widest text-status-warn">Warnings</p>
          {issues.documentWarnings.map((message) => (
            <p key={message} className="mt-2 text-sm text-text-secondary">
              {message}
            </p>
          ))}
        </div>
      ) : undefined}
      {hasUntouchedStarterApps ? (
        <p className="text-sm text-text-secondary">
          Edit the starter app before saving - the placeholder values are only a guide.
        </p>
      ) : undefined}

      <div className="sticky bottom-0 -mx-1 flex items-center justify-end gap-3 border-t border-border-dim bg-surface-void/90 px-1 py-3 backdrop-blur">
        <Button
          variant="accent"
          className="gap-2"
          onClick={handleSave}
          disabled={!canSave}
          aria-label="preview-config-save"
        >
          <FloppyDiskIcon size={16} weight="bold" />
          {saveConfig.isPending ? "Saving..." : "Save config"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Client-side validation for the single (primary) document: schema shape +
 * semantic checks (depends_on, primary, hooks), mapped back onto draft fields
 * via the compile-time index map. The server re-validates and rejects errors on
 * save; this just surfaces them inline and gates the Save button.
 */
function validatePrimaryDocument(primary: CompiledDocument): DraftIssues {
  const result = emptyDraftIssues();
  const parsed = previewConfigSchema.safeParse(primary.document);
  if (!parsed.success) {
    mapIssuesToDraft(zodIssuesToConfigIssues(parsed.error), primary.indexToDraftId, result);
    return result;
  }
  mapIssuesToDraft(validatePreviewConfigSemantics(parsed.data), primary.indexToDraftId, result);
  return result;
}
