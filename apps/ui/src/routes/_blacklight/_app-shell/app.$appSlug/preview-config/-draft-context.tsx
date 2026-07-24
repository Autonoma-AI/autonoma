import {
  connectionTargets,
  authoringPreviewConfigSchema,
  validatePreviewConfigSemantics,
  zodIssuesToConfigIssues,
} from "@autonoma/types";
import { useQueryClient } from "@tanstack/react-query";
import { usePreviewkitConfig, useSavePreviewkitConfig } from "lib/onboarding/onboarding-api";
import { useApplicationRepositoryFromGitHub } from "lib/query/github.queries";
import { toastManager } from "lib/toast-manager";
import { trpc } from "lib/trpc";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  PRIMARY_REPO_KEY,
  type AppDraft,
  type BranchConventionDraft,
  type CompiledDocument,
  type DraftIssues,
  type EnvRowDraft,
  type HookDraft,
  type HooksDraft,
  type RepoDraft,
  type ServiceDraft,
  type ServiceRecipe,
  type TopologyDraft,
  diffAppSecrets,
  documentsFromDraft,
  draftFromConfig,
  emptyAppDraft,
  emptyDraftIssues,
  hookFieldErrors,
  mapIssuesToDraft,
  pruneDanglingDependsOn,
  serviceDraftForRecipe,
  serviceRecipeSupportsUrlToken,
  snapshotDocument,
  withSecretRows,
} from "../../../onboarding/-components/previewkit/topology-draft";

export interface RepoGroup {
  key: string;
  label: string;
  badge: string;
}

interface PreviewDraftValue {
  appId: string;
  draft: TopologyDraft;
  setDraft: Dispatch<SetStateAction<TopologyDraft>>;
  issues: DraftIssues;
  /** Per-hook validation messages keyed `${hookId}:${"app" | "command"}`. */
  hookErrors: Map<string, string[]>;
  repoGroups: RepoGroup[];
  appCountByRepoKey: Map<string, number>;
  primaryRepoFullName?: string;
  /** `{{name.field}}` tokens offered wherever values can reference services/apps. */
  referenceTokens: string[];
  /** Every app and service name, for depends-on pickers. */
  allNames: string[];
  /** Every app - all apps are real, deployable apps. */
  deployableApps: AppDraft[];
  isDirty: boolean;
  canSave: boolean;
  isSaving: boolean;
  updateApp: (id: number, patch: Partial<AppDraft>) => void;
  setPrimaryApp: (id: number) => void;
  /** Appends an empty app to the repo and returns its draft id, so callers can select it. */
  addApp: (repoKey: string) => number;
  /** Registers a new dependency repo, seeds its first app, and returns the app's draft id. */
  addAppFromNewRepo: (repo: RepoDraft) => number;
  removeApp: (id: number) => void;
  setRepos: (repos: RepoDraft[]) => void;
  setBranchConvention: (convention: BranchConventionDraft) => void;
  /** Attaches a service from the recipe catalog and returns its draft id, so callers can select it. */
  addService: (recipe: ServiceRecipe) => number;
  /** Detaches a service and removes every app variable bound to it (plus dangling depends_on). */
  removeService: (id: number) => void;
  setServices: (services: ServiceDraft[]) => void;
  setHooks: (hooks: HooksDraft) => void;
  save: () => void;
  cancel: () => void;
}

const PreviewDraftContext = createContext<PreviewDraftValue | undefined>(undefined);

export function usePreviewDraft(): PreviewDraftValue {
  const value = useContext(PreviewDraftContext);
  if (value == null) throw new Error("usePreviewDraft must be used inside PreviewDraftProvider");
  return value;
}

/**
 * Holds the persistent (post-onboarding) editing state for an application's
 * active PreviewKit config: the full topology draft (primary repo apps, managed
 * services, hooks, dependency-repo topology) plus the per-app secret key sets.
 * The Apps / Secrets / Services settings sections all read and write this one
 * draft, and the shared save bar persists it as a single new config revision
 * (dependency configs and secret upserts/deletes ride along on that save).
 */
export function PreviewDraftProvider({ appId, children }: { appId: string; children: ReactNode }) {
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
      const storedKeys = new Map(entries);
      setDraft((current) => {
        const representedKeys = new Map<string, string[]>();
        const apps = current.apps.map((app) => {
          if (app.repoKey !== PRIMARY_REPO_KEY) return app;
          // Merge in existing secret keys (if any) and keep the merged list sorted.
          const appName = app.name.trim();
          const keys = storedKeys.get(appName) ?? [];
          const env = withSecretRows(app.env, keys);
          // Track only the stored keys that ended up represented by a sensitive
          // row. A stored secret shadowed by a plaintext config row is skipped
          // by the merge - counting it would report a phantom "delete" (dirty
          // on load) and a save would then silently drop the secret from AWS.
          const sensitiveKeys = new Set(env.filter((row) => row.sensitive).map((row) => row.key.trim()));
          representedKeys.set(
            appName,
            keys.filter((key) => sensitiveKeys.has(key)),
          );
          return { ...app, env };
        });
        const next: TopologyDraft = { ...current, apps };
        loadedSecretKeys.current = representedKeys;
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
  // Names a hook may target: any app with a name. Hooks reference apps only.
  const hookAppNames = draft.apps.map((app) => app.name).filter((name) => name.trim() !== "");
  const hookErrors = hookFieldErrors(draft.hooks, hookAppNames);
  const hasBlockingIssues = issues.fieldErrors.size > 0 || issues.documentErrors.length > 0 || hookErrors.size > 0;
  const secretsDirty = draft.apps.some((app) => {
    if (app.repoKey !== PRIMARY_REPO_KEY) return false;
    const diff = diffAppSecrets(app.env, loadedSecretKeys.current.get(app.name.trim()) ?? []);
    return diff.upserts.length > 0 || diff.deletes.length > 0;
  });
  const isDirty = !sameSnapshots(snapshotCompiled(compiled), savedSnapshots) || secretsDirty;
  const canSave = isDirty && !hasBlockingIssues && !saveConfig.isPending;

  const repoGroups: RepoGroup[] = [
    { key: PRIMARY_REPO_KEY, label: repositoryQuery.data?.fullName ?? "Primary repo", badge: "primary" },
    ...draft.repos.map((repo) => ({ key: repo.name, label: repo.repo, badge: "dependency" })),
  ];
  const appCountByRepoKey = new Map(
    draft.repos.map((repo) => [repo.name, draft.apps.filter((app) => app.repoKey === repo.name).length]),
  );

  // Every app is a real, deployable app now (starter apps are seeded complete).
  const deployableApps = draft.apps;
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
    setDraft((current) => {
      const target = current.apps.find((app) => app.id === id);
      const apps = current.apps.map((app) =>
        app.id === id ? { ...app, ...patch, origin: patch.origin ?? app.origin } : app,
      );
      const next: TopologyDraft = { ...current, apps };

      // Hooks target apps by name, so they follow the app through a rename -
      // unless another app still carries the old name (transient duplicate).
      const oldName = target?.name.trim() ?? "";
      const newName = patch.name?.trim();
      if (target == null || newName == null || newName === oldName || oldName === "") return next;
      const otherKeepsOldName = apps.some((app) => app.id !== id && app.name.trim() === oldName);
      if (otherKeepsOldName) return next;
      return { ...next, hooks: renameHookTargets(next.hooks, oldName, newName) };
    });
  }

  function setPrimaryApp(id: number) {
    setDraft((current) => ({
      ...current,
      apps: current.apps.map((app) => ({
        ...app,
        primary: app.id === id ? !app.primary : false,
      })),
    }));
  }

  function addApp(repoKey: string): number {
    const app = emptyAppDraft(repoKey);
    setDraft((current) => ({ ...current, apps: [...current.apps, app] }));
    return app.id;
  }

  // A dependency repo exists only to host apps, so registering it and seeding its
  // first app is one action - mirrors the onboarding add-app flow.
  function addAppFromNewRepo(repo: RepoDraft): number {
    const app = emptyAppDraft(repo.name);
    setDraft((current) => ({ ...current, repos: [...current.repos, repo], apps: [...current.apps, app] }));
    return app.id;
  }

  function removeApp(id: number) {
    setDraft((current) => {
      const apps = current.apps.filter((app) => app.id !== id);
      return pruneDanglingDependsOn({ ...current, apps, hooks: pruneHooksToApps(current.hooks, apps) });
    });
  }

  function setRepos(repos: RepoDraft[]) {
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
      // Dropping a dependency repo drops its apps - and with them their hooks.
      return pruneDanglingDependsOn({ ...current, repos, apps, hooks: pruneHooksToApps(current.hooks, apps) });
    });
  }

  function setBranchConvention(branchConvention: BranchConventionDraft) {
    setDraft((current) => ({ ...current, branchConvention }));
  }

  function addService(recipe: ServiceRecipe): number {
    const service = serviceDraftForRecipe(
      recipe,
      draft.services.map((candidate) => candidate.name),
    );
    setDraft((current) => ({ ...current, services: [...current.services, service] }));
    return service.id;
  }

  function removeService(id: number) {
    setDraft((current) => {
      const service = current.services.find((candidate) => candidate.id === id);
      const name = service?.name.trim() ?? "";
      const services = current.services.filter((candidate) => candidate.id !== id);
      const apps = name === "" ? current.apps : current.apps.map((app) => withoutServiceBindings(app, name));
      return pruneDanglingDependsOn({ ...current, services, apps });
    });
  }

  function setServices(services: ServiceDraft[]) {
    setDraft((current) => ({ ...current, services }));
  }

  function setHooks(hooks: HooksDraft) {
    setDraft((current) => ({ ...current, hooks }));
  }

  function save() {
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
        document: authoringPreviewConfigSchema.parse(submission.primary.document),
        dependencyDocuments: submission.dependencies.map((dependency) => ({
          repo: dependency.repo,
          document: authoringPreviewConfigSchema.parse(dependency.document),
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
          toastManager.add({ type: "success", title: "Preview config saved" });
        },
      },
    );
  }

  function cancel() {
    if (baselineDraft.current != null) setDraft(structuredClone(baselineDraft.current));
  }

  const value: PreviewDraftValue = {
    appId,
    draft,
    setDraft,
    issues,
    hookErrors,
    repoGroups,
    appCountByRepoKey,
    primaryRepoFullName: repositoryQuery.data?.fullName,
    referenceTokens,
    allNames,
    deployableApps,
    isDirty,
    canSave,
    isSaving: saveConfig.isPending,
    updateApp,
    setPrimaryApp,
    addApp,
    addAppFromNewRepo,
    removeApp,
    setRepos,
    setBranchConvention,
    addService,
    removeService,
    setServices,
    setHooks,
    save,
    cancel,
  };

  return <PreviewDraftContext.Provider value={value}>{children}</PreviewDraftContext.Provider>;
}

/** Rewrites hook rows targeting `oldName` to follow the app's rename to `newName`. */
function renameHookTargets(hooks: HooksDraft, oldName: string, newName: string): HooksDraft {
  const rename = (steps: HookDraft[]) =>
    steps.map((step) => (step.app.trim() === oldName ? { ...step, app: newName } : step));
  return { pre_deploy: rename(hooks.pre_deploy), post_deploy: rename(hooks.post_deploy) };
}

/**
 * Drops hook rows whose target app no longer exists among `apps`. Hooks live in
 * each app's Hooks tab, so a row surviving its app would be uneditable (and
 * would invisibly block saving on the unknown-app validation).
 */
function pruneHooksToApps(hooks: HooksDraft, apps: AppDraft[]): HooksDraft {
  const names = new Set(apps.map((app) => app.name.trim()));
  const prune = (steps: HookDraft[]) => steps.filter((step) => step.app.trim() === "" || names.has(step.app.trim()));
  return { pre_deploy: prune(hooks.pre_deploy), post_deploy: prune(hooks.post_deploy) };
}

/**
 * Drops every connection of `app` bound to `serviceName` (detaching a service
 * removes its bindings from the apps). Secret rows never hold bindings, so they
 * are untouched.
 */
function withoutServiceBindings(app: AppDraft, serviceName: string): AppDraft {
  const references = (row: EnvRowDraft) => !row.sensitive && connectionTargets(row.value).includes(serviceName);
  if (!app.env.some(references)) return app;
  return {
    ...app,
    env: app.env.filter((row) => !references(row)),
  };
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
  const parsed = authoringPreviewConfigSchema.safeParse(primary.document);
  if (!parsed.success) {
    mapIssuesToDraft(zodIssuesToConfigIssues(parsed.error), primary.indexToDraftId, result);
    return result;
  }
  const semanticIssues = validatePreviewConfigSemantics(parsed.data).filter((issue) => issue.path[0] !== "hooks");
  mapIssuesToDraft(semanticIssues, primary.indexToDraftId, result);
  return result;
}
