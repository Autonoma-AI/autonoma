import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Skeleton,
  cn,
} from "@autonoma/blacklight";
import {
  previewConfigSchema,
  validatePreviewConfigSemantics,
  zodIssuesToConfigIssues,
  type ConfigIssue,
} from "@autonoma/types";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CodeIcon } from "@phosphor-icons/react/Code";
import { CubeIcon } from "@phosphor-icons/react/Cube";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { RocketLaunchIcon } from "@phosphor-icons/react/RocketLaunch";
import { TerminalWindowIcon } from "@phosphor-icons/react/TerminalWindow";
import { useQueryClient } from "@tanstack/react-query";
import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import { type ConfigStepId } from "lib/onboarding/config-steps";
import {
  usePreviewkitConfig,
  useSavePreviewkitConfig,
  useTriggerPreviewkitMainDeploy,
  useValidatePreviewkitConfig,
} from "lib/onboarding/onboarding-api";
import { buildOnboardingSearch } from "lib/onboarding/onboarding-search";
import { useApplicationRepositoryFromGitHub } from "lib/query/github.queries";
import { trpc } from "lib/trpc";
import { Suspense, useEffect, useRef, useState } from "react";
import { EnvVarManager } from "../_app-shell/app.$appSlug/preview-config/-variables/env-var-manager";
import { OnboardingPageHeader } from "./-components/onboarding-page-header";
import { AddAppDialog } from "./-components/previewkit/add-app-dialog";
import { AppCard } from "./-components/previewkit/app-card";
import { BranchMatchingField } from "./-components/previewkit/branch-matching-field";
import { DatabaseSection } from "./-components/previewkit/database-section";
import { HooksSection } from "./-components/previewkit/hooks-section";
import { ReviewSection } from "./-components/previewkit/review-section";
import { ServicesSection } from "./-components/previewkit/services-section";
import {
  PRIMARY_REPO_KEY,
  appFieldFromDocumentKey,
  diffAppSecrets,
  documentsFromDraft,
  draftFromConfig,
  emptyAppDraft,
  emptyDraftIssues,
  fieldIssueKey,
  hookFieldErrors,
  repoAliasFrom,
  serviceRecipeIsDatabase,
  uniqueServiceName,
  withSecretRows,
  mapIssuesToDraft,
  pruneDanglingDependsOn,
  snapshotDocument,
  type AppDraft,
  type AppDraftField,
  type DraftIssues,
  type RepoDraft,
  type ServiceDraft,
  type TopologyDraft,
} from "./-components/previewkit/topology-draft";

export const Route = createFileRoute("/_blacklight/onboarding/previewkit-config")({
  component: () => <Navigate to="/onboarding" search={buildOnboardingSearch("previewkit-config")} />,
});

export interface PreviewkitConfigPageProps {
  appId?: string;
  /** Deep-link from deploy diagnostics: scroll to and focus this app's card / field. */
  focusApp?: string;
  focusField?: string;
  focusSection?: "config" | "secrets" | "logs";
  /** Active sub-step, mirrored to the URL so the sidebar reflects it. */
  configStep?: ConfigStepId;
}

type ConfigStepGroup = "required" | "optional";

const CONFIG_STEPS: Array<{ id: ConfigStepId; label: string; description: string; group: ConfigStepGroup }> = [
  { id: "apps", label: "Apps", description: "Deployable apps + dependency repos", group: "required" },
  { id: "database", label: "Database", description: "Engines + guided setup tasks", group: "required" },
  { id: "variables", label: "Variables", description: "Secrets + connections per app", group: "required" },
  { id: "review", label: "Review", description: "Confirm + deploy", group: "required" },
  { id: "services", label: "Extra services", description: "Non-database Docker images", group: "optional" },
  { id: "hooks", label: "Lifecycle hooks", description: "Pre/post-deploy commands", group: "optional" },
];

// The linear flow the primary "Continue" button walks. These are the only steps
// that count toward the completion tally; the review step is the terminal deploy
// screen and the optional steps sit off the flow, so neither is tallied.
const FLOW_STEP_IDS: ConfigStepId[] = ["apps", "database", "variables"];

// Where the back button returns for each step. Review and the optional steps all
// fork off the variables step, so they walk back to it.
const PREVIOUS_STEP_BY_ID: Partial<Record<ConfigStepId, ConfigStepId>> = {
  database: "apps",
  variables: "database",
  review: "variables",
  services: "variables",
  hooks: "variables",
};

export function PreviewkitConfigPage({
  appId,
  focusApp,
  focusField,
  focusSection,
  configStep,
}: PreviewkitConfigPageProps) {
  if (appId == null) {
    return <p className="font-mono text-sm text-text-secondary">No application found. Please start from setup.</p>;
  }

  return (
    <Suspense fallback={<PreviewkitConfigSkeleton />}>
      <PreviewkitConfigContent
        appId={appId}
        focusApp={focusApp}
        focusField={focusField}
        focusSection={focusSection}
        configStep={configStep}
      />
    </Suspense>
  );
}

function PreviewkitConfigSkeleton() {
  return (
    <div className="space-y-8">
      <Skeleton className="h-32 w-full" />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(28rem,0.9fr)]">
        <Skeleton className="h-96 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
      <Skeleton className="h-72 w-full" />
    </div>
  );
}

function PreviewkitConfigContent({
  appId,
  focusApp,
  focusField,
  focusSection,
  configStep,
}: { appId: string } & Omit<PreviewkitConfigPageProps, "appId">) {
  const navigate = useNavigate();
  const configQuery = usePreviewkitConfig(appId);
  const repositoryQuery = useApplicationRepositoryFromGitHub(appId);
  const saveConfig = useSavePreviewkitConfig();
  const validateConfig = useValidatePreviewkitConfig();
  const deploy = useTriggerPreviewkitMainDeploy();
  const queryClient = useQueryClient();
  const repoName = repositoryQuery.data?.fullName ?? "your linked repository";
  const loadedSecretKeys = useRef<Map<string, string[]>>(new Map());

  const [draft, setDraftState] = useState<TopologyDraft>(() =>
    draftFromConfig(
      configQuery.data.document,
      configQuery.data.dependencyConfigs,
      configQuery.data.saved ? "saved" : "starter",
    ),
  );
  const [savedSnapshots, setSavedSnapshots] = useState<Record<string, string>>(() =>
    configQuery.data.saved ? draftFromConfigSnapshot(configQuery.data) : {},
  );
  const [serverIssues, setServerIssues] = useState<DraftIssues>(emptyDraftIssues);
  const [activeStep, setActiveStep] = useState<ConfigStepId>(
    () => configStep ?? (focusSection === "secrets" ? "variables" : "apps"),
  );
  const [addAppDialogOpen, setAddAppDialogOpen] = useState(false);
  // The hooks step is optional: it only reads as complete once the user has
  // advanced past it (clicked next/save from the hooks step), even when nothing
  // is configured - never before. A previously saved config counts as advanced.
  const [hooksAcknowledged, setHooksAcknowledged] = useState<boolean>(configQuery.data.saved);
  // Database + extra services follow the same acknowledgement rule: an empty list
  // is a valid config, but the step only reads as complete once the user has
  // advanced past it (or configured one). A previously saved config counts as advanced.
  const [databaseAcknowledged, setDatabaseAcknowledged] = useState<boolean>(configQuery.data.saved);
  const [servicesAcknowledged, setServicesAcknowledged] = useState<boolean>(configQuery.data.saved);
  // Variables is complete-by-default (an app may have none), so - like services -
  // it only reads complete once visited or when the config was already saved.
  const [variablesAcknowledged, setVariablesAcknowledged] = useState<boolean>(configQuery.data.saved);

  function setDraft(updater: (current: TopologyDraft) => TopologyDraft) {
    setDraftState(updater);
    // Server findings (preflight warnings, save rejections) describe the last
    // submitted document - stale the moment the draft changes.
    setServerIssues(emptyDraftIssues());
  }

  // Seed each primary-repo app's existing secrets (key names only) into the draft so the Variables step shows stored secrets as masked "(set)" rows and the save can diff them.
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
          const appName = app.name.trim();
          const keys = storedKeys.get(appName) ?? [];
          const env = withSecretRows(app.env, keys);
          const sensitiveKeys = new Set(env.filter((row) => row.sensitive).map((row) => row.key.trim()));
          representedKeys.set(
            appName,
            keys.filter((key) => sensitiveKeys.has(key)),
          );
          return { ...app, env };
        });
        loadedSecretKeys.current = representedKeys;
        return { ...current, apps };
      });
    })();
    return () => {
      cancelled = true;
    };
    // Load once for this application.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  const compiled = documentsFromDraft(draft);
  const clientIssues = validateDraftClientSide(compiled);
  const issues = mergeIssues(clientIssues, serverIssues);
  // Names a hook may target: any app with a name. Hooks reference apps only.
  const hookAppNames = draft.apps.map((app) => app.name).filter((name) => name.trim() !== "");
  const hookErrors = hookFieldErrors(draft.hooks, hookAppNames);
  const hasBlockingIssues = issues.fieldErrors.size > 0 || issues.documentErrors.length > 0 || hookErrors.size > 0;

  const groupSaved = (repoKey: string): boolean => {
    const document =
      repoKey === PRIMARY_REPO_KEY
        ? compiled.primary.document
        : compiled.dependencies.find((dependency) => dependency.alias === repoKey)?.document;
    if (document == null) return false;
    return savedSnapshots[repoKey] === snapshotDocument(document);
  };
  const allSaved = [PRIMARY_REPO_KEY, ...draft.repos.map((repo) => repo.name)].every(groupSaved);
  const secretsDirty = draft.apps.some((app) => {
    if (app.repoKey !== PRIMARY_REPO_KEY) return false;
    const diff = diffAppSecrets(app.env, loadedSecretKeys.current.get(app.name.trim()) ?? []);
    return diff.upserts.length > 0 || diff.deletes.length > 0;
  });
  const configReadyForSecrets = allSaved && !secretsDirty && !hasBlockingIssues;
  const canDeploy = configReadyForSecrets;
  const stepCompletion = getConfigStepCompletion({
    draft,
    issues,
    hooksValid: hookErrors.size === 0,
    hooksAcknowledged,
    databaseAcknowledged,
    servicesAcknowledged,
    variablesAcknowledged,
  });
  const completedStepCount = FLOW_STEP_IDS.filter((id) => stepCompletion[id]).length;

  useEffect(() => {
    if (focusSection === "secrets") setActiveStep("variables");
    if (focusSection === "config") setActiveStep("apps");
  }, [focusSection]);

  // When the sidebar navigates (the URL's configStep changes), adopt it as the
  // active step. Depends only on configStep so an internal setActiveStep - which
  // the mirror effect below writes back to the URL - doesn't bounce through here.
  useEffect(() => {
    if (configStep != null && configStep !== activeStep) setActiveStep(configStep);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configStep]);

  // Mirror the active sub-step into the URL so the sidebar reflects it (and the
  // step survives a refresh). Held off while a focus deep-link is in flight so
  // its focusApp/focusField params aren't stripped before they're consumed.
  useEffect(() => {
    if (focusApp != null || focusField != null) return;
    if (configStep === activeStep) return;
    void navigate({
      to: "/onboarding",
      replace: true,
      search: buildOnboardingSearch("previewkit-config", appId, { configStep: activeStep }),
    });
  }, [activeStep, configStep, focusApp, focusField, appId, navigate]);

  function clearFocusParams() {
    void navigate({ to: "/onboarding", replace: true, search: buildOnboardingSearch("previewkit-config", appId) });
  }

  function backToPreviewOptions() {
    void navigate({ to: "/onboarding", search: buildOnboardingSearch("preview-environment", appId) });
  }

  const shouldFocusConfig = (focusSection == null || focusSection === "config") && activeStep === "apps";
  useFocusDeepLink(draft, shouldFocusConfig ? focusApp : undefined, focusField, clearFocusParams);

  function updateApp(id: number, patch: Partial<AppDraft>) {
    setDraft((current) => {
      const previousName = current.apps.find((app) => app.id === id)?.name;
      const rename =
        patch.name != null &&
        patch.name !== "" &&
        previousName != null &&
        previousName !== "" &&
        patch.name !== previousName
          ? { from: previousName, to: patch.name }
          : undefined;
      return {
        ...current,
        apps: current.apps.map((app) => {
          if (app.id === id) {
            return { ...app, ...patch, origin: patch.origin ?? app.origin };
          }
          if (rename != null && app.dependsOn.includes(rename.from)) {
            return { ...app, dependsOn: app.dependsOn.map((name) => (name === rename.from ? rename.to : name)) };
          }
          return app;
        }),
      };
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

  // A fresh app's name defaults to its repo: the primary repo's short name for
  // this-repo apps, the alias for a dependency repo - deduped against the names
  // already in use, so a second app from the same repo gets `name-2`.
  function defaultAppName(repoKey: string, current: TopologyDraft): string {
    const base =
      repoKey === PRIMARY_REPO_KEY
        ? repoAliasFrom(repositoryQuery.data?.fullName?.split("/").pop() ?? "app", [])
        : repoKey;
    const taken = [...current.apps.map((app) => app.name), ...current.services.map((service) => service.name)].filter(
      (name) => name.trim() !== "",
    );
    return uniqueServiceName(base, taken);
  }

  function addApp(repoKey: string) {
    setDraft((current) => addApps(current, [{ ...emptyAppDraft(repoKey), name: defaultAppName(repoKey, current) }]));
  }

  // Registering a dependency repo and seeding its first app is one action: the repo
  // exists only to host apps, so it never appears in the config without one.
  function addAppFromNewRepo(repo: RepoDraft) {
    setDraft((current) =>
      addApps({ ...current, repos: [...current.repos, repo] }, [
        { ...emptyAppDraft(repo.name), name: defaultAppName(repo.name, current) },
      ]),
    );
  }

  function updateRepo(id: number, patch: Partial<RepoDraft>) {
    handleReposChange(draft.repos.map((repo) => (repo.id === id ? { ...repo, ...patch } : repo)));
  }

  function removeApp(id: number) {
    setDraft((current) => {
      const removed = current.apps.find((app) => app.id === id);
      const apps = current.apps.filter((app) => app.id !== id);
      // With a single app left, the frontend toggle is hidden - so guarantee that
      // lone app is the frontend, otherwise the topology would have no primary.
      const normalized = apps.length === 1 ? apps.map((app) => ({ ...app, primary: true })) : apps;
      // A dependency repo exists only to host apps; when its last app is removed,
      // drop the repo (and its group/settings) so repos stay in sync with apps.
      const repoEmptied =
        removed != null &&
        removed.repoKey !== PRIMARY_REPO_KEY &&
        !normalized.some((app) => app.repoKey === removed.repoKey);
      const repos = repoEmptied ? current.repos.filter((repo) => repo.name !== removed.repoKey) : current.repos;
      return pruneDanglingDependsOn({ ...current, apps: normalized, repos });
    });
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
      // Removing a repo drops its apps; prune any depends_on that referenced them.
      return pruneDanglingDependsOn({ ...current, repos, apps });
    });
  }

  function save(onSaved?: () => void) {
    if (hasBlockingIssues) return;
    const submission = documentsFromDraft(draft);

    // Repo-aware preflight (path / Dockerfile existence) runs server-side per
    // repo document and returns warnings as data; they render inline but never
    // block the save. Results merge as each repo's check completes. Dependency
    // documents keep only warnings: per-document semantic errors (e.g. a
    // depends_on referencing a primary-repo service) are false positives there -
    // the merged topology is validated client-side and again at save.
    function collectPreflight(
      document: Record<string, unknown>,
      indexToDraftId: Map<number, number>,
      options: { githubRepositoryId?: number; warningsOnly: boolean },
    ) {
      validateConfig.mutate(
        { applicationId: appId, document, githubRepositoryId: options.githubRepositoryId },
        {
          onSuccess: (result) => {
            const issues = options.warningsOnly
              ? result.issues.filter((issue) => issue.severity === "warning")
              : result.issues;
            setServerIssues((current) => mergeIssues(current, mapIssuesToDraft(issues, indexToDraftId)));
          },
        },
      );
    }
    collectPreflight(submission.primary.document, submission.primary.indexToDraftId, { warningsOnly: false });
    for (const dependency of submission.dependencies) {
      const repoDraft = draft.repos.find((repo) => repo.name === dependency.alias);
      collectPreflight(dependency.document, dependency.indexToDraftId, {
        githubRepositoryId: repoDraft?.githubRepositoryId,
        warningsOnly: true,
      });
    }

    // Secret values (from the Variables step) persist alongside the config in one
    // call: sensitive rows with a (re-)entered value upsert to AWS, loaded keys no
    // longer represented are deleted. Only primary-repo apps have a secret store.
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
          const snapshots: Record<string, string> = {
            [PRIMARY_REPO_KEY]: snapshotDocument(submission.primary.document),
          };
          for (const dependency of submission.dependencies) {
            snapshots[dependency.alias] = snapshotDocument(dependency.document);
          }
          setSavedSnapshots(snapshots);
          // Reflect the now-persisted secrets: clear typed values and mark rows as
          // stored (masked) so a re-save won't re-upload them.
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
            return next;
          });
          onSaved?.();
        },
      },
    );
  }

  // Marks the (optional) hooks step complete and fires the deploy. On failure the
  // deploy hook surfaces an error toast and re-enables the button (its pending flag
  // clears), so the user can retry; the config stays saved so the retry redeploys
  // without re-saving. No `canDeploy` gate here: chaining after a save runs with a
  // stale render closure where `canDeploy` is still false, so a guard would no-op.
  function acknowledgeAndDeploy() {
    setHooksAcknowledged(true);
    deploy.mutate(
      { applicationId: appId },
      {
        onSuccess: () => {
          void navigate({ to: "/onboarding", search: buildOnboardingSearch("deploy-verify", appId) });
        },
      },
    );
  }

  // One action for the final hooks step: persist the config (incl. secrets), then
  // deploy and advance to the deploy-verify section. If the config is already saved
  // and clean (user returned to this step), skip the redundant save. The hooks step
  // is only acknowledged once the action commits (inside save's onSuccess, or on the
  // already-saved path), so a failed save never marks the step complete prematurely.
  function saveAndDeploy() {
    if (hasBlockingIssues) return;
    if (canDeploy) {
      acknowledgeAndDeploy();
      return;
    }
    save(acknowledgeAndDeploy);
  }

  const repoGroups: Array<{ key: string; label: string; badge: string; githubRepositoryId?: number }> = [
    { key: PRIMARY_REPO_KEY, label: repoName, badge: "primary repo" },
    ...draft.repos.map((repo) => ({
      key: repo.name,
      label: repo.repo,
      badge: "dependency",
      githubRepositoryId: repo.githubRepositoryId,
    })),
  ];
  const appCountByRepoKey = new Map(
    draft.repos.map((repo) => [repo.name, draft.apps.filter((app) => app.repoKey === repo.name).length]),
  );

  // Every app is a real, deployable app now (starter apps are seeded complete).
  const deployableApps = draft.apps;
  const allNames = [...deployableApps.map((app) => app.name), ...draft.services.map((service) => service.name)];

  const previousStepId = PREVIOUS_STEP_BY_ID[activeStep];
  const previousStep = previousStepId != null ? CONFIG_STEPS.find((step) => step.id === previousStepId) : undefined;

  return (
    <>
      <OnboardingPageHeader
        leading={
          <div className="mb-4 flex size-10 items-center justify-center border border-primary-ink text-primary-ink shadow-[0_0_15px_var(--accent-glow)]">
            <CodeIcon size={20} weight="bold" />
          </div>
        }
        title="Build with PreviewKit"
        description={
          <p className="max-w-3xl">
            Map every deployable app to its repo, then attach the databases it needs. Extra services and lifecycle hooks
            are optional - add them only if you use them.
          </p>
        }
      />

      <Button variant="ghost" size="sm" className="mb-6 w-fit gap-2" onClick={backToPreviewOptions}>
        <ArrowLeftIcon size={14} />
        Back to preview options
      </Button>

      <ConfigStepper
        activeStep={activeStep}
        completedStepCount={completedStepCount}
        completion={stepCompletion}
        summaries={configStepSummaries(draft)}
        onSelect={(step) => {
          if (!isConfigStepEnabled(step)) return;
          setActiveStep(step);
        }}
      />

      <div className="grid gap-6">
        <div className="space-y-6">
          {activeStep === "apps" ? (
            <div className="space-y-6">
              <AddAppMenu
                thisRepoName={repositoryQuery.data?.fullName?.split("/").pop()}
                onAddToThisRepo={() => addApp(PRIMARY_REPO_KEY)}
                onAddFromAnotherRepo={() => setAddAppDialogOpen(true)}
              />
              <AppsStep
                applicationId={appId}
                draftApps={draft.apps}
                repoGroups={repoGroups}
                repos={draft.repos}
                hasDependencyRepos={draft.repos.length > 0}
                appCountByRepoKey={appCountByRepoKey}
                issues={issues}
                allNames={allNames}
                groupSaved={groupSaved}
                onUpdateApp={updateApp}
                onUpdateRepo={updateRepo}
                onSetPrimaryApp={setPrimaryApp}
                onRemoveApp={removeApp}
              />
              {draft.repos.length > 0 ? (
                <BranchMatchingField
                  convention={draft.branchConvention}
                  onChange={(branchConvention) => setDraft((current) => ({ ...current, branchConvention }))}
                />
              ) : undefined}
              <AddAppDialog
                open={addAppDialogOpen}
                onOpenChange={setAddAppDialogOpen}
                primaryRepoFullName={repositoryQuery.data?.fullName}
                repos={draft.repos}
                onAddToExistingRepo={addApp}
                onAddToNewRepo={addAppFromNewRepo}
              />
            </div>
          ) : undefined}

          {activeStep === "database" ? (
            <div className="space-y-6">
              <DatabaseSection
                databases={draft.services.filter((service) => serviceRecipeIsDatabase(service.recipe))}
                existingNames={draft.services.map((service) => service.name)}
                appNames={hookAppNames}
                repos={draft.repos}
                onChange={(databases) =>
                  setDraft((current) => {
                    const extras = current.services.filter((service) => !serviceRecipeIsDatabase(service.recipe));
                    return applyServicesChange(current, [...extras, ...databases]);
                  })
                }
              />
            </div>
          ) : undefined}

          {activeStep === "services" ? (
            <div className="space-y-6">
              <ServicesSection
                services={draft.services.filter((service) => !serviceRecipeIsDatabase(service.recipe))}
                existingNames={draft.services.map((service) => service.name)}
                onChange={(extras) =>
                  setDraft((current) => {
                    const databases = current.services.filter((service) => serviceRecipeIsDatabase(service.recipe));
                    return applyServicesChange(current, [...databases, ...extras]);
                  })
                }
              />
            </div>
          ) : undefined}

          {activeStep === "review" ? <ReviewSection draft={draft} repoName={repoName} /> : undefined}

          {activeStep === "hooks" ? (
            <HooksSection
              hooks={draft.hooks}
              appNames={hookAppNames}
              errors={hookErrors}
              onChange={(hooks) => setDraft((current) => ({ ...current, hooks }))}
            />
          ) : undefined}

          {activeStep === "variables" ? (
            <div className="space-y-6">
              {deployableApps.length === 0 ? (
                <p className="text-sm text-text-secondary">Add an app first to configure its variables.</p>
              ) : (
                deployableApps.map((app) => (
                  <div key={app.id} className="border border-border-dim">
                    <div className="border-b border-border-dim bg-surface-raised px-4 py-2 font-mono text-2xs font-bold uppercase tracking-widest text-text-secondary">
                      {app.name.trim() === "" ? "unnamed app" : app.name}
                    </div>
                    <div className="p-4">
                      <EnvVarManager
                        app={app}
                        services={draft.services}
                        deployableApps={deployableApps}
                        issues={issues}
                        updateApp={updateApp}
                      />
                    </div>
                  </div>
                ))
              )}
              <VariablesFinishFork
                disabled={hasBlockingIssues}
                onFinish={() => {
                  setVariablesAcknowledged(true);
                  setActiveStep("review");
                }}
                onAddService={() => setActiveStep("services")}
                onAddHook={() => setActiveStep("hooks")}
              />
            </div>
          ) : undefined}

          <ConfigIssuesBanner issues={issues} configReadyForSecrets={configReadyForSecrets} />

          <ConfigStepFooter
            previousStep={previousStep}
            activeStep={activeStep}
            hasBlockingIssues={hasBlockingIssues}
            isSaving={saveConfig.isPending}
            isDeploying={deploy.isPending}
            onSelect={setActiveStep}
            onSaveAndDeploy={saveAndDeploy}
            onAdvanceFromDatabase={() => setDatabaseAcknowledged(true)}
            onAdvanceFromServices={() => setServicesAcknowledged(true)}
            onAdvanceFromHooks={() => setHooksAcknowledged(true)}
          />
        </div>
      </div>
    </>
  );
}

function ConfigStepper({
  activeStep,
  completedStepCount,
  completion,
  summaries,
  onSelect,
}: {
  activeStep: ConfigStepId;
  completedStepCount: number;
  completion: Record<ConfigStepId, boolean>;
  summaries: Record<ConfigStepId, string>;
  onSelect: (step: ConfigStepId) => void;
}) {
  const requiredSteps = CONFIG_STEPS.filter((step) => step.group === "required" && step.id !== "review");
  const optionalSteps = CONFIG_STEPS.filter((step) => step.group === "optional");
  return (
    <section className="relative mb-6 border border-border-dim bg-surface-base">
      <ConfigBarCorners />
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-dim px-4 py-3">
        <span className="flex items-center gap-2 font-mono text-2xs font-bold uppercase tracking-widest text-text-primary">
          <span className="size-1.5 bg-primary-ink" />
          PreviewKit config
        </span>
        <span className="font-mono text-2xs font-semibold uppercase tracking-widest text-primary-ink">
          {completedStepCount} / {FLOW_STEP_IDS.length} required complete
        </span>
      </div>
      <div className="flex flex-col gap-3.5 p-4 lg:flex-row">
        <div className="flex flex-[3] flex-col gap-2">
          <span className="font-mono text-4xs font-bold uppercase tracking-widest text-text-secondary">
            Required · the flow
          </span>
          <div className="flex flex-1 border border-border-mid">
            {requiredSteps.map((step, index) => (
              <RequiredStepCell
                key={step.id}
                step={step}
                position={index + 1}
                active={step.id === activeStep}
                complete={completion[step.id]}
                summary={summaries[step.id]}
                bordered={index < requiredSteps.length - 1}
                onSelect={onSelect}
              />
            ))}
          </div>
        </div>
        <div className="flex flex-[2] flex-col gap-2">
          <span className="font-mono text-4xs font-bold uppercase tracking-widest text-text-secondary">
            Optional · off the flow
          </span>
          <div className="flex flex-1 border border-dashed border-border-mid bg-surface-void">
            {optionalSteps.map((step, index) => (
              <OptionalStepCell
                key={step.id}
                step={step}
                active={step.id === activeStep}
                summary={summaries[step.id]}
                bordered={index < optionalSteps.length - 1}
                onSelect={onSelect}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function ConfigBarCorners() {
  return (
    <>
      <span className="pointer-events-none absolute left-0 top-0 size-2 border-l border-t border-border-mid" />
      <span className="pointer-events-none absolute right-0 top-0 size-2 border-r border-t border-border-mid" />
      <span className="pointer-events-none absolute bottom-0 left-0 size-2 border-b border-l border-border-mid" />
      <span className="pointer-events-none absolute bottom-0 right-0 size-2 border-b border-r border-border-mid" />
    </>
  );
}

function RequiredStepCell({
  step,
  position,
  active,
  complete,
  summary,
  bordered,
  onSelect,
}: {
  step: { id: ConfigStepId; label: string };
  position: number;
  active: boolean;
  complete: boolean;
  summary: string;
  bordered: boolean;
  onSelect: (step: ConfigStepId) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(step.id)}
      className={cn(
        "relative flex flex-1 items-start gap-2.5 px-3.5 py-3 text-left transition-colors hover:bg-surface-void",
        bordered && "border-r border-border-dim",
      )}
    >
      {active ? (
        <span className="pointer-events-none absolute inset-0 border border-primary-ink bg-accent-dim" />
      ) : undefined}
      <span
        className={cn(
          "relative flex size-5.5 shrink-0 items-center justify-center font-mono text-2xs font-bold",
          complete ? "bg-primary-ink text-surface-void" : "border border-border-mid text-text-secondary",
        )}
      >
        {complete ? <CheckIcon size={13} weight="bold" /> : position}
      </span>
      <span className="relative min-w-0">
        <span className="block text-sm font-medium text-text-primary">{step.label}</span>
        <span className="mt-0.5 block font-mono text-4xs font-semibold uppercase tracking-widest text-text-secondary">
          {summary}
        </span>
      </span>
    </button>
  );
}

function OptionalStepCell({
  step,
  active,
  summary,
  bordered,
  onSelect,
}: {
  step: { id: ConfigStepId; label: string };
  active: boolean;
  summary: string;
  bordered: boolean;
  onSelect: (step: ConfigStepId) => void;
}) {
  const Icon = step.id === "services" ? CubeIcon : TerminalWindowIcon;
  return (
    <button
      type="button"
      onClick={() => onSelect(step.id)}
      className={cn(
        "relative flex flex-1 flex-col gap-1 px-3.5 py-3 text-left transition-colors hover:bg-surface-base",
        bordered && "border-r border-dashed border-border-dim",
      )}
    >
      {active ? (
        <span className="pointer-events-none absolute inset-0 border border-primary-ink bg-accent-dim" />
      ) : undefined}
      <span className="relative flex items-center gap-1.5 text-sm font-medium text-text-secondary">
        <Icon size={14} />
        {step.label}
      </span>
      <span className="relative font-mono text-4xs font-semibold uppercase tracking-widest text-text-secondary">
        {summary}
      </span>
    </button>
  );
}

/** Dynamic sub-labels shown under each config-bar cell, reflecting what's configured. */
function configStepSummaries(draft: TopologyDraft): Record<ConfigStepId, string> {
  const databases = draft.services.filter((service) => serviceRecipeIsDatabase(service.recipe));
  const extras = draft.services.filter((service) => !serviceRecipeIsDatabase(service.recipe));
  const hookCount = draft.hooks.pre_deploy.length + draft.hooks.post_deploy.length;
  const primary = draft.apps.find((app) => app.primary) ?? draft.apps[0];
  const runtime = primary?.buildMode === "runtime" ? primary.runtime : undefined;

  return {
    apps:
      draft.apps.length === 0
        ? "no apps"
        : `${draft.apps.length} app${draft.apps.length === 1 ? "" : "s"}${runtime != null ? ` · ${runtime}` : ""}`,
    database:
      databases.length === 0 ? "no databases" : `${databases.length} db${databases.length === 1 ? "" : "s"} · setup`,
    variables: "secrets per app",
    review: "confirm + deploy",
    services: extras.length === 0 ? "docker images" : `${extras.length} image${extras.length === 1 ? "" : "s"}`,
    hooks: hookCount === 0 ? "deploy scripts" : `${hookCount} hook${hookCount === 1 ? "" : "s"}`,
  };
}

/** The single "Add app" entry point: a dropdown offering the primary repo or another repo. */
function AddAppMenu({
  thisRepoName,
  onAddToThisRepo,
  onAddFromAnotherRepo,
}: {
  thisRepoName?: string;
  onAddToThisRepo: () => void;
  onAddFromAnotherRepo: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="sm" className="w-fit gap-2">
            <PlusIcon size={14} weight="bold" />
            Add app
            <CaretDownIcon size={12} />
          </Button>
        }
      />
      <DropdownMenuContent align="start">
        <DropdownMenuItem onClick={onAddToThisRepo}>
          This repo
          {thisRepoName != null ? <span className="ml-1 text-text-secondary">({thisRepoName})</span> : undefined}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onAddFromAnotherRepo}>Another repo</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AppsStep({
  applicationId,
  draftApps,
  repoGroups,
  repos,
  hasDependencyRepos,
  appCountByRepoKey,
  issues,
  allNames,
  groupSaved,
  onUpdateApp,
  onUpdateRepo,
  onSetPrimaryApp,
  onRemoveApp,
}: {
  applicationId: string;
  draftApps: AppDraft[];
  repoGroups: Array<{ key: string; label: string; badge: string; githubRepositoryId?: number }>;
  repos: RepoDraft[];
  hasDependencyRepos: boolean;
  appCountByRepoKey: Map<string, number>;
  issues: DraftIssues;
  allNames: string[];
  groupSaved: (repoKey: string) => boolean;
  onUpdateApp: (id: number, patch: Partial<AppDraft>) => void;
  onUpdateRepo: (id: number, patch: Partial<RepoDraft>) => void;
  onSetPrimaryApp: (id: number) => void;
  onRemoveApp: (id: number) => void;
}) {
  return (
    <>
      {repoGroups.map((group) => {
        const groupApps = draftApps.filter((app) => app.repoKey === group.key);
        const dependencyOptions = allNames.filter((name) => name.trim() !== "");
        const groupRepo = repos.find((repo) => repo.name === group.key);
        const groupRepoAppCount = appCountByRepoKey.get(group.key) ?? 0;
        return (
          <div key={group.key} className="space-y-4">
            <section className="border border-border-dim bg-surface-base">
              <div className="flex flex-wrap items-center gap-3 border-b border-border-dim bg-surface-raised px-5 py-4">
                <h2
                  className="truncate font-mono text-sm font-bold uppercase tracking-widest text-text-primary"
                  title={group.label}
                >
                  {group.label}
                </h2>
                {/* The primary/dependency repo distinction is only meaningful once
                    the project spans more than one repo. */}
                {hasDependencyRepos ? <Badge variant="outline">{group.badge}</Badge> : undefined}
                <Badge variant={groupSaved(group.key) ? "success" : "secondary"} className="ml-auto">
                  {groupSaved(group.key) ? "Saved" : "Unsaved"}
                </Badge>
              </div>
              <div className="space-y-4 p-5">
                {groupApps.length === 0 ? (
                  <p className="text-sm text-text-secondary">No deployable apps mapped yet. Add an app to start.</p>
                ) : (
                  groupApps.map((app) => (
                    <AppCard
                      key={app.id}
                      app={app}
                      applicationId={applicationId}
                      githubRepositoryId={group.githubRepositoryId}
                      issues={issues}
                      dependencyOptions={dependencyOptions.filter((name) => name !== app.name)}
                      showDependsOn={hasDependencyRepos}
                      showFrontendToggle={draftApps.length > 1}
                      repo={groupRepo}
                      repoAppCount={groupRepoAppCount}
                      onChange={onUpdateApp}
                      onRepoChange={onUpdateRepo}
                      onSetPrimary={onSetPrimaryApp}
                      onRemove={onRemoveApp}
                    />
                  ))
                )}
              </div>
            </section>
          </div>
        );
      })}
    </>
  );
}

function isConfigStepEnabled(_step: ConfigStepId): boolean {
  // Every step is a config-editing step now (variables saves with the config),
  // so all are always reachable; deploy readiness is gated in the footer.
  return true;
}

/**
 * Document-level findings (schema/semantic errors, warnings) for the authoring
 * steps. Errors block the Save action in the footer; warnings never block. Lives
 * above the footer on the `apps` and `hooks` steps so the disabled reason for
 * Save is always visible next to it.
 */
function ConfigIssuesBanner({
  issues,
  configReadyForSecrets,
}: {
  issues: DraftIssues;
  configReadyForSecrets: boolean;
}) {
  return (
    <>
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
      {configReadyForSecrets ? (
        <p className="text-sm text-text-secondary">Config saved. Deploy from the review step when you're ready.</p>
      ) : undefined}
    </>
  );
}

/**
 * The variables step is where most people finish. This lime-bordered card is the
 * fork: deploy now (Finish & review), or opt into the off-path extra-services /
 * lifecycle-hooks steps.
 */
function VariablesFinishFork({
  disabled,
  onFinish,
  onAddService,
  onAddHook,
}: {
  disabled: boolean;
  onFinish: () => void;
  onAddService: () => void;
  onAddHook: () => void;
}) {
  return (
    <div className="flex flex-col gap-3.5 border border-primary-ink bg-accent-dim px-5 py-4">
      <div className="flex items-center gap-2">
        <CheckCircleIcon size={16} weight="fill" className="text-primary-ink" />
        <span className="text-sm font-semibold text-text-primary">You're set - most people finish here.</span>
      </div>
      <p className="max-w-xl text-2xs leading-relaxed text-text-secondary">
        Your app and databases are configured. You can deploy now, or add optional pieces if your setup needs them.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="accent" className="gap-2" disabled={disabled} onClick={onFinish}>
          <RocketLaunchIcon size={14} weight="bold" />
          Finish &amp; review
        </Button>
        <span className="text-2xs text-text-secondary">or, if you need more -</span>
        <Button variant="outline" size="sm" className="gap-2" onClick={onAddService}>
          <PlusIcon size={13} weight="bold" />
          Extra service
        </Button>
        <Button variant="outline" size="sm" className="gap-2" onClick={onAddHook}>
          <PlusIcon size={13} weight="bold" />
          Lifecycle hook
        </Button>
      </div>
    </div>
  );
}

/**
 * The footer wires the flow. The required path is `apps → database → variables`,
 * and variables is the fork: from there most people finish (`→ review`) but can
 * opt into the off-path extra-services / lifecycle-hooks steps. Those optional
 * steps and the review step all walk back to variables; review does the real work
 * (`Save and deploy`) - persisting the document + secrets and triggering the deploy.
 */
function ConfigStepFooter({
  previousStep,
  activeStep,
  hasBlockingIssues,
  isSaving,
  isDeploying,
  onSelect,
  onSaveAndDeploy,
  onAdvanceFromDatabase,
  onAdvanceFromServices,
  onAdvanceFromHooks,
}: {
  previousStep: { id: ConfigStepId; label: string } | undefined;
  activeStep: ConfigStepId;
  hasBlockingIssues: boolean;
  isSaving: boolean;
  isDeploying: boolean;
  onSelect: (step: ConfigStepId) => void;
  onSaveAndDeploy: () => void;
  onAdvanceFromDatabase: () => void;
  onAdvanceFromServices: () => void;
  onAdvanceFromHooks: () => void;
}) {
  const backButton =
    previousStep != null ? (
      <Button variant="outline" className="gap-2" onClick={() => onSelect(previousStep.id)}>
        <ArrowLeftIcon size={14} />
        {previousStep.label}
      </Button>
    ) : (
      <span />
    );

  // The variables step forks in the body (the "You're set" card); the footer is
  // just the back link so the two Continue affordances don't compete.
  if (activeStep === "variables") {
    return <div className="flex border-t border-border-dim pt-4">{backButton}</div>;
  }

  const primaryAction = getPrimaryAction();
  return (
    <div className="flex justify-between border-t border-border-dim pt-4">
      {backButton}
      <Button variant="accent" className="gap-2" disabled={primaryAction.disabled} onClick={primaryAction.onClick}>
        {primaryAction.label}
        <ArrowRightIcon size={14} />
      </Button>
    </div>
  );

  function getPrimaryAction(): { label: string; onClick: () => void; disabled: boolean } {
    if (activeStep === "apps") {
      return {
        label: "Continue to database",
        onClick: () => onSelect("database"),
        disabled: hasBlockingIssues,
      };
    }
    if (activeStep === "database") {
      return {
        label: "Continue to variables",
        onClick: () => {
          onAdvanceFromDatabase();
          onSelect("variables");
        },
        disabled: hasBlockingIssues,
      };
    }
    // The optional steps fork off variables (the back button returns there); their
    // forward action finishes into the review screen.
    if (activeStep === "services") {
      return {
        label: "Done - review",
        onClick: () => {
          onAdvanceFromServices();
          onSelect("review");
        },
        disabled: hasBlockingIssues,
      };
    }
    if (activeStep === "hooks") {
      return {
        label: "Done - review",
        onClick: () => {
          onAdvanceFromHooks();
          onSelect("review");
        },
        disabled: hasBlockingIssues,
      };
    }
    // Review is the terminal step: one action saves the config (incl. secrets) and deploys.
    const label = isDeploying ? "Starting deploy..." : isSaving ? "Saving..." : "Save and deploy";
    return {
      label,
      onClick: onSaveAndDeploy,
      disabled: hasBlockingIssues || isSaving || isDeploying,
    };
  }
}

function addApps(current: TopologyDraft, apps: AppDraft[]): TopologyDraft {
  const existingNames = new Set(current.apps.map((app) => app.name).filter((name) => name.trim() !== ""));
  const newApps = uniqueNewApps(apps, existingNames);

  return {
    ...current,
    apps: [...current.apps, ...newApps],
  };
}

function uniqueNewApps(apps: AppDraft[], existingNames: Set<string>): AppDraft[] {
  const names = new Set(existingNames);
  const unique: AppDraft[] = [];

  for (const app of apps) {
    const name = app.name.trim();
    if (name === "") {
      unique.push(app);
      continue;
    }
    if (names.has(name)) continue;
    names.add(name);
    unique.push(app);
  }

  return unique;
}

/**
 * Applies a services edit while keeping name-based depends_on links intact:
 * renamed services (matched by stable id) are remapped in every app's
 * depends_on, then a reference to a now-removed service is pruned. Remap before
 * prune so a rename is never mistaken for a delete.
 */
function applyServicesChange(current: TopologyDraft, services: ServiceDraft[]): TopologyDraft {
  const oldNameById = new Map(current.services.map((service) => [service.id, service.name]));
  const renameByOldName = new Map<string, string>();
  for (const service of services) {
    const oldName = oldNameById.get(service.id);
    if (oldName != null && oldName !== "" && service.name !== "" && oldName !== service.name) {
      renameByOldName.set(oldName, service.name);
    }
  }
  const apps =
    renameByOldName.size === 0
      ? current.apps
      : current.apps.map((app) => ({
          ...app,
          dependsOn: app.dependsOn.map((name) => renameByOldName.get(name) ?? name),
        }));
  return pruneDanglingDependsOn({ ...current, services, apps });
}

function getConfigStepCompletion({
  draft,
  issues,
  hooksValid,
  hooksAcknowledged,
  databaseAcknowledged,
  servicesAcknowledged,
  variablesAcknowledged,
}: {
  draft: TopologyDraft;
  issues: DraftIssues;
  hooksValid: boolean;
  hooksAcknowledged: boolean;
  databaseAcknowledged: boolean;
  servicesAcknowledged: boolean;
  variablesAcknowledged: boolean;
}): Record<ConfigStepId, boolean> {
  const noBlockingDocumentErrors = issues.documentErrors.length === 0;
  const appsComplete =
    draft.apps.length > 0 &&
    draft.apps.every((app) => {
      const requiredFieldsComplete = app.name.trim() !== "" && app.path.trim() !== "" && app.port.trim() !== "";
      return requiredFieldsComplete && !hasAppFieldErrors(issues, app.id);
    }) &&
    noBlockingDocumentErrors;

  const databases = draft.services.filter((service) => serviceRecipeIsDatabase(service.recipe));
  const extras = draft.services.filter((service) => !serviceRecipeIsDatabase(service.recipe));
  // An empty database / extra-services list is valid, but each step only reads
  // complete once one is configured or the user has advanced past it (acknowledged).
  const databasesValid = databases.every((service) => service.name.trim() !== "");
  const databaseComplete = databasesValid && (databases.length > 0 || databaseAcknowledged) && noBlockingDocumentErrors;
  const extrasValid = extras.every((service) => service.name.trim() !== "");
  const servicesComplete = extrasValid && (extras.length > 0 || servicesAcknowledged) && noBlockingDocumentErrors;

  return {
    apps: appsComplete,
    database: databaseComplete,
    variables: noBlockingDocumentErrors && variablesAcknowledged,
    // Review is the terminal deploy screen; it is never "complete" (leaving it
    // means the deploy has started and the flow has moved on).
    review: false,
    services: servicesComplete,
    // Hooks are optional: complete only once the user has advanced past the step
    // (acknowledged), even with nothing configured - never before. An invalid row
    // (missing/unknown app or missing command) keeps it incomplete regardless.
    hooks: hooksValid && hooksAcknowledged,
  };
}

function hasAppFieldErrors(issues: DraftIssues, draftId: number): boolean {
  const fields: AppDraftField[] = [
    "name",
    "path",
    "buildContext",
    "dockerfile",
    "runtime",
    "runtimeVersion",
    "buildScript",
    "entrypoint",
    "port",
    "command",
    "healthCheck",
    "primary",
    "dependsOn",
    "env",
    "connections",
    "buildSecrets",
  ];
  return fields.some((field) => issues.fieldErrors.has(fieldIssueKey(draftId, field)));
}

/**
 * Validates the draft entirely client-side: per-document schema checks (shape,
 * within-doc duplicate names, the at-least-one-app rule) plus semantic checks on
 * the MERGED topology - mirroring how PreviewKit concatenates every repo's
 * config at deploy, so cross-repo `depends_on`/env references don't false-error.
 */
function validateDraftClientSide(compiled: ReturnType<typeof documentsFromDraft>): DraftIssues {
  const result = emptyDraftIssues();

  const allDocuments = [
    { label: "primary repo", ...compiled.primary },
    ...compiled.dependencies.map((dependency) => ({ label: dependency.repo, ...dependency })),
  ];

  const mergedApps: unknown[] = [];
  const mergedIndexToDraftId = new Map<number, number>();
  let mergedServices: unknown = compiled.primary.document.services;

  for (const entry of allDocuments) {
    const parsed = previewConfigSchema.safeParse(entry.document);
    if (!parsed.success) {
      const issues = zodIssuesToConfigIssues(parsed.error).map((issue) =>
        labelDocumentIssue(issue, entry.label, allDocuments.length > 1),
      );
      mapIssuesToDraft(issues, entry.indexToDraftId, result);
    }

    const apps = entry.document.apps;
    if (Array.isArray(apps)) {
      for (const [index, app] of apps.entries()) {
        const draftId = entry.indexToDraftId.get(index);
        if (draftId != null) mergedIndexToDraftId.set(mergedApps.length, draftId);
        mergedApps.push(app);
      }
    }
  }
  if (!Array.isArray(mergedServices)) mergedServices = [];

  const merged = previewConfigSchema.safeParse({
    version: 1,
    apps: mergedApps,
    services: mergedServices,
  });
  if (merged.success) {
    const issues = validatePreviewConfigSemantics(merged.data);
    mapIssuesToDraft(issues, mergedIndexToDraftId, result);
  } else if (mergedApps.length > 0) {
    // Cross-document duplicate names surface here (the schema's uniqueness
    // refine runs per document otherwise).
    const issues = zodIssuesToConfigIssues(merged.error).filter((issue) => issue.path.length === 0);
    mapIssuesToDraft(issues, mergedIndexToDraftId, result);
  }

  return result;
}

function labelDocumentIssue(issue: ConfigIssue, label: string, multiRepo: boolean): ConfigIssue {
  if (!multiRepo || issue.path[0] === "apps") return issue;
  return { ...issue, message: `${label}: ${issue.message}` };
}

function mergeIssues(client: DraftIssues, server: DraftIssues): DraftIssues {
  const fieldErrors = new Map(client.fieldErrors);
  for (const [key, messages] of server.fieldErrors) {
    fieldErrors.set(key, [...(fieldErrors.get(key) ?? []), ...messages]);
  }
  const fieldWarnings = new Map(client.fieldWarnings);
  for (const [key, messages] of server.fieldWarnings) {
    fieldWarnings.set(key, [...(fieldWarnings.get(key) ?? []), ...messages]);
  }
  return {
    fieldErrors,
    fieldWarnings,
    documentErrors: [...client.documentErrors, ...server.documentErrors],
    documentWarnings: [...client.documentWarnings, ...server.documentWarnings],
  };
}

function draftFromConfigSnapshot(config: {
  document: Parameters<typeof draftFromConfig>[0];
  dependencyConfigs: Parameters<typeof draftFromConfig>[1];
}): Record<string, string> {
  const compiled = documentsFromDraft(draftFromConfig(config.document, config.dependencyConfigs));
  const snapshots: Record<string, string> = { [PRIMARY_REPO_KEY]: snapshotDocument(compiled.primary.document) };
  for (const dependency of compiled.dependencies) {
    snapshots[dependency.alias] = snapshotDocument(dependency.document);
  }
  return snapshots;
}

/** Scrolls to and focuses the app/field a deploy failure pointed at, then clears the search params. */
function useFocusDeepLink(
  draft: TopologyDraft,
  focusApp: string | undefined,
  focusField: string | undefined,
  clearParams: () => void,
) {
  // One-shot: the deep-link target comes from the URL; once consumed (or
  // unresolvable), later draft edits must not re-trigger the scroll.
  const [consumed, setConsumed] = useState(false);

  useEffect(() => {
    if (consumed || focusApp == null) return;
    setConsumed(true);
    const app = draft.apps.find((candidate) => candidate.name === focusApp);
    if (app == null) return;
    const field = focusField != null ? (appFieldFromDocumentKey(focusField) ?? "name") : "name";
    const element = document.getElementById(`pk-app-${app.id}-${field}`);
    if (element == null) return;
    element.scrollIntoView({ block: "center" });
    element.focus();
    clearParams();
  }, [consumed, draft.apps, focusApp, focusField, clearParams]);
}
