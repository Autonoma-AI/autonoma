import { AppNameSchema, authoringPreviewConfigSchema, connectionTargets } from "@autonoma/types";
import { useQueryClient } from "@tanstack/react-query";
import {
  useDeletePreviewkitSecret,
  usePreviewkitConfig,
  useSavePreviewkitConfig,
  useUpsertPreviewkitSecrets,
} from "lib/onboarding/onboarding-api";
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
  validateDraftClientSide,
  draftFromConfig,
  draftWithRepos,
  emptyAppDraft,
  hookFieldErrors,
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
  /**
   * The pending changes are secrets and nothing else, so the save writes the
   * secret bundles alone and leaves the config document as it is. Config validation
   * doesn't gate it, and the bar says "secrets" rather than "config".
   */
  secretsOnly: boolean;
  updateApp: (id: number, patch: Partial<AppDraft>) => void;
  setPrimaryApp: (id: number) => void;
  setSdkApp: (id: number) => void;
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
 * A draft holding secret changes ALONE takes a narrower path instead: the secret
 * bundles are written directly and the document is left alone, so a secret stays
 * editable while the config document is unsaveable.
 */
export function PreviewDraftProvider({ appId, children }: { appId: string; children: ReactNode }) {
  const configQuery = usePreviewkitConfig(appId);
  const repositoryQuery = useApplicationRepositoryFromGitHub(appId);
  const saveConfig = useSavePreviewkitConfig();
  const upsertSecrets = useUpsertPreviewkitSecrets();
  const deleteSecret = useDeletePreviewkitSecret();
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

  // Secret keys each app loaded with, so a save can diff upserts/deletes. Keyed by
  // app name alone across every repo of the topology: names are unique across the
  // merged topology (the save rejects a collision) and a secret bundle is stored per
  // (application, app name), so a dependency-repo app needs no separate namespace.
  // Values are never fetched (the store is write-only) - only key names, shown masked.
  const loadedSecretKeys = useRef<Map<string, string[]>>(new Map());
  // Snapshot of the draft to revert to on Cancel; refreshed on load and on save.
  const baselineDraft = useRef<TopologyDraft | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Every app of the topology, dependency repos included: a dependency app owns
      // a secret bundle under this same application, so skipping it showed a
      // multirepo backend as having no secrets at all while its values were set.
      // Names the API cannot address a bundle by are skipped, the same way the
      // save skips them, so loading and saving agree on which apps have one.
      const apps = draft.apps.filter((app) => AppNameSchema.safeParse(app.name.trim()).success);
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
          // Merge in existing secret keys (if any) and keep the merged list sorted.
          const appName = app.name.trim();
          const keys = storedKeys.get(appName) ?? [];
          const env = withSecretRows(app.env, keys);
          // Track only the stored keys that ended up represented by a sensitive
          // row. A stored secret shadowed by a plaintext config row is skipped
          // by the merge - counting it would report a phantom "delete" (dirty
          // on load) and a save would then silently drop the stored secret.
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
  const issues = validateDraftClientSide(compiled);
  // Names a hook may target: any app with a name. Hooks reference apps only.
  const hookAppNames = draft.apps.map((app) => app.name).filter((name) => name.trim() !== "");
  const hookErrors = hookFieldErrors(draft.hooks, hookAppNames);
  const hasBlockingIssues = issues.fieldErrors.size > 0 || issues.documentErrors.length > 0 || hookErrors.size > 0;
  const secretChanges = pendingSecretChanges(draft, loadedSecretKeys.current);
  const configDirty = !sameSnapshots(snapshotCompiled(compiled), savedSnapshots);
  const isDirty = configDirty || secretChanges.length > 0;
  // Secrets live in their own store, not in the config document, so a secrets-only save
  // writes them directly and never submits the document - config problems
  // elsewhere (a legacy build block, another app's bad field) cannot block it.
  const secretsOnly = !configDirty && secretChanges.length > 0;
  const isSaving = saveConfig.isPending || upsertSecrets.isPending || deleteSecret.isPending;
  const canSave = isDirty && !isSaving && (secretsOnly || !hasBlockingIssues);

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

  // The SDK host is exclusive like the frontend, but a single app can hold both
  // roles (a full-stack app serves the handler it is tested through).
  function setSdkApp(id: number) {
    setDraft((current) => ({
      ...current,
      apps: current.apps.map((app) => ({
        ...app,
        sdkImplemented: app.id === id ? !app.sdkImplemented : false,
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
      const next = draftWithRepos(current, repos);
      // Dropping a dependency repo drops its apps - and with them any hook, in any
      // document, that targeted one of those apps by name.
      return pruneDanglingDependsOn({ ...next, hooks: pruneHooksToApps(next.hooks, next.apps) });
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
    if (secretsOnly) {
      void saveSecrets();
      return;
    }

    const submission = documentsFromDraft(draft);
    saveConfig.mutate(
      {
        applicationId: appId,
        document: authoringPreviewConfigSchema.parse(submission.primary.document),
        dependencyDocuments: submission.dependencies.map((dependency) => ({
          repo: dependency.repo,
          document: authoringPreviewConfigSchema.parse(dependency.document),
        })),
        secrets: secretChanges.length > 0 ? secretChanges : undefined,
      },
      {
        onSuccess: () => {
          setSavedSnapshots(snapshotCompiled(submission));
          // What was submitted is now what is saved, so Cancel reverts to here.
          // Each adopt below refines this with its cleared secret values.
          baselineDraft.current = structuredClone(draft);
          // The config save carried the secrets too, so every change in it landed.
          for (const change of secretChanges) {
            adoptSecretWrites(
              change.appName,
              change.upserts.map((item) => item.key),
              change.deletes,
            );
          }
          toastManager.add({ type: "success", title: "Preview config saved" });
        },
      },
    );
  }

  /**
   * Persists the secret changes on their own, straight to the secret bundles. The
   * config document is untouched and never submitted, so this path stays open
   * while the document is unsaveable (an app on a retired build preset, say) -
   * a secret is not the thing that is wrong, so fixing it should not be gated.
   *
   * Apps run concurrently, but each app's upserts land before its deletes: both
   * rewrite the one bundle for that app, and a rename arrives as upsert-new
   * + delete-old. One app failing must not discard what the others already
   * wrote, so nothing is awaited as a group - see `writeAppSecrets`.
   */
  async function saveSecrets() {
    const outcomes = await Promise.allSettled(secretChanges.map((change) => writeAppSecrets(change)));
    const failed = outcomes.filter((outcome) => outcome.status === "rejected");
    if (failed.length > 0) {
      // Each mutation raises its own error toast. Whatever landed has already
      // been adopted, so the draft now holds exactly the writes still to make
      // and pressing save again retries those alone.
      console.warn("Failed to save some preview secrets", { appId, failed: failed.length });
      return;
    }
    toastManager.add({ type: "success", title: "Preview secrets saved" });
  }

  /**
   * Writes one app's bundle, adopting each write as it lands rather than at the
   * end. A half-applied app (its upsert stored, a delete still to go) therefore
   * leaves only the unapplied part pending: a retry never repeats a delete that
   * already happened, which the API answers with a 404 and would otherwise wedge
   * the save.
   */
  async function writeAppSecrets(change: AppSecretChanges) {
    if (change.upserts.length > 0) {
      await upsertSecrets.mutateAsync({ applicationId: appId, appName: change.appName, items: change.upserts });
      adoptSecretWrites(
        change.appName,
        change.upserts.map((item) => item.key),
        [],
      );
    }
    for (const key of change.deletes) {
      await deleteSecret.mutateAsync({ applicationId: appId, appName: change.appName, key });
      adoptSecretWrites(change.appName, [], [key]);
    }
  }

  /**
   * Records what the store now holds for one app: `stored` keys are the ones just
   * written (their typed value is cleared and the row becomes a masked, stored
   * secret) and `removed` keys are gone from the bundle. Both move the baseline
   * the dirty check diffs against, so an adopted write stops counting as pending
   * and Cancel reverts to this state rather than to page load.
   */
  function adoptSecretWrites(appName: string, stored: string[], removed: string[]) {
    const storedKeys = new Set(stored);
    const removedKeys = new Set(removed);
    setDraft((current) => {
      const next: TopologyDraft = {
        ...current,
        apps: current.apps.map((app) => {
          if (app.name.trim() !== appName) return app;
          return {
            ...app,
            env: app.env.map((row) =>
              storedKeys.has(row.key.trim()) ? { ...row, value: "", origin: "secret" as const } : row,
            ),
          };
        }),
      };
      const loaded = new Set(loadedSecretKeys.current.get(appName) ?? []);
      for (const key of storedKeys) loaded.add(key);
      for (const key of removedKeys) loaded.delete(key);
      loadedSecretKeys.current = new Map(loadedSecretKeys.current).set(appName, [...loaded]);
      baselineDraft.current = structuredClone(next);
      return next;
    });
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
    isSaving,
    secretsOnly,
    updateApp,
    setPrimaryApp,
    setSdkApp,
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

interface AppSecretChanges {
  appName: string;
  upserts: Array<{ key: string; value: string }>;
  deletes: string[];
}

/**
 * The secret writes the draft is holding, per app - one entry per app with
 * something to persist. The single source for both "are secrets dirty?" and
 * what a save submits, so the bar can never offer a save that writes nothing.
 *
 * Apps whose name cannot address a secret bundle are skipped - the same check
 * the API applies to the appName it is given, so the editor never offers a
 * secret it has nowhere to store. Such an app has no bundle to load from
 * either, so nothing was ever shown for it.
 */
function pendingSecretChanges(draft: TopologyDraft, loadedKeys: Map<string, string[]>): AppSecretChanges[] {
  return draft.apps
    .filter((app) => AppNameSchema.safeParse(app.name.trim()).success)
    .map((app) => {
      const appName = app.name.trim();
      const diff = diffAppSecrets(app.env, loadedKeys.get(appName) ?? []);
      return { appName, upserts: diff.upserts, deletes: diff.deletes };
    })
    .filter((change) => change.upserts.length > 0 || change.deletes.length > 0);
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
