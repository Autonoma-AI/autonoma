import { Badge, Button, Skeleton } from "@autonoma/blacklight";
import type { SuggestEnvVarsResult, SuggestedEnvGroup, SuggestedEnvVar } from "@autonoma/types";
import { LockIcon } from "@phosphor-icons/react/Lock";
import { SparkleIcon } from "@phosphor-icons/react/Sparkle";

/** Which kind of owner a suggested env group belongs to. */
export type EnvOwnerKind = "app" | "service";

interface EnvSuggestionsBannerProps {
  /** Suggestions only load (and render) when the config has never been saved. */
  enabled: boolean;
  isPending: boolean;
  data?: SuggestEnvVarsResult;
  /** Env keys already present on an owner - a matching suggestion is hidden. */
  ownerEnvKeys: (kind: EnvOwnerKind, name: string) => Set<string>;
  /** Keys of suggestions already accepted or dismissed, tracked by {@link envSuggestionKey}. */
  handled: Set<string>;
  onAccept: (kind: EnvOwnerKind, ownerName: string, suggestion: SuggestedEnvVar) => void;
  onAcceptAll: (kind: EnvOwnerKind, ownerName: string, suggestions: SuggestedEnvVar[]) => void;
  onDismiss: (kind: EnvOwnerKind, ownerName: string, suggestion: SuggestedEnvVar) => void;
}

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

  const groups = [
    ...data.apps.map((group) => ({ kind: "app" as const, group })),
    ...data.services.map((group) => ({ kind: "service" as const, group })),
  ]
    .map((entry) => ({ ...entry, visible: visibleVars(entry.kind, entry.group, ownerEnvKeys, handled) }))
    .filter((entry) => entry.visible.length > 0);

  if (groups.length === 0) return undefined;

  const total = groups.reduce((sum, entry) => sum + entry.visible.length, 0);

  return (
    <section className="border border-primary-ink/40 bg-primary-ink/5 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <SparkleIcon size={18} weight="duotone" className="text-primary-ink" />
        <p className="text-sm text-text-primary">
          We analyzed your repo and suggest {total} environment {total === 1 ? "variable" : "variables"}. Secrets are
          flagged and connections to services are pre-wired.
        </p>
      </div>

      <div className="mt-4 space-y-4">
        {groups.map((entry) => (
          <div key={`${entry.kind}:${entry.group.name}`} className="border border-border-dim bg-surface-base p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-bold text-text-primary">{entry.group.name}</span>
              <Badge variant="outline">{entry.kind}</Badge>
              {entry.visible.length > 1 ? (
                <Button
                  variant="outline"
                  size="xs"
                  className="ml-auto"
                  onClick={() => onAcceptAll(entry.kind, entry.group.name, entry.visible)}
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
                  onAccept={() => onAccept(entry.kind, entry.group.name, suggestion)}
                  onDismiss={() => onDismiss(entry.kind, entry.group.name, suggestion)}
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
  const hint = suggestion.reference ?? (suggestion.value !== "" ? suggestion.value : undefined);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-sm text-text-primary">{suggestion.key}</span>
          {suggestion.sensitive ? (
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
  kind: EnvOwnerKind,
  group: SuggestedEnvGroup,
  ownerEnvKeys: (kind: EnvOwnerKind, name: string) => Set<string>,
  handled: Set<string>,
): SuggestedEnvVar[] {
  const existing = ownerEnvKeys(kind, group.name);
  return group.vars.filter(
    (suggestion) => !existing.has(suggestion.key) && !handled.has(envSuggestionKey(kind, group.name, suggestion.key)),
  );
}

/** Stable identity for an env suggestion - owner kind + owner name + variable key. */
export function envSuggestionKey(kind: EnvOwnerKind, ownerName: string, key: string): string {
  return `${kind}:${ownerName}:${key}`;
}
