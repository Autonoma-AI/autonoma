import { Badge } from "@autonoma/blacklight";
import type { SuggestedEnvVar } from "@autonoma/types";
import { useSuggestEnvVars } from "lib/onboarding/onboarding-api";
import { AppEnvEditor } from "./app-env-editor";
import { EnvSuggestionsBanner, type EnvOwnerKind, envSuggestionKey } from "./env-suggestions-banner";
import {
  PRIMARY_REPO_KEY,
  type AppDraft,
  type DraftIssues,
  type EnvRowDraft,
  type ServiceDraft,
  envRowsFromSuggestions,
  fieldIssueKey,
  isUntouchedStarterApp,
  sortEnvRows,
} from "./topology-draft";

interface EnvStepProps {
  appId: string;
  /** Suggestions load only on a never-saved config, matching the app/service banners. */
  suggestionsEnabled: boolean;
  apps: AppDraft[];
  services: ServiceDraft[];
  issues: DraftIssues;
  /** `{{name.field}}` tokens (services + apps), for the insert-reference menu. */
  referenceTokens: string[];
  /** Accepted/dismissed suggestion keys, held by the parent so they survive this step unmounting. */
  handled: Set<string>;
  onHandledChange: (update: (current: Set<string>) => Set<string>) => void;
  onUpdateApp: (id: number, patch: Partial<AppDraft>) => void;
  onUpdateService: (id: number, patch: Partial<ServiceDraft>) => void;
}

export function EnvStep({
  appId,
  suggestionsEnabled,
  apps,
  services,
  issues,
  referenceTokens,
  handled,
  onHandledChange,
  onUpdateApp,
  onUpdateService,
}: EnvStepProps) {
  const deployableApps = apps.filter((app) => !isUntouchedStarterApp(app));
  const namedServices = services.filter((service) => service.name.trim() !== "");

  const suggestionApps = deployableApps
    .filter((app) => app.repoKey === PRIMARY_REPO_KEY && app.name.trim() !== "")
    .map((app) => ({
      name: app.name.trim(),
      path: app.path.trim() === "" ? "." : app.path.trim(),
      primary: app.primary,
    }));
  const suggestionServices = namedServices.map((service) => ({ name: service.name.trim(), recipe: service.recipe }));
  const { data, isPending } = useSuggestEnvVars(appId, suggestionsEnabled, suggestionApps, suggestionServices);

  function ownerEnvKeys(kind: EnvOwnerKind, name: string): Set<string> {
    const owner =
      kind === "app"
        ? deployableApps.find((app) => app.name === name)
        : namedServices.find((service) => service.name === name);
    return new Set((owner?.env ?? []).map((row) => row.key.trim()).filter((key) => key !== ""));
  }

  function appendEnvRows(kind: EnvOwnerKind, ownerName: string, suggestions: SuggestedEnvVar[]) {
    onHandledChange(
      (current) => new Set([...current, ...suggestions.map((s) => envSuggestionKey(kind, ownerName, s.key))]),
    );
    if (kind === "app") {
      const app = deployableApps.find((candidate) => candidate.name === ownerName);
      if (app == null) return;
      const rows = envRowsFromSuggestions(app.env, suggestions, app.repoKey === PRIMARY_REPO_KEY);
      if (rows.length > 0) onUpdateApp(app.id, { env: sortEnvRows([...app.env, ...rows]) });
      return;
    }
    const service = namedServices.find((candidate) => candidate.name === ownerName);
    if (service == null) return;
    const rows = envRowsFromSuggestions(service.env, suggestions, false);
    if (rows.length > 0) onUpdateService(service.id, { env: sortEnvRows([...service.env, ...rows]) });
  }

  function acceptEnvVar(kind: EnvOwnerKind, ownerName: string, suggestion: SuggestedEnvVar) {
    appendEnvRows(kind, ownerName, [suggestion]);
  }

  function acceptAllEnvVars(kind: EnvOwnerKind, ownerName: string, suggestions: SuggestedEnvVar[]) {
    appendEnvRows(kind, ownerName, suggestions);
  }

  function dismissEnvVar(kind: EnvOwnerKind, ownerName: string, suggestion: SuggestedEnvVar) {
    onHandledChange((current) => new Set([...current, envSuggestionKey(kind, ownerName, suggestion.key)]));
  }

  return (
    <div className="space-y-6">
      <EnvSuggestionsBanner
        enabled={suggestionsEnabled}
        isPending={isPending}
        data={data}
        ownerEnvKeys={ownerEnvKeys}
        handled={handled}
        onAccept={acceptEnvVar}
        onAcceptAll={acceptAllEnvVars}
        onDismiss={dismissEnvVar}
      />

      <section className="border border-border-dim bg-surface-base">
        <div className="border-b border-border-dim bg-surface-raised px-5 py-4">
          <h2 className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">App env</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Runtime variables per app. Flag credentials as secrets - they are stored encrypted and kept out of the
            config. Reference a service with a <span className="font-mono">{"{{name.url}}"}</span> token.
          </p>
        </div>
        <div className="space-y-5 p-5">
          {deployableApps.length === 0 ? (
            <p className="text-sm text-text-secondary">Add an app first, then set its environment variables here.</p>
          ) : (
            deployableApps.map((app) => (
              <div key={app.id} className="border border-border-dim bg-surface-base p-4">
                <div className="mb-3 flex items-center gap-2">
                  <span className="font-mono text-sm font-bold text-text-primary">
                    {app.name.trim() === "" ? "new app" : app.name}
                  </span>
                  {app.primary ? <Badge variant="secondary">primary</Badge> : undefined}
                  {app.repoKey !== PRIMARY_REPO_KEY ? <Badge variant="outline">{app.repoKey}</Badge> : undefined}
                </div>
                <AppEnvEditor
                  appDraftId={app.id}
                  rows={app.env}
                  referenceTokens={referenceTokens}
                  showBuiltins
                  showManagedSecrets
                  enableSecrets={app.repoKey === PRIMARY_REPO_KEY}
                  error={firstIssue(issues.fieldErrors, app.id)}
                  warning={firstIssue(issues.fieldWarnings, app.id)}
                  onChange={(env: EnvRowDraft[]) => onUpdateApp(app.id, { env })}
                />
              </div>
            ))
          )}
        </div>
      </section>

      {namedServices.length > 0 ? (
        <section className="border border-border-dim bg-surface-base">
          <div className="border-b border-border-dim bg-surface-raised px-5 py-4">
            <h2 className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">Service env</h2>
            <p className="mt-1 text-sm text-text-secondary">
              Plaintext configuration passed to each managed service container.
            </p>
          </div>
          <div className="space-y-5 p-5">
            {namedServices.map((service) => (
              <div key={service.id} className="border border-border-dim bg-surface-base p-4">
                <div className="mb-3 flex items-center gap-2">
                  <span className="font-mono text-sm font-bold text-text-primary">{service.name}</span>
                  <Badge variant="outline">{service.recipe}</Badge>
                </div>
                <AppEnvEditor
                  appDraftId={service.id}
                  rows={service.env}
                  referenceTokens={referenceTokens}
                  title="Service env"
                  addLabel="Add env"
                  emptyLabel="No service environment variables."
                  onChange={(env: EnvRowDraft[]) => onUpdateService(service.id, { env })}
                />
              </div>
            ))}
          </div>
        </section>
      ) : undefined}
    </div>
  );
}

function firstIssue(bucket: Map<string, string[]>, draftId: number): string | undefined {
  return bucket.get(fieldIssueKey(draftId, "env"))?.[0];
}
