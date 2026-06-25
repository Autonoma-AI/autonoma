import { Button } from "@autonoma/blacklight";
import { previewConfigSchema, validatePreviewConfigSemantics, zodIssuesToConfigIssues } from "@autonoma/types";
import { FloppyDiskIcon } from "@phosphor-icons/react/FloppyDisk";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { useQueryClient } from "@tanstack/react-query";
import { usePreviewkitConfig, useSavePreviewkitConfig } from "lib/onboarding/onboarding-api";
import { toastManager } from "lib/toast-manager";
import { trpc } from "lib/trpc";
import { useEffect, useRef, useState } from "react";
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
  diffAppSecrets,
  documentsFromDraft,
  draftFromConfig,
  emptyAppDraft,
  emptyDraftIssues,
  isUntouchedStarterApp,
  mapIssuesToDraft,
  snapshotDocument,
  withSecretRows,
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
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState<TopologyDraft>(() =>
    draftFromConfig(configQuery.data.document, [], configQuery.data.saved ? "saved" : "starter"),
  );
  const [savedSnapshot, setSavedSnapshot] = useState(() =>
    snapshotDocument(documentsFromDraft(draft).primary.document),
  );

  // Secret keys each primary app loaded with, so a save can diff upserts/deletes.
  // Values are never fetched (AWS is write-only) - only key names, shown masked.
  const loadedSecretKeys = useRef<Map<string, string[]>>(new Map());
  // Snapshot of the draft to revert to on Cancel; refreshed on load and on save.
  const baselineDraft = useRef<TopologyDraft | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const apps = draft.apps.filter((app) => app.repoKey === PRIMARY_REPO_KEY && app.name.trim().length >= 2);
      const entries = await Promise.all(
        apps.map(async (app) => {
          const appName = app.name.trim();
          try {
            const list = await queryClient.fetchQuery(
              trpc.secrets.list.queryOptions({ applicationId: appId, appName }),
            );
            return [appName, list.map((secret) => secret.key)] as const;
          } catch (err) {
            console.warn("Failed to load preview secrets for app", { appName, err });
            return [appName, [] as string[]] as const;
          }
        }),
      );
      if (cancelled) return;
      const keyMap = new Map(entries);
      loadedSecretKeys.current = keyMap;
      setDraft((current) => {
        const next: TopologyDraft = {
          ...current,
          apps: current.apps.map((app) => {
            if (app.repoKey !== PRIMARY_REPO_KEY) return app;
            // Merge in existing secret keys (if any) and keep the merged list sorted.
            const keys = keyMap.get(app.name.trim()) ?? [];
            return { ...app, env: withSecretRows(app.env, keys) };
          }),
        };
        baselineDraft.current = structuredClone(next);
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
    // Load once for this application.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  const compiled = documentsFromDraft(draft);
  const issues = validatePrimaryDocument(compiled.primary);
  const hasUntouchedStarterApps = draft.apps.some(isUntouchedStarterApp);
  const hasBlockingIssues = issues.fieldErrors.size > 0 || issues.documentErrors.length > 0 || hasUntouchedStarterApps;
  const secretsDirty = draft.apps.some((app) => {
    if (app.repoKey !== PRIMARY_REPO_KEY) return false;
    const diff = diffAppSecrets(app.env, loadedSecretKeys.current.get(app.name.trim()) ?? []);
    return diff.upserts.length > 0 || diff.deletes.length > 0;
  });
  const isDirty = snapshotDocument(compiled.primary.document) !== savedSnapshot || secretsDirty;
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
    const secrets = draft.apps
      .filter((app) => app.repoKey === PRIMARY_REPO_KEY && app.name.trim().length >= 2)
      .map((app) => {
        const diff = diffAppSecrets(app.env, loadedSecretKeys.current.get(app.name.trim()) ?? []);
        return { appName: app.name.trim(), upserts: diff.upserts, deletes: diff.deletes };
      })
      .filter((entry) => entry.upserts.length > 0 || entry.deletes.length > 0);

    saveConfig.mutate(
      {
        applicationId: appId,
        document: previewConfigSchema.parse(primaryDocument),
        secrets: secrets.length > 0 ? secrets : undefined,
      },
      {
        onSuccess: () => {
          setSavedSnapshot(snapshotDocument(primaryDocument));
          // Reflect the now-persisted secrets: clear typed values and mark rows
          // as existing (masked) secrets so a re-save won't re-upload them.
          setDraft((current) => {
            const next: TopologyDraft = {
              ...current,
              apps: current.apps.map((app) => ({
                ...app,
                env: app.env.map((row) =>
                  row.sensitive && row.key.trim() !== "" ? { ...row, value: "", origin: "secret" as const } : row,
                ),
              })),
            };
            const keyMap = new Map<string, string[]>();
            for (const app of next.apps) {
              if (app.repoKey !== PRIMARY_REPO_KEY) continue;
              keyMap.set(
                app.name.trim(),
                app.env.filter((row) => row.sensitive && row.key.trim() !== "").map((row) => row.key.trim()),
              );
            }
            loadedSecretKeys.current = keyMap;
            baselineDraft.current = structuredClone(next);
            return next;
          });
          toastManager.add({ type: "success", title: "PreviewKit config saved" });
        },
      },
    );
  }

  function handleCancel() {
    if (baselineDraft.current != null) setDraft(structuredClone(baselineDraft.current));
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
              enableSecrets
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
          variant="ghost"
          onClick={handleCancel}
          disabled={!isDirty || saveConfig.isPending}
          aria-label="preview-config-cancel"
        >
          Cancel
        </Button>
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
