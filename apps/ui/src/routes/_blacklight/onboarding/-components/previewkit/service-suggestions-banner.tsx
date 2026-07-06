import { Badge, Button, Skeleton } from "@autonoma/blacklight";
import type { SuggestServicesResult, SuggestedService } from "@autonoma/types";
import { SparkleIcon } from "@phosphor-icons/react/Sparkle";

interface ServiceSuggestionsBannerProps {
  /** Suggestions only load (and render) when the config has never been saved. */
  enabled: boolean;
  isPending: boolean;
  data?: SuggestServicesResult;
  /** Recipes already configured in the draft - a matching suggestion is hidden (one instance per store). */
  existingRecipes: Set<string>;
  /** Keys of suggestions already accepted or dismissed, tracked by {@link serviceSuggestionKey}. */
  handled: Set<string>;
  onAccept: (suggestion: SuggestedService) => void;
  onAcceptAll: (suggestions: SuggestedService[]) => void;
  onDismiss: (suggestion: SuggestedService) => void;
}

export function ServiceSuggestionsBanner({
  enabled,
  isPending,
  data,
  existingRecipes,
  handled,
  onAccept,
  onAcceptAll,
  onDismiss,
}: ServiceSuggestionsBannerProps) {
  if (!enabled) return undefined;

  if (isPending) {
    return <Skeleton className="h-10 w-full" />;
  }

  if (data == null || data.status !== "ok") return undefined;

  const visible = data.services.filter(
    (suggestion) => !handled.has(serviceSuggestionKey(suggestion)) && !existingRecipes.has(suggestion.recipe),
  );
  if (visible.length === 0) return undefined;

  return (
    <section className="border border-primary-ink/40 bg-primary-ink/5 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <SparkleIcon size={18} weight="duotone" className="text-primary-ink" />
        <p className="text-sm text-text-primary">
          Based on your apps, we suggest {visible.length} managed {visible.length === 1 ? "service" : "services"}.
          Accept to add, or dismiss and configure manually.
        </p>
        {visible.length > 1 ? (
          <Button variant="outline" size="xs" className="ml-auto" onClick={() => onAcceptAll(visible)}>
            Accept all
          </Button>
        ) : undefined}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {visible.map((suggestion) => (
          <div key={serviceSuggestionKey(suggestion)} className="border border-border-dim bg-surface-base p-4">
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-bold text-text-primary">{suggestion.name}</span>
              <Badge variant="outline">{suggestion.recipe}</Badge>
              <Badge variant={confidenceVariant(suggestion.confidence)}>{suggestion.confidence}</Badge>
            </div>
            {suggestion.version != null ? (
              <p className="mt-1 font-mono text-2xs text-text-secondary">version {suggestion.version}</p>
            ) : undefined}
            {suggestion.evidence.length > 0 ? (
              <p className="mt-2 truncate text-2xs text-text-secondary" title={suggestion.evidence.join(" · ")}>
                {suggestion.evidence.join(" · ")}
              </p>
            ) : undefined}
            <div className="mt-3 flex gap-2">
              <Button variant="accent" size="xs" onClick={() => onAccept(suggestion)}>
                Accept
              </Button>
              <Button variant="ghost" size="xs" onClick={() => onDismiss(suggestion)}>
                Dismiss
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Stable identity for a service suggestion - derived from recipe + suggested name. */
export function serviceSuggestionKey(suggestion: SuggestedService): string {
  return `${suggestion.recipe}:${suggestion.name}`;
}

function confidenceVariant(confidence: SuggestedService["confidence"]) {
  if (confidence === "high") return "success" as const;
  if (confidence === "medium") return "secondary" as const;
  return "outline" as const;
}
