import { Badge, Button, Skeleton, cn } from "@autonoma/blacklight";
import {
  previewConfigSchema,
  validatePreviewConfigSemantics,
  zodIssuesToConfigIssues,
  type ConfigIssue,
  type SuggestedApp,
  type SuggestedEnvVar,
  type SuggestedService,
} from "@autonoma/types";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { FileCodeIcon } from "@phosphor-icons/react/FileCode";
import { FloppyDiskIcon } from "@phosphor-icons/react/FloppyDisk";
import { MinusIcon } from "@phosphor-icons/react/Minus";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { useQueryClient } from "@tanstack/react-query";
import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  usePreviewkitConfig,
  useRepoSuggestions,
  useSavePreviewkitConfig,
  useSuggestEnvVars,
  useSuggestServices,
  useTriggerPreviewkitMainDeploy,
  useValidatePreviewkitConfig,
} from "lib/onboarding/onboarding-api";
import { buildOnboardingSearch } from "lib/onboarding/onboarding-search";
import { useApplicationRepositoryFromGitHub } from "lib/query/github.queries";
import { toastManager } from "lib/toast-manager";
import { trpc } from "lib/trpc";
import { Suspense, useEffect, useRef, useState } from "react";
import { EnvVarManager } from "../_app-shell/app.$appSlug/preview-config/-variables/env-var-manager";
import { OnboardingAppHeader } from "./-components/onboarding-app-header";
import { OnboardingPageHeader } from "./-components/onboarding-page-header";
import { AppCard } from "./-components/previewkit/app-card";
import { EnvSuggestionsBanner, envSuggestionKey } from "./-components/previewkit/env-suggestions-banner";
import { HooksSection } from "./-components/previewkit/hooks-section";
import { MultirepoSection } from "./-components/previewkit/multirepo-section";
import { ServiceSuggestionsBanner, serviceSuggestionKey } from "./-components/previewkit/service-suggestions-banner";
import { ServicesSection } from "./-components/previewkit/services-section";
import { SuggestionsBanner, suggestionKey } from "./-components/previewkit/suggestions-banner";
import {
  PRIMARY_REPO_KEY,
  appDraftFromSuggestion,
  appFieldFromDocumentKey,
  diffAppSecrets,
  documentsFromDraft,
  draftFromConfig,
  emptyAppDraft,
  emptyDraftIssues,
  envRowsFromSuggestions,
  fieldIssueKey,
  hookFieldErrors,
  isUntouchedStarterApp,
  withSecretRows,
  mapIssuesToDraft,
  pruneDanglingDependsOn,
  serviceDraftForRecipe,
  snapshotDocument,
  sortEnvRows,
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
}

type ConfigStepId = "apps" | "services" | "variables" | "hooks";

const CONFIG_STEPS: Array<{ id: ConfigStepId; label: string; description: string; optional?: boolean }> = [
  { id: "apps", label: "Apps", description: "Deployable apps + dependency repos" },
  { id: "services", label: "Services", description: "Managed backing services" },
  { id: "variables", label: "Variables", description: "Secrets + connections per app" },
  { id: "hooks", label: "Hooks", description: "Pre/post-deploy commands", optional: true },
];

// Steps that count toward the completion tally. Optional steps (hooks) are shown
// in the stepper but never counted - the tally reflects only required progress.
const REQUIRED_STEP_COUNT = CONFIG_STEPS.filter((step) => step.optional !== true).length;

export function PreviewkitConfigPage({ appId, focusApp, focusField, focusSection }: PreviewkitConfigPageProps) {
  if (appId == null) {
    return <p className="font-mono text-sm text-text-secondary">No application found. Please start from setup.</p>;
  }

  return (
    <Suspense fallback={<PreviewkitConfigSkeleton />}>
      <PreviewkitConfigContent appId={appId} focusApp={focusApp} focusField={focusField} focusSection={focusSection} />
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
  const [activeStep, setActiveStep] = useState<ConfigStepId>(() => (focusSection === "secrets" ? "variables" : "apps"));
  const [handledSuggestions, setHandledSuggestions] = useState<Set<string>>(new Set());
  const [handledServiceSuggestions, setHandledServiceSuggestions] = useState<Set<string>>(new Set());
  const [handledEnvSuggestions, setHandledEnvSuggestions] = useState<Set<string>>(new Set());
  // The hooks step is optional: it only reads as complete once the user has
  // advanced past it (clicked next/save from the hooks step), even when nothing
  // is configured - never before. A previously saved config counts as advanced.
  const [hooksAcknowledged, setHooksAcknowledged] = useState<boolean>(configQuery.data.saved);
  // Services follow the same acknowledgement rule: an empty list is a valid
  // config, but the step only reads as complete once the user has advanced past
  // it (or configured a service). A previously saved config counts as advanced.
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
  const hasUntouchedStarterApps = draft.apps.some(isUntouchedStarterApp);
  // Names a hook may target: declared (non-starter) apps. Hooks reference apps only.
  const hookAppNames = draft.apps
    .filter((app) => !isUntouchedStarterApp(app))
    .map((app) => app.name)
    .filter((name) => name.trim() !== "");
  const hookErrors = hookFieldErrors(draft.hooks, hookAppNames);
  const hasBlockingIssues =
    issues.fieldErrors.size > 0 || issues.documentErrors.length > 0 || hasUntouchedStarterApps || hookErrors.size > 0;

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
    servicesAcknowledged,
    variablesAcknowledged,
  });
  const completedStepCount = CONFIG_STEPS.filter((step) => step.optional !== true && stepCompletion[step.id]).length;

  useEffect(() => {
    if (focusSection === "secrets") setActiveStep("variables");
    if (focusSection === "config") setActiveStep("apps");
  }, [focusSection]);

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
            return { ...app, ...patch, origin: app.origin === "starter" ? "manual" : (patch.origin ?? app.origin) };
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
        origin: app.id === id && app.origin === "starter" ? "manual" : app.origin,
      })),
    }));
  }

  function addApp(repoKey: string, prefilled?: AppDraft) {
    setDraft((current) => addAppsReplacingStarters(current, repoKey, [prefilled ?? emptyAppDraft(repoKey)]));
  }

  function removeApp(id: number) {
    setDraft((current) => pruneDanglingDependsOn({ ...current, apps: current.apps.filter((app) => app.id !== id) }));
  }

  function markSuggestionsHandled(repoKey: string, suggestions: SuggestedApp[]) {
    setHandledSuggestions(
      (current) =>
        new Set([...current, ...suggestions.map((suggestion) => `${repoKey}::${suggestionKey(suggestion)}`)]),
    );
  }

  function acceptSuggestion(repoKey: string, suggestion: SuggestedApp) {
    markSuggestionsHandled(repoKey, [suggestion]);
    setDraft((current) => addSuggestionsReplacingStarters(current, [suggestion], repoKey));
  }

  function acceptAllSuggestions(repoKey: string, suggestions: SuggestedApp[]) {
    markSuggestionsHandled(repoKey, suggestions);
    setDraft((current) => addSuggestionsReplacingStarters(current, suggestions, repoKey));
  }

  function dismissSuggestion(repoKey: string, suggestion: SuggestedApp) {
    markSuggestionsHandled(repoKey, [suggestion]);
  }

  function markServiceSuggestionsHandled(suggestions: SuggestedService[]) {
    setHandledServiceSuggestions((current) => new Set([...current, ...suggestions.map(serviceSuggestionKey)]));
  }

  function acceptServiceSuggestion(suggestion: SuggestedService) {
    markServiceSuggestionsHandled([suggestion]);
    setDraft((current) => addServiceSuggestion(current, suggestion));
  }

  function acceptAllServiceSuggestions(suggestions: SuggestedService[]) {
    markServiceSuggestionsHandled(suggestions);
    setDraft((current) => suggestions.reduce(addServiceSuggestion, current));
  }

  function dismissServiceSuggestion(suggestion: SuggestedService) {
    markServiceSuggestionsHandled([suggestion]);
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

  function save() {
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
          toastManager.add({ type: "success", title: "PreviewKit config saved" });
        },
      },
    );
  }

  function startDeploy() {
    if (!canDeploy) return;
    deploy.mutate(
      { applicationId: appId },
      {
        onSuccess: () => {
          void navigate({ to: "/onboarding", search: buildOnboardingSearch("deploy-verify", appId) });
        },
      },
    );
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

  const deployableApps = draft.apps.filter((app) => !isUntouchedStarterApp(app));
  const allNames = [...deployableApps.map((app) => app.name), ...draft.services.map((service) => service.name)];

  // AI-suggested variables, analyzed from each primary-repo app's `.env.example`.
  const suggestionApps = deployableApps
    .filter((app) => app.repoKey === PRIMARY_REPO_KEY && app.name.trim() !== "")
    .map((app) => ({
      name: app.name.trim(),
      path: app.path.trim() === "" ? "." : app.path.trim(),
      primary: app.primary,
    }));
  const suggestionServices = draft.services
    .filter((service) => service.name.trim() !== "")
    .map((service) => ({ name: service.name.trim(), recipe: service.recipe }));
  const { data: envSuggestions, isPending: envSuggestionsPending } = useSuggestEnvVars(
    appId,
    !configQuery.data.saved,
    suggestionApps,
    suggestionServices,
  );

  function envSuggestionOwnerKeys(appName: string): Set<string> {
    const app = deployableApps.find((candidate) => candidate.name === appName);
    return new Set((app?.env ?? []).map((row) => row.key.trim()).filter((key) => key !== ""));
  }

  function appendEnvSuggestions(appName: string, suggestions: SuggestedEnvVar[]) {
    setHandledEnvSuggestions(
      (current) => new Set([...current, ...suggestions.map((suggestion) => envSuggestionKey(appName, suggestion.key))]),
    );
    const app = deployableApps.find((candidate) => candidate.name === appName);
    if (app == null) return;
    const rows = envRowsFromSuggestions(app.env, suggestions, app.repoKey === PRIMARY_REPO_KEY);
    if (rows.length > 0) updateApp(app.id, { env: sortEnvRows([...app.env, ...rows]) });
  }

  function acceptEnvSuggestion(appName: string, suggestion: SuggestedEnvVar) {
    appendEnvSuggestions(appName, [suggestion]);
  }

  function acceptAllEnvSuggestions(appName: string, suggestions: SuggestedEnvVar[]) {
    appendEnvSuggestions(appName, suggestions);
  }

  function dismissEnvSuggestion(appName: string, suggestion: SuggestedEnvVar) {
    setHandledEnvSuggestions((current) => new Set([...current, envSuggestionKey(appName, suggestion.key)]));
  }

  const activeStepIndex = CONFIG_STEPS.findIndex((step) => step.id === activeStep);
  const previousStep = activeStepIndex > 0 ? CONFIG_STEPS[activeStepIndex - 1] : undefined;

  return (
    <>
      <OnboardingPageHeader
        leading={
          <div className="mb-4 flex size-12 items-center justify-center border border-primary-ink/30 bg-surface-base">
            <FileCodeIcon size={22} weight="duotone" className="text-primary-ink" />
          </div>
        }
        title="Build with PreviewKit"
        description={
          <>
            <OnboardingAppHeader appId={appId} />
            <p className="max-w-3xl">
              Map every deployable app to its repo, path, and entrypoints for{" "}
              <span className="text-text-primary">{repoName}</span>. Managed services come from recipes. This onboarding
              deploy reads the saved revision.
            </p>
          </>
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
        onSelect={(step) => {
          if (!isConfigStepEnabled(step)) return;
          setActiveStep(step);
        }}
      />

      <div className="grid gap-6">
        <div className="space-y-6">
          {activeStep === "apps" ? (
            <div className="space-y-6">
              <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
                <div className="min-w-0 space-y-6">
                  <AppsStep
                    appId={appId}
                    suggestionsEnabled={!configQuery.data.saved}
                    handledSuggestions={handledSuggestions}
                    draftApps={draft.apps}
                    repoGroups={repoGroups}
                    issues={issues}
                    allNames={allNames}
                    groupSaved={groupSaved}
                    onAcceptSuggestion={acceptSuggestion}
                    onAcceptAllSuggestions={acceptAllSuggestions}
                    onDismissSuggestion={dismissSuggestion}
                    onAddApp={addApp}
                    onUpdateApp={updateApp}
                    onSetPrimaryApp={setPrimaryApp}
                    onRemoveApp={removeApp}
                  />
                </div>
                <div className="xl:sticky xl:top-20 xl:self-start">
                  <MultirepoSection
                    repos={draft.repos}
                    branchConvention={draft.branchConvention}
                    primaryRepoFullName={repositoryQuery.data?.fullName}
                    appCountByRepoKey={appCountByRepoKey}
                    onReposChange={handleReposChange}
                    onBranchConventionChange={(branchConvention) =>
                      setDraft((current) => ({ ...current, branchConvention }))
                    }
                  />
                </div>
              </div>
            </div>
          ) : undefined}

          {activeStep === "services" ? (
            <div className="space-y-6">
              <ServiceSuggestions
                appId={appId}
                enabled={!configQuery.data.saved}
                apps={deployableApps
                  .filter((app) => app.repoKey === PRIMARY_REPO_KEY && app.name.trim() !== "")
                  .map((app) => ({ name: app.name.trim(), path: app.path.trim() === "" ? "." : app.path.trim() }))}
                existingRecipes={new Set(draft.services.map((service) => service.recipe))}
                handled={handledServiceSuggestions}
                onAccept={acceptServiceSuggestion}
                onAcceptAll={acceptAllServiceSuggestions}
                onDismiss={dismissServiceSuggestion}
              />
              <ServicesSection
                services={draft.services}
                onChange={(services) => setDraft((current) => applyServicesChange(current, services))}
              />
            </div>
          ) : undefined}

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
              <EnvSuggestionsBanner
                enabled={!configQuery.data.saved}
                isPending={envSuggestionsPending}
                data={envSuggestions}
                ownerEnvKeys={envSuggestionOwnerKeys}
                handled={handledEnvSuggestions}
                onAccept={acceptEnvSuggestion}
                onAcceptAll={acceptAllEnvSuggestions}
                onDismiss={dismissEnvSuggestion}
              />
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
            </div>
          ) : undefined}

          {activeStep === "apps" ||
          activeStep === "services" ||
          activeStep === "variables" ||
          activeStep === "hooks" ? (
            <ConfigIssuesBanner
              issues={issues}
              hasUntouchedStarterApps={hasUntouchedStarterApps}
              configReadyForSecrets={configReadyForSecrets}
            />
          ) : undefined}

          <ConfigStepFooter
            previousStep={previousStep}
            activeStep={activeStep}
            hasBlockingIssues={hasBlockingIssues}
            isSaving={saveConfig.isPending}
            isDeploying={deploy.isPending}
            canDeploy={canDeploy}
            onSelect={setActiveStep}
            onSave={save}
            onDeploy={startDeploy}
            onAdvanceFromServices={() => setServicesAcknowledged(true)}
            onAdvanceFromVariables={() => setVariablesAcknowledged(true)}
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
  onSelect,
}: {
  activeStep: ConfigStepId;
  completedStepCount: number;
  completion: Record<ConfigStepId, boolean>;
  onSelect: (step: ConfigStepId) => void;
}) {
  return (
    <section className="mb-6 border border-border-dim bg-surface-base">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-dim bg-surface-raised px-5 py-3">
        <h2 className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">PreviewKit config</h2>
        <span className="font-mono text-2xs uppercase tracking-widest text-primary-ink">
          {completedStepCount}/{REQUIRED_STEP_COUNT} complete
        </span>
      </div>
      <div className="grid gap-px bg-border-dim sm:grid-cols-2 lg:grid-cols-4">
        {CONFIG_STEPS.map((step, index) => {
          const active = step.id === activeStep;
          const complete = completion[step.id];
          const enabled = isConfigStepEnabled(step.id);
          const isOptional = step.optional === true;
          // An optional step that isn't complete is skippable, not a pending required
          // todo - show a neutral dash rather than a step number so it never reads as
          // unfinished work.
          const showDash = isOptional && !complete;
          // Required steps are numbered by their position among required steps only,
          // so the optional step never leaves a gap in the sequence.
          const requiredPosition = CONFIG_STEPS.slice(0, index + 1).filter((s) => s.optional !== true).length;
          return (
            <button
              key={step.id}
              type="button"
              onClick={() => onSelect(step.id)}
              disabled={!enabled}
              className={cn(
                "flex min-h-20 items-start gap-3 bg-surface-base px-4 py-4 text-left transition-colors hover:bg-surface-raised",
                active && "bg-primary-ink/10",
                !enabled && "cursor-not-allowed opacity-45 hover:bg-surface-base",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 flex size-6 shrink-0 items-center justify-center border font-mono text-3xs",
                  complete
                    ? "border-primary-ink bg-primary-ink text-surface-void"
                    : active
                      ? "border-primary-ink text-primary-ink"
                      : "border-border-mid text-text-secondary",
                )}
              >
                {complete ? (
                  <CheckIcon size={12} weight="bold" />
                ) : showDash ? (
                  <MinusIcon size={12} weight="bold" />
                ) : (
                  requiredPosition
                )}
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-2">
                  <span
                    className={cn("block text-sm font-medium", active ? "text-text-primary" : "text-text-secondary")}
                  >
                    {step.label}
                  </span>
                  {isOptional ? (
                    <Badge variant="outline" className="text-3xs uppercase tracking-widest">
                      Optional
                    </Badge>
                  ) : undefined}
                </span>
                <span className="mt-1 block font-mono text-3xs uppercase tracking-widest text-text-secondary">
                  {step.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function AppsStep({
  appId,
  suggestionsEnabled,
  handledSuggestions,
  draftApps,
  repoGroups,
  issues,
  allNames,
  groupSaved,
  onAcceptSuggestion,
  onAcceptAllSuggestions,
  onDismissSuggestion,
  onAddApp,
  onUpdateApp,
  onSetPrimaryApp,
  onRemoveApp,
}: {
  appId: string;
  suggestionsEnabled: boolean;
  handledSuggestions: Set<string>;
  draftApps: AppDraft[];
  repoGroups: Array<{ key: string; label: string; badge: string; githubRepositoryId?: number }>;
  issues: DraftIssues;
  allNames: string[];
  groupSaved: (repoKey: string) => boolean;
  onAcceptSuggestion: (repoKey: string, suggestion: SuggestedApp) => void;
  onAcceptAllSuggestions: (repoKey: string, suggestions: SuggestedApp[]) => void;
  onDismissSuggestion: (repoKey: string, suggestion: SuggestedApp) => void;
  onAddApp: (repoKey: string, prefilled?: AppDraft) => void;
  onUpdateApp: (id: number, patch: Partial<AppDraft>) => void;
  onSetPrimaryApp: (id: number) => void;
  onRemoveApp: (id: number) => void;
}) {
  return (
    <>
      {repoGroups.map((group) => {
        const groupApps = draftApps.filter((app) => app.repoKey === group.key);
        const dependencyOptions = allNames.filter((name) => name.trim() !== "");
        const handledForGroup = new Set(
          [...handledSuggestions]
            .filter((key) => key.startsWith(`${group.key}::`))
            .map((key) => key.slice(group.key.length + 2)),
        );
        return (
          <div key={group.key} className="space-y-4">
            <RepoSuggestions
              appId={appId}
              enabled={suggestionsEnabled}
              githubRepositoryId={group.githubRepositoryId}
              existingAppNames={new Set(groupApps.filter((app) => !isUntouchedStarterApp(app)).map((app) => app.name))}
              handled={handledForGroup}
              onAccept={(suggestion) => onAcceptSuggestion(group.key, suggestion)}
              onAcceptAll={(suggestions) => onAcceptAllSuggestions(group.key, suggestions)}
              onDismiss={(suggestion) => onDismissSuggestion(group.key, suggestion)}
            />

            <section className="border border-border-dim bg-surface-base">
              <div className="flex flex-wrap items-center gap-3 border-b border-border-dim bg-surface-raised px-5 py-4">
                <h2
                  className="truncate font-mono text-sm font-bold uppercase tracking-widest text-text-primary"
                  title={group.label}
                >
                  {group.label}
                </h2>
                <Badge variant="outline">{group.badge}</Badge>
                <Badge variant={groupSaved(group.key) ? "success" : "secondary"}>
                  {groupSaved(group.key) ? "Saved" : "Unsaved"}
                </Badge>
                <Button variant="outline" size="xs" className="ml-auto gap-1" onClick={() => onAddApp(group.key)}>
                  <PlusIcon size={12} weight="bold" />
                  Add app
                </Button>
              </div>
              <div className="space-y-4 p-5">
                {groupApps.length === 0 ? (
                  <p className="text-sm text-text-secondary">
                    No deployable apps mapped yet. Accept a suggestion or add an app.
                  </p>
                ) : (
                  groupApps.map((app) => (
                    <AppCard
                      key={app.id}
                      app={app}
                      issues={issues}
                      dependencyOptions={dependencyOptions.filter((name) => name !== app.name)}
                      onChange={onUpdateApp}
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

/**
 * Repo-introspection suggestions for one repo group. The primary group passes no
 * `githubRepositoryId` (introspects the app's linked repo); each dependency group
 * passes its repo id so detected apps are scoped to that repo.
 */
function RepoSuggestions({
  appId,
  enabled,
  githubRepositoryId,
  existingAppNames,
  handled,
  onAccept,
  onAcceptAll,
  onDismiss,
}: {
  appId: string;
  enabled: boolean;
  githubRepositoryId?: number;
  existingAppNames: Set<string>;
  handled: Set<string>;
  onAccept: (suggestion: SuggestedApp) => void;
  onAcceptAll: (suggestions: SuggestedApp[]) => void;
  onDismiss: (suggestion: SuggestedApp) => void;
}) {
  const { data, isPending } = useRepoSuggestions(appId, enabled, githubRepositoryId);
  return (
    <SuggestionsBanner
      enabled={enabled}
      isPending={isPending}
      data={data}
      existingAppNames={existingAppNames}
      handled={handled}
      onAccept={onAccept}
      onAcceptAll={onAcceptAll}
      onDismiss={onDismiss}
    />
  );
}

/** AI-assisted service suggestions for the services step, inferred from the accepted apps. */
function ServiceSuggestions({
  appId,
  enabled,
  apps,
  existingRecipes,
  handled,
  onAccept,
  onAcceptAll,
  onDismiss,
}: {
  appId: string;
  enabled: boolean;
  apps: Array<{ name: string; path: string }>;
  existingRecipes: Set<string>;
  handled: Set<string>;
  onAccept: (suggestion: SuggestedService) => void;
  onAcceptAll: (suggestions: SuggestedService[]) => void;
  onDismiss: (suggestion: SuggestedService) => void;
}) {
  const { data, isPending } = useSuggestServices(appId, enabled, apps);
  return (
    <ServiceSuggestionsBanner
      enabled={enabled}
      isPending={isPending}
      data={data}
      existingRecipes={existingRecipes}
      handled={handled}
      onAccept={onAccept}
      onAcceptAll={onAcceptAll}
      onDismiss={onDismiss}
    />
  );
}

function isConfigStepEnabled(_step: ConfigStepId): boolean {
  // Every step is a config-editing step now (variables saves with the config),
  // so all are always reachable; deploy readiness is gated in the footer.
  return true;
}

/**
 * Document-level findings (schema/semantic errors, warnings, untouched starter
 * apps) for the authoring steps. Errors block the Save action in the footer;
 * warnings never block. Lives above the footer on the `apps` and `hooks` steps
 * so the disabled reason for Save is always visible next to it.
 */
function ConfigIssuesBanner({
  issues,
  hasUntouchedStarterApps,
  configReadyForSecrets,
}: {
  issues: DraftIssues;
  hasUntouchedStarterApps: boolean;
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
      {hasUntouchedStarterApps ? (
        <div className="border-l-2 border-status-warn bg-status-warn/10 px-4 py-3">
          <p className="font-mono text-2xs uppercase tracking-widest text-status-warn">Config not ready</p>
          <p className="mt-2 text-sm text-text-secondary">
            Accept a repo suggestion or edit the starter app before saving. Starter values are only a guide.
          </p>
        </div>
      ) : undefined}
      {configReadyForSecrets ? (
        <p className="text-sm text-text-secondary">Config saved. Continue to secrets, then deploy.</p>
      ) : undefined}
    </>
  );
}

/**
 * The footer's primary button advances through the steps
 * (`apps → services → variables → hooks`), and on the final `hooks` step it does
 * the real work: `Save config` (persisting the document + secrets in one call)
 * until everything is saved and clean, then `Start deploy`.
 */
function ConfigStepFooter({
  previousStep,
  activeStep,
  hasBlockingIssues,
  isSaving,
  isDeploying,
  canDeploy,
  onSelect,
  onSave,
  onDeploy,
  onAdvanceFromServices,
  onAdvanceFromVariables,
  onAdvanceFromHooks,
}: {
  previousStep: { id: ConfigStepId; label: string } | undefined;
  activeStep: ConfigStepId;
  hasBlockingIssues: boolean;
  isSaving: boolean;
  isDeploying: boolean;
  canDeploy: boolean;
  onSelect: (step: ConfigStepId) => void;
  onSave: () => void;
  onDeploy: () => void;
  onAdvanceFromServices: () => void;
  onAdvanceFromVariables: () => void;
  onAdvanceFromHooks: () => void;
}) {
  const primaryAction = getPrimaryAction();

  return (
    <div className="flex justify-between border-t border-border-dim pt-4">
      {previousStep != null ? (
        <Button variant="outline" className="gap-2" onClick={() => onSelect(previousStep.id)}>
          <ArrowLeftIcon size={14} />
          {previousStep.label}
        </Button>
      ) : (
        <span />
      )}
      <Button variant="accent" className="gap-2" disabled={primaryAction.disabled} onClick={primaryAction.onClick}>
        {primaryAction.icon === "save" ? <FloppyDiskIcon size={14} weight="bold" /> : undefined}
        {primaryAction.label}
        {primaryAction.icon === "next" ? <ArrowRightIcon size={14} /> : undefined}
      </Button>
    </div>
  );

  function getPrimaryAction(): { label: string; onClick: () => void; disabled: boolean; icon: "save" | "next" } {
    if (activeStep === "apps") {
      return {
        label: "Continue to services",
        onClick: () => onSelect("services"),
        disabled: hasBlockingIssues,
        icon: "next",
      };
    }
    if (activeStep === "services") {
      return {
        label: "Continue to variables",
        onClick: () => {
          onAdvanceFromServices();
          onSelect("variables");
        },
        disabled: hasBlockingIssues,
        icon: "next",
      };
    }
    if (activeStep === "variables") {
      return {
        label: "Continue to hooks",
        onClick: () => {
          onAdvanceFromVariables();
          onSelect("hooks");
        },
        disabled: hasBlockingIssues,
        icon: "next",
      };
    }
    // Hooks is the last step: save the config (incl. secrets) first, then deploy.
    if (canDeploy) {
      return {
        label: isDeploying ? "Starting deploy..." : "Start deploy",
        onClick: onDeploy,
        disabled: !canDeploy || isDeploying,
        icon: "next",
      };
    }
    return {
      label: isSaving ? "Saving..." : "Save config",
      onClick: () => {
        onAdvanceFromHooks();
        onSave();
      },
      disabled: hasBlockingIssues || isSaving,
      icon: "save",
    };
  }
}

function addSuggestionsReplacingStarters(
  current: TopologyDraft,
  suggestions: SuggestedApp[],
  repoKey: string,
): TopologyDraft {
  const suggestionDrafts = suggestions.map((suggestion) => appDraftFromSuggestion(suggestion, repoKey));
  return addAppsReplacingStarters(current, repoKey, suggestionDrafts);
}

function addAppsReplacingStarters(current: TopologyDraft, repoKey: string, apps: AppDraft[]): TopologyDraft {
  const existingApps = current.apps.filter((app) => !(app.repoKey === repoKey && isUntouchedStarterApp(app)));
  const existingNames = new Set(existingApps.map((app) => app.name).filter((name) => name.trim() !== ""));
  const newApps = uniqueNewApps(apps, existingNames);

  return {
    ...current,
    apps: [...existingApps, ...newApps],
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

/** Adds a suggested managed service to the draft; a recipe already present is a no-op. */
function addServiceSuggestion(current: TopologyDraft, suggestion: SuggestedService): TopologyDraft {
  if (current.services.some((service) => service.recipe === suggestion.recipe)) return current;
  const service = serviceDraftForRecipe(
    suggestion.recipe,
    current.services.map((existing) => existing.name),
  );
  if (suggestion.version != null) service.version = suggestion.version;
  return { ...current, services: [...current.services, service] };
}

function getConfigStepCompletion({
  draft,
  issues,
  hooksValid,
  hooksAcknowledged,
  servicesAcknowledged,
  variablesAcknowledged,
}: {
  draft: TopologyDraft;
  issues: DraftIssues;
  hooksValid: boolean;
  hooksAcknowledged: boolean;
  servicesAcknowledged: boolean;
  variablesAcknowledged: boolean;
}): Record<ConfigStepId, boolean> {
  const noBlockingDocumentErrors = issues.documentErrors.length === 0;
  const deployableApps = draft.apps.filter((app) => !isUntouchedStarterApp(app));
  const hasStarterApps = draft.apps.some(isUntouchedStarterApp);
  const appsComplete =
    deployableApps.length > 0 &&
    !hasStarterApps &&
    deployableApps.every((app) => {
      const requiredFieldsComplete = app.name.trim() !== "" && app.path.trim() !== "" && app.port.trim() !== "";
      return requiredFieldsComplete && !hasAppFieldErrors(issues, app.id);
    }) &&
    noBlockingDocumentErrors;
  // An empty services list is valid, but the step only reads complete once a
  // service is configured or the user has advanced past it (acknowledgement
  // mirrors hooks) - never before.
  const hasConfiguredServices = draft.services.length > 0;
  const servicesValid = draft.services.every((service) => service.name.trim() !== "" && service.recipe.trim() !== "");
  const servicesComplete = servicesValid && (hasConfiguredServices || servicesAcknowledged) && noBlockingDocumentErrors;

  return {
    apps: appsComplete,
    services: servicesComplete,
    variables: noBlockingDocumentErrors && variablesAcknowledged,
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
