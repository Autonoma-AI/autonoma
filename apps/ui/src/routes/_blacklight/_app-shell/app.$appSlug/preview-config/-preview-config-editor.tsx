import { Badge, Button } from "@autonoma/blacklight";
import { previewConfigSchema, validatePreviewConfigSemantics, zodIssuesToConfigIssues } from "@autonoma/types";
import { FloppyDiskIcon } from "@phosphor-icons/react/FloppyDisk";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { useQueryClient } from "@tanstack/react-query";
import { usePreviewkitConfig, useSavePreviewkitConfig } from "lib/onboarding/onboarding-api";
import { useApplicationRepositoryFromGitHub } from "lib/query/github.queries";
import { toastManager } from "lib/toast-manager";
import { trpc } from "lib/trpc";
import { useEffect, useRef, useState } from "react";
// Reuse the onboarding PreviewKit editor building blocks. These are
// route-excluded ("-") modules, so importing them from the settings subtree is
// a normal cross-module import - it keeps one source of truth for the topology
// draft model, the app/service cards, and the multirepo topology section.
import { AppCard } from "../../../onboarding/-components/previewkit/app-card";
import { HooksSection } from "../../../onboarding/-components/previewkit/hooks-section";
import { MultirepoSection } from "../../../onboarding/-components/previewkit/multirepo-section";
import { ServicesSection } from "../../../onboarding/-components/previewkit/services-section";
import {
  PRIMARY_REPO_KEY,
  type AppDraft,
  type CompiledDocument,
  type DraftIssues,
  type RepoDraft,
  type TopologyDraft,
  diffAppSecrets,
  documentsFromDraft,
  draftFromConfig,
  emptyAppDraft,
  emptyDraftIssues,
  hookFieldErrors,
  isUntouchedStarterApp,
  mapIssuesToDraft,
  pruneDanglingDependsOn,
  serviceRecipeSupportsUrlToken,
  snapshotDocument,
  withSecretRows,
} from "../../../onboarding/-components/previewkit/topology-draft";

/**
 * Persistent (post-onboarding) editor for an application's active PreviewKit
 * config, reachable from Settings -> Preview. It edits the full topology: the
 * primary repo's apps, managed services, and the dependency-repo topology
 * (aliases, fallback branch, branch convention) - the same model the onboarding
 * builder uses. Saving writes a new revision for this application; dependency
 * configs ride along on that revision via `dependencyDocuments`.
 */
export function PreviewConfigEditor({ appId }: { appId: string }) {
  const configQuery = usePreviewkitConfig(appId);
  const repositoryQuery = useApplicationRepositoryFromGitHub(appId);
  const saveConfig = useSavePreviewkitConfig();
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState<TopologyDraft>(() =>
    draftFromConfig(
      configQuery.data.document,
      configQuery.data.dependencyConfigs,
      configQuery.data.saved ? "saved" : "starter",
    ),
  );
  const [savedSnapshots, setSavedSnapshots] = useState<Record<string, string>>(() =>
    snapshotCompiled(documentsFromDraft(draft)),
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
  // Names a hook may target: declared (non-starter) apps. Hooks reference apps only.
  const hookAppNames = draft.apps
    .filter((app) => !isUntouchedStarterApp(app))
    .map((app) => app.name)
    .filter((name) => name.trim() !== "");
  const hookErrors = hookFieldErrors(draft.hooks, hookAppNames);
  const hasBlockingIssues =
    issues.fieldErrors.size > 0 || issues.documentErrors.length > 0 || hasUntouchedStarterApps || hookErrors.size > 0;
  const secretsDirty = draft.apps.some((app) => {
    if (app.repoKey !== PRIMARY_REPO_KEY) return false;
    const diff = diffAppSecrets(app.env, loadedSecretKeys.current.get(app.name.trim()) ?? []);
    return diff.upserts.length > 0 || diff.deletes.length > 0;
  });
  const isDirty = !sameSnapshots(snapshotCompiled(compiled), savedSnapshots) || secretsDirty;
  const canSave = isDirty && !hasBlockingIssues && !saveConfig.isPending;

  const repoGroups: Array<{ key: string; label: string; badge: string }> = [
    { key: PRIMARY_REPO_KEY, label: repositoryQuery.data?.fullName ?? "Primary repo", badge: "primary" },
    ...draft.repos.map((repo) => ({ key: repo.name, label: repo.repo, badge: "dependency" })),
  ];
  const appCountByRepoKey = new Map(
    draft.repos.map((repo) => [repo.name, draft.apps.filter((app) => app.repoKey === repo.name).length]),
  );

  const deployableApps = draft.apps.filter((app) => !isUntouchedStarterApp(app));
  const allNames = [...deployableApps.map((app) => app.name), ...draft.services.map((service) => service.name)];
  const referenceTokens = [
    ...draft.services.flatMap((service) => {
      if (service.name.trim() === "") return [];
      const hostPort = [`{{${service.name}.host}}`, `{{${service.name}.port}}`];
      return serviceRecipeSupportsUrlToken(service.recipe) ? [`{{${service.name}.url}}`, ...hostPort] : hostPort;
    }),
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

  function addApp(repoKey: string) {
    setDraft((current) => ({ ...current, apps: [...current.apps, emptyAppDraft(repoKey)] }));
  }

  function removeApp(id: number) {
    setDraft((current) => pruneDanglingDependsOn({ ...current, apps: current.apps.filter((app) => app.id !== id) }));
  }

  function handleReposChange(repos: RepoDraft[]) {
    setDraft((current) => {
      const oldNameById = new Map(current.repos.map((repo) => [repo.id, repo.name]));
      const renameByOldName = new Map<string, string>();
      for (const repo of repos) {
        const oldName = oldNameById.get(repo.id);
        if (oldName != null && oldName !== repo.name) renameByOldName.set(oldName, repo.name);
      }
      const validKeys = new Set([PRIMARY_REPO_KEY, ...repos.map((repo) => repo.name)]);
      const apps = current.apps
        .map((app) => {
          const renamed = renameByOldName.get(app.repoKey);
          return renamed != null ? { ...app, repoKey: renamed } : app;
        })
        .filter((app) => validKeys.has(app.repoKey));
      return pruneDanglingDependsOn({ ...current, repos, apps });
    });
  }

  function handleSave() {
    if (!canSave) return;
    const submission = documentsFromDraft(draft);
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
        document: previewConfigSchema.parse(submission.primary.document),
        dependencyDocuments: submission.dependencies.map((dependency) => ({
          repo: dependency.repo,
          document: previewConfigSchema.parse(dependency.document),
        })),
        secrets: secrets.length > 0 ? secrets : undefined,
      },
      {
        onSuccess: () => {
          setSavedSnapshots(snapshotCompiled(submission));
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
    <div className="flex max-w-4xl flex-col gap-6">
      <MultirepoSection
        repos={draft.repos}
        branchConvention={draft.branchConvention}
        primaryRepoFullName={repositoryQuery.data?.fullName}
        appCountByRepoKey={appCountByRepoKey}
        onReposChange={handleReposChange}
        onBranchConventionChange={(branchConvention) => setDraft((current) => ({ ...current, branchConvention }))}
      />

      <div className="space-y-6">
        {repoGroups.map((group) => {
          const groupApps = draft.apps.filter((app) => app.repoKey === group.key);
          return (
            <section key={group.key} className="border border-border-dim bg-surface-base">
              <div className="flex flex-wrap items-center gap-3 border-b border-border-dim bg-surface-raised px-5 py-4">
                <h2
                  className="truncate font-mono text-sm font-bold uppercase tracking-widest text-text-primary"
                  title={group.label}
                >
                  {group.label}
                </h2>
                <Badge variant="outline">{group.badge}</Badge>
                <Button variant="outline" size="xs" className="ml-auto gap-1" onClick={() => addApp(group.key)}>
                  <PlusIcon size={12} weight="bold" />
                  Add app
                </Button>
              </div>
              <div className="space-y-4 p-5">
                {groupApps.length === 0 ? (
                  <p className="text-sm text-text-secondary">
                    No apps mapped to this repo yet. Add one to get started.
                  </p>
                ) : (
                  groupApps.map((app) => (
                    <AppCard
                      key={app.id}
                      app={app}
                      issues={issues}
                      dependencyOptions={allNames.filter((name) => name.trim() !== "" && name !== app.name)}
                      referenceTokens={referenceTokens}
                      enableSecrets={group.key === PRIMARY_REPO_KEY}
                      onChange={updateApp}
                      onSetPrimary={setPrimaryApp}
                      onRemove={removeApp}
                    />
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>

      <ServicesSection
        services={draft.services}
        onChange={(services) => setDraft((current) => ({ ...current, services }))}
      />

      <HooksSection
        hooks={draft.hooks}
        appNames={hookAppNames}
        errors={hookErrors}
        onChange={(hooks) => setDraft((current) => ({ ...current, hooks }))}
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

      <div className="flex items-center justify-end gap-3 border-t border-border-dim pt-4">
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

/** Snapshot every compiled document (primary + each dependency) keyed by repo, for dirty tracking. */
function snapshotCompiled(compiled: ReturnType<typeof documentsFromDraft>): Record<string, string> {
  const snapshots: Record<string, string> = { [PRIMARY_REPO_KEY]: snapshotDocument(compiled.primary.document) };
  for (const dependency of compiled.dependencies) {
    snapshots[dependency.alias] = snapshotDocument(dependency.document);
  }
  return snapshots;
}

function sameSnapshots(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}

/**
 * Client-side validation for the primary document: schema shape + semantic checks
 * (depends_on, primary), mapped back onto draft fields via the compile-time index
 * map. Hook issues are excluded here - the HooksSection renders them inline per
 * row from `hookFieldErrors`, so routing them to the document banner too would
 * double-report. Dependency documents are validated server-side on save.
 */
function validatePrimaryDocument(primary: CompiledDocument): DraftIssues {
  const result = emptyDraftIssues();
  const parsed = previewConfigSchema.safeParse(primary.document);
  if (!parsed.success) {
    mapIssuesToDraft(zodIssuesToConfigIssues(parsed.error), primary.indexToDraftId, result);
    return result;
  }
  const semanticIssues = validatePreviewConfigSemantics(parsed.data).filter((issue) => issue.path[0] !== "hooks");
  mapIssuesToDraft(semanticIssues, primary.indexToDraftId, result);
  return result;
}
