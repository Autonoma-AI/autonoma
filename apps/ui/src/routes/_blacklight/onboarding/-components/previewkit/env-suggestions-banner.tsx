import { Badge, Button, Skeleton } from "@autonoma/blacklight";
import type { SuggestEnvVarsResult, SuggestedEnvGroup, SuggestedEnvVar } from "@autonoma/types";
import { LockIcon } from "@phosphor-icons/react/Lock";
import { PlugsConnectedIcon } from "@phosphor-icons/react/PlugsConnected";
import { SparkleIcon } from "@phosphor-icons/react/Sparkle";

interface EnvSuggestionsBannerProps {
  /** Suggestions only load (and render) when the config has never been saved. */
  enabled: boolean;
  isPending: boolean;
  data?: SuggestEnvVarsResult;
  /** Variable keys already present on an app - a matching suggestion is hidden. */
  ownerEnvKeys: (appName: string) => Set<string>;
  /** Keys of suggestions already accepted or dismissed, tracked by {@link envSuggestionKey}. */
  handled: Set<string>;
  onAccept: (appName: string, suggestion: SuggestedEnvVar) => void;
  onAcceptAll: (appName: string, suggestions: SuggestedEnvVar[]) => void;
  onDismiss: (appName: string, suggestion: SuggestedEnvVar) => void;
}

/**
 * AI-detected variables for each app, offered before the user has saved. Every
 * accepted suggestion becomes a row in that app's variable list - a secret when
 * flagged sensitive, a connection when it carries a `{{name.property}}`
 * reference. Service-scoped suggestions are not shown: services no longer hold
 * their own env, so there is nowhere to apply them.
 */
export function EnvSuggestionsBanner({
  enabled,
  isPending,
  data,
  ownerEnvKeys,
  handled,
  onAccept,
  onAcceptAll,
  onDismiss,
}: EnvSuggestionsBannerProps) {
  if (!enabled) return undefined;

  if (isPending) {
    return <Skeleton className="h-10 w-full" />;
  }

  if (data == null || data.status !== "ok") return undefined;

  const groups = data.apps
    .map((group) => ({ group, visible: visibleVars(group, ownerEnvKeys, handled) }))
    .filter((entry) => entry.visible.length > 0);

  if (groups.length === 0) return undefined;

  const total = groups.reduce((sum, entry) => sum + entry.visible.length, 0);

  return (
    <section className="border border-primary-ink/40 bg-primary-ink/5 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <SparkleIcon size={18} weight="duotone" className="text-primary-ink" />
        <p className="text-sm text-text-primary">
          We analyzed your repo and suggest {total} {total === 1 ? "variable" : "variables"}. Secrets are flagged and
          connections to services are pre-wired.
        </p>
      </div>

      <div className="mt-4 space-y-4">
        {groups.map((entry) => (
          <div key={entry.group.name} className="border border-border-dim bg-surface-base p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-bold text-text-primary">{entry.group.name}</span>
              <Badge variant="outline">app</Badge>
              {entry.visible.length > 1 ? (
                <Button
                  variant="outline"
                  size="xs"
                  className="ml-auto"
                  onClick={() => onAcceptAll(entry.group.name, entry.visible)}
                >
                  Accept all
                </Button>
              ) : undefined}
            </div>
            <div className="mt-3 space-y-2">
              {entry.visible.map((suggestion) => (
                <EnvSuggestionRow
                  key={suggestion.key}
                  suggestion={suggestion}
                  onAccept={() => onAccept(entry.group.name, suggestion)}
                  onDismiss={() => onDismiss(entry.group.name, suggestion)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function EnvSuggestionRow({
  suggestion,
  onAccept,
  onDismiss,
}: {
  suggestion: SuggestedEnvVar;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const isConnection = suggestion.reference != null && suggestion.reference !== "";
  const hint = suggestion.reference ?? (suggestion.value !== "" ? suggestion.value : undefined);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-sm text-text-primary">{suggestion.key}</span>
          {isConnection ? (
            <Badge variant="outline" className="gap-1">
              <PlugsConnectedIcon size={11} weight="fill" />
              connection
            </Badge>
          ) : suggestion.sensitive ? (
            <Badge variant="warn" className="gap-1">
              <LockIcon size={11} weight="fill" />
              secret
            </Badge>
          ) : undefined}
        </div>
        {hint != null ? <p className="truncate font-mono text-2xs text-text-secondary">{hint}</p> : undefined}
        {suggestion.description != null ? (
          <p className="mt-0.5 truncate text-2xs text-text-secondary" title={suggestion.description}>
            {suggestion.description}
          </p>
        ) : undefined}
      </div>
      <div className="flex gap-2">
        <Button variant="accent" size="xs" onClick={onAccept}>
          Accept
        </Button>
        <Button variant="ghost" size="xs" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

function visibleVars(
  group: SuggestedEnvGroup,
  ownerEnvKeys: (appName: string) => Set<string>,
  handled: Set<string>,
): SuggestedEnvVar[] {
  const existing = ownerEnvKeys(group.name);
  return group.vars.filter(
    (suggestion) => !existing.has(suggestion.key) && !handled.has(envSuggestionKey(group.name, suggestion.key)),
  );
}

/** Stable identity for an env suggestion - app name + variable key. */
export function envSuggestionKey(appName: string, key: string): string {
  return `${appName}:${key}`;
}
