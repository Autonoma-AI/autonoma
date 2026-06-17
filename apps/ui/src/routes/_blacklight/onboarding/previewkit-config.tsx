import { Badge, Button, Skeleton, cn } from "@autonoma/blacklight";
import {
  previewConfigSchema,
  validatePreviewConfigSemantics,
  zodIssuesToConfigIssues,
  type ConfigIssue,
  type SuggestedApp,
} from "@autonoma/types";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { FileCodeIcon } from "@phosphor-icons/react/FileCode";
import { FloppyDiskIcon } from "@phosphor-icons/react/FloppyDisk";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useAuth } from "lib/auth";
import {
  usePreviewkitConfig,
  useRepoSuggestions,
  useSavePreviewkitConfig,
  useTriggerPreviewkitMainDeploy,
  useValidatePreviewkitConfig,
} from "lib/onboarding/onboarding-api";
import { buildOnboardingSearch } from "lib/onboarding/onboarding-search";
import { useApplicationRepositoryFromGitHub } from "lib/query/github.queries";
import { toastManager } from "lib/toast-manager";
import { Suspense, useEffect, useState } from "react";
import { OnboardingPageHeader } from "./-components/onboarding-page-header";
import { AppCard } from "./-components/previewkit/app-card";
import { toPreviewYaml } from "./-components/previewkit/preview-yaml";
import { SecretsSection, type SecretsApp } from "./-components/previewkit/secrets-section";
import { ServicesSection } from "./-components/previewkit/services-section";
import { SuggestionsBanner } from "./-components/previewkit/suggestions-banner";
import {
  PRIMARY_REPO_KEY,
  appDraftFromSuggestion,
  appFieldFromDocumentKey,
  documentsFromDraft,
  draftFromConfig,
  emptyAppDraft,
  emptyDraftIssues,
  fieldIssueKey,
  isUntouchedStarterApp,
  mapIssuesToDraft,
  snapshotDocument,
  type AppDraft,
  type AppDraftField,
  type DraftIssues,
  type TopologyDraft,
} from "./-components/previewkit/topology-draft";
import { YamlPreviewPanel } from "./-components/previewkit/yaml-preview-panel";

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

type ConfigStepId = "apps" | "services" | "save" | "secrets" | "deploy";

const CONFIG_STEPS: Array<{ id: ConfigStepId; label: string; description: string }> = [
  { id: "apps", label: "Repo apps", description: "Entrypoints and paths" },
  { id: "services", label: "Services", description: "Managed dependencies" },
  { id: "save", label: "Save config", description: "Persist revision" },
  { id: "secrets", label: "Secrets", description: "Runtime values" },
  { id: "deploy", label: "Deploy", description: "Start preview" },
];

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
  const { isAdmin } = useAuth();
  const configQuery = usePreviewkitConfig(appId);
  const repositoryQuery = useApplicationRepositoryFromGitHub(appId);
  const suggestionsQuery = useRepoSuggestions(appId, !configQuery.data.saved);
  const saveConfig = useSavePreviewkitConfig();
  const validateConfig = useValidatePreviewkitConfig();
  const deploy = useTriggerPreviewkitMainDeploy();
  const repoName = repositoryQuery.data?.fullName ?? "your linked repository";

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
  const [activeStep, setActiveStep] = useState<ConfigStepId>(() => (focusSection === "secrets" ? "secrets" : "apps"));

  function setDraft(updater: (current: TopologyDraft) => TopologyDraft) {
    setDraftState(updater);
    // Server findings (preflight warnings, save rejections) describe the last
    // submitted document - stale the moment the draft changes.
    setServerIssues(emptyDraftIssues());
  }

  const compiled = documentsFromDraft(draft);
  const clientIssues = validateDraftClientSide(compiled);
  const issues = mergeIssues(clientIssues, serverIssues);
  const hasUntouchedStarterApps = draft.apps.some(isUntouchedStarterApp);
  const hasBlockingIssues = issues.fieldErrors.size > 0 || issues.documentErrors.length > 0 || hasUntouchedStarterApps;

  const groupSaved = (repoKey: string): boolean => {
    const document =
      repoKey === PRIMARY_REPO_KEY
        ? compiled.primary.document
        : compiled.dependencies.find((dependency) => dependency.alias === repoKey)?.document;
    if (document == null) return false;
    return savedSnapshots[repoKey] === snapshotDocument(document);
  };
  const allSaved = [PRIMARY_REPO_KEY, ...draft.repos.map((repo) => repo.name)].every(groupSaved);
  const configReadyForSecrets = allSaved && !hasBlockingIssues;
  const canDeploy = configReadyForSecrets;
  const stepCompletion = getConfigStepCompletion({
    draft,
    issues,
    configSaved: configReadyForSecrets,
    canDeploy,
  });
  const completedStepCount = CONFIG_STEPS.filter((step) => stepCompletion[step.id]).length;

  useEffect(() => {
    if (focusSection === "secrets") setActiveStep(configReadyForSecrets ? "secrets" : "save");
    if (focusSection === "config") setActiveStep("apps");
  }, [configReadyForSecrets, focusSection]);

  useEffect(() => {
    if ((activeStep === "secrets" || activeStep === "deploy") && !configReadyForSecrets) {
      setActiveStep("save");
    }
  }, [activeStep, configReadyForSecrets]);

  function clearFocusParams() {
    void navigate({ to: "/onboarding", replace: true, search: buildOnboardingSearch("previewkit-config", appId) });
  }

  function backToPreviewOptions() {
    void navigate({ to: "/onboarding", search: buildOnboardingSearch("preview-environment", appId) });
  }

  const shouldFocusConfig = (focusSection == null || focusSection === "config") && activeStep === "apps";
  useFocusDeepLink(draft, shouldFocusConfig ? focusApp : undefined, focusField, clearFocusParams);

  function updateApp(id: number, patch: Partial<AppDraft>) {
    setDraft((current) => ({
      ...current,
      apps: current.apps.map((app) =>
        app.id === id
          ? {
              ...app,
              ...patch,
              origin: app.origin === "starter" ? "manual" : (patch.origin ?? app.origin),
            }
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

  function addApp(repoKey: string, prefilled?: AppDraft) {
    setDraft((current) => addAppsReplacingStarters(current, repoKey, [prefilled ?? emptyAppDraft(repoKey)]));
  }

  function removeApp(id: number) {
    setDraft((current) => ({ ...current, apps: current.apps.filter((app) => app.id !== id) }));
  }

  function acceptSuggestion(suggestion: SuggestedApp) {
    setDraft((current) => addSuggestionsReplacingStarters(current, [suggestion], PRIMARY_REPO_KEY));
  }

  function acceptAllSuggestions(suggestions: SuggestedApp[]) {
    setDraft((current) => addSuggestionsReplacingStarters(current, suggestions, PRIMARY_REPO_KEY));
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

    saveConfig.mutate(
      {
        applicationId: appId,
        document: previewConfigSchema.parse(submission.primary.document),
        dependencyDocuments: submission.dependencies.map((dependency) => ({
          repo: dependency.repo,
          document: previewConfigSchema.parse(dependency.document),
        })),
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
          toastManager.add({ type: "success", title: "PreviewKit config saved" });
          setActiveStep("secrets");
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

  const repoGroups: Array<{ key: string; label: string; badge: string }> = [
    { key: PRIMARY_REPO_KEY, label: repoName, badge: "primary repo" },
    ...draft.repos.map((repo) => ({ key: repo.name, label: repo.repo, badge: "dependency" })),
  ];

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

  const yamlDocuments = [
    { label: repoName, yaml: toPreviewYaml(compiled.primary.document) },
    ...compiled.dependencies.map((dependency) => ({
      label: dependency.repo,
      yaml: toPreviewYaml(dependency.document),
    })),
  ];

  // Secrets are stored against the Application that owns each app's config
  // revision: primary-repo apps against this Application, dependency-repo apps
  // against their own (created and linked at save time).
  const secretsApps: SecretsApp[] = configQuery.data.saved
    ? [
        ...configQuery.data.document.apps.map((app) => ({ name: app.name, applicationId: appId })),
        ...configQuery.data.dependencyConfigs.flatMap((dependency) => {
          const ownerApplicationId = dependency.applicationId;
          if (ownerApplicationId == null || dependency.document == null) return [];
          return dependency.document.apps.map((app) => ({ name: app.name, applicationId: ownerApplicationId }));
        }),
      ]
    : [];
  const activeStepIndex = CONFIG_STEPS.findIndex((step) => step.id === activeStep);
  const previousStep = activeStepIndex > 0 ? CONFIG_STEPS[activeStepIndex - 1] : undefined;
  const nextStep = activeStepIndex < CONFIG_STEPS.length - 1 ? CONFIG_STEPS[activeStepIndex + 1] : undefined;

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
          <p className="max-w-3xl">
            Map every deployable app to its repo, path, and entrypoints for{" "}
            <span className="text-text-primary">{repoName}</span>. Managed services come from recipes. The YAML stays
            copyable, but this onboarding deploy reads the saved revision.
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
        configReadyForSecrets={configReadyForSecrets}
        onSelect={(step) => {
          if (!isConfigStepEnabled(step, configReadyForSecrets)) return;
          setActiveStep(step);
        }}
      />

      <div className={cn("grid gap-6", isAdmin ? "xl:grid-cols-[minmax(0,1fr)_minmax(28rem,0.9fr)]" : undefined)}>
        <div className="space-y-6">
          {activeStep === "apps" ? (
            <AppsStep
              suggestionsEnabled={!configQuery.data.saved}
              suggestionsPending={suggestionsQuery.isPending}
              suggestionsData={suggestionsQuery.data}
              draftApps={draft.apps}
              repoGroups={repoGroups}
              issues={issues}
              allNames={allNames}
              referenceTokens={referenceTokens}
              groupSaved={groupSaved}
              onAcceptSuggestion={acceptSuggestion}
              onAcceptAllSuggestions={acceptAllSuggestions}
              onAddApp={addApp}
              onUpdateApp={updateApp}
              onSetPrimaryApp={setPrimaryApp}
              onRemoveApp={removeApp}
            />
          ) : undefined}

          {activeStep === "services" ? (
            <ServicesSection
              services={draft.services}
              onChange={(services) => setDraft((current) => ({ ...current, services }))}
            />
          ) : undefined}

          {activeStep === "secrets" ? (
            <SecretsSection
              apps={secretsApps}
              configSaved={configReadyForSecrets}
              focusSection={focusSection}
              focusApp={focusApp}
              showRecoveryWarning={focusSection === "secrets"}
              onFocusHandled={clearFocusParams}
            />
          ) : undefined}

          {activeStep === "save" ? (
            <SaveConfigStep
              issues={issues}
              hasBlockingIssues={hasBlockingIssues}
              hasUntouchedStarterApps={hasUntouchedStarterApps}
              configReadyForSecrets={configReadyForSecrets}
              isSaving={saveConfig.isPending}
              onSave={save}
            />
          ) : undefined}

          {activeStep === "deploy" ? (
            <DeployStep canDeploy={canDeploy} isDeploying={deploy.isPending} onDeploy={startDeploy} />
          ) : undefined}

          <ConfigStepFooter
            previousStep={previousStep}
            nextStep={nextStep}
            activeStep={activeStep}
            configReadyForSecrets={configReadyForSecrets}
            onSelect={setActiveStep}
          />
        </div>

        {isAdmin ? <YamlPreviewPanel documents={yamlDocuments} /> : undefined}
      </div>
    </>
  );
}

function ConfigStepper({
  activeStep,
  completedStepCount,
  completion,
  configReadyForSecrets,
  onSelect,
}: {
  activeStep: ConfigStepId;
  completedStepCount: number;
  completion: Record<ConfigStepId, boolean>;
  configReadyForSecrets: boolean;
  onSelect: (step: ConfigStepId) => void;
}) {
  return (
    <section className="mb-6 border border-border-dim bg-surface-base">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-dim bg-surface-raised px-5 py-3">
        <h2 className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">PreviewKit config</h2>
        <span className="font-mono text-2xs uppercase tracking-widest text-primary-ink">
          {completedStepCount}/{CONFIG_STEPS.length} complete
        </span>
      </div>
      <div className="grid gap-px bg-border-dim md:grid-cols-5">
        {CONFIG_STEPS.map((step, index) => {
          const active = step.id === activeStep;
          const complete = completion[step.id];
          const enabled = isConfigStepEnabled(step.id, configReadyForSecrets);
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
                {complete ? <CheckIcon size={12} weight="bold" /> : index + 1}
              </span>
              <span className="min-w-0">
                <span className={cn("block text-sm font-medium", active ? "text-text-primary" : "text-text-secondary")}>
                  {step.label}
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
  suggestionsEnabled,
  suggestionsPending,
  suggestionsData,
  draftApps,
  repoGroups,
  issues,
  allNames,
  referenceTokens,
  groupSaved,
  onAcceptSuggestion,
  onAcceptAllSuggestions,
  onAddApp,
  onUpdateApp,
  onSetPrimaryApp,
  onRemoveApp,
}: {
  suggestionsEnabled: boolean;
  suggestionsPending: boolean;
  suggestionsData: ReturnType<typeof useRepoSuggestions>["data"];
  draftApps: AppDraft[];
  repoGroups: Array<{ key: string; label: string; badge: string }>;
  issues: DraftIssues;
  allNames: string[];
  referenceTokens: string[];
  groupSaved: (repoKey: string) => boolean;
  onAcceptSuggestion: (suggestion: SuggestedApp) => void;
  onAcceptAllSuggestions: (suggestions: SuggestedApp[]) => void;
  onAddApp: (repoKey: string, prefilled?: AppDraft) => void;
  onUpdateApp: (id: number, patch: Partial<AppDraft>) => void;
  onSetPrimaryApp: (id: number) => void;
  onRemoveApp: (id: number) => void;
}) {
  return (
    <>
      <SuggestionsBanner
        enabled={suggestionsEnabled}
        isPending={suggestionsPending}
        data={suggestionsData}
        existingAppNames={new Set(draftApps.filter((app) => !isUntouchedStarterApp(app)).map((app) => app.name))}
        onAccept={onAcceptSuggestion}
        onAcceptAll={onAcceptAllSuggestions}
      />

      {repoGroups.map((group) => {
        const groupApps = draftApps.filter((app) => app.repoKey === group.key);
        const dependencyOptions = allNames.filter((name) => name.trim() !== "");
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
                    referenceTokens={referenceTokens}
                    onChange={onUpdateApp}
                    onSetPrimary={onSetPrimaryApp}
                    onRemove={onRemoveApp}
                  />
                ))
              )}
            </div>
          </section>
        );
      })}
    </>
  );
}

function isConfigStepEnabled(step: ConfigStepId, configReadyForSecrets: boolean): boolean {
  if (step === "secrets" || step === "deploy") return configReadyForSecrets;
  return true;
}

function SaveConfigStep({
  issues,
  hasBlockingIssues,
  hasUntouchedStarterApps,
  configReadyForSecrets,
  isSaving,
  onSave,
}: {
  issues: DraftIssues;
  hasBlockingIssues: boolean;
  hasUntouchedStarterApps: boolean;
  configReadyForSecrets: boolean;
  isSaving: boolean;
  onSave: () => void;
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

      <section className="border border-border-dim bg-surface-base p-5">
        <div className="flex flex-wrap gap-3">
          <Button
            variant="accent"
            className="gap-2 px-6 py-3"
            onClick={onSave}
            disabled={hasBlockingIssues || isSaving}
          >
            <FloppyDiskIcon size={16} weight="bold" />
            {isSaving ? "Saving..." : configReadyForSecrets ? "Save changes" : "Save config"}
          </Button>
        </div>
        {configReadyForSecrets ? (
          <p className="mt-4 text-sm text-text-secondary">Config is saved. Continue to secrets before deploying.</p>
        ) : (
          <p className="mt-4 text-sm text-text-secondary">
            Save a valid config revision before adding secrets. Secrets are scoped to the apps in the saved revision.
          </p>
        )}
      </section>
    </>
  );
}

function DeployStep({
  canDeploy,
  isDeploying,
  onDeploy,
}: {
  canDeploy: boolean;
  isDeploying: boolean;
  onDeploy: () => void;
}) {
  return (
    <section className="border border-border-dim bg-surface-base p-5">
      <div>
        <h2 className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">Deploy saved config</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-text-secondary">
          Deploy starts from the saved PreviewKit revision and uses any secrets you added for those apps.
        </p>
      </div>
      <Button variant="accent" className="mt-5 gap-2 px-6 py-3" onClick={onDeploy} disabled={!canDeploy || isDeploying}>
        {isDeploying ? "Starting deploy..." : "Start main deploy"}
        <ArrowRightIcon size={16} weight="bold" />
      </Button>
      {!canDeploy ? <p className="mt-4 text-sm text-text-secondary">Save the config before deploying.</p> : undefined}
    </section>
  );
}

function ConfigStepFooter({
  previousStep,
  nextStep,
  activeStep,
  configReadyForSecrets,
  onSelect,
}: {
  previousStep: { id: ConfigStepId; label: string } | undefined;
  nextStep: { id: ConfigStepId; label: string } | undefined;
  activeStep: ConfigStepId;
  configReadyForSecrets: boolean;
  onSelect: (step: ConfigStepId) => void;
}) {
  if (activeStep === "deploy") {
    return (
      <div className="flex justify-start border-t border-border-dim pt-4">
        {previousStep != null ? (
          <Button variant="outline" className="gap-2" onClick={() => onSelect(previousStep.id)}>
            <ArrowLeftIcon size={14} />
            {previousStep.label}
          </Button>
        ) : undefined}
      </div>
    );
  }

  const canGoNext = nextStep != null && isConfigStepEnabled(nextStep.id, configReadyForSecrets);

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
      {nextStep != null ? (
        <Button variant="accent" className="gap-2" disabled={!canGoNext} onClick={() => onSelect(nextStep.id)}>
          {nextStep.label}
          <ArrowRightIcon size={14} />
        </Button>
      ) : undefined}
    </div>
  );
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

function getConfigStepCompletion({
  draft,
  issues,
  configSaved,
  canDeploy,
}: {
  draft: TopologyDraft;
  issues: DraftIssues;
  configSaved: boolean;
  canDeploy: boolean;
}): Record<ConfigStepId, boolean> {
  const noBlockingDocumentErrors = issues.documentErrors.length === 0;
  const deployableApps = draft.apps.filter((app) => !isUntouchedStarterApp(app));
  const hasStarterApps = draft.apps.some(isUntouchedStarterApp);
  const appsComplete =
    deployableApps.length > 0 &&
    !hasStarterApps &&
    deployableApps.every((app) => {
      const requiredFieldsComplete =
        app.name.trim() !== "" && app.path.trim() !== "" && app.port.trim() !== "" && app.replicas.trim() !== "";
      return requiredFieldsComplete && !hasAppFieldErrors(issues, app.id);
    }) &&
    noBlockingDocumentErrors;
  const servicesComplete =
    (draft.services.length === 0 ||
      draft.services.every((service) => service.name.trim() !== "" && service.recipe.trim() !== "")) &&
    noBlockingDocumentErrors;

  return {
    apps: appsComplete,
    services: servicesComplete,
    save: configSaved,
    secrets: configSaved,
    deploy: canDeploy,
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
    "buildArgs",
    "buildSecrets",
    "replicas",
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
