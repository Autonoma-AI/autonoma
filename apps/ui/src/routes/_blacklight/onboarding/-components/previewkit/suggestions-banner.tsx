import { Badge, Button, Skeleton } from "@autonoma/blacklight";
import type { RepoIntrospection, SuggestedApp } from "@autonoma/types";
import { SparkleIcon } from "@phosphor-icons/react/Sparkle";
import { useState } from "react";

interface SuggestionsBannerProps {
  /** Suggestions only load (and render) when the config has never been saved. */
  enabled: boolean;
  isPending: boolean;
  data?: RepoIntrospection;
  /** App names already present in the draft - matching suggestions are hidden. */
  existingAppNames: Set<string>;
  onAccept: (suggestion: SuggestedApp) => void;
  onAcceptAll: (suggestions: SuggestedApp[]) => void;
}

/**
 * Repo-introspection suggestions shown above the apps section on first visit.
 * Suggestions are hints, never facts: each card can be accepted, edited after
 * accepting, or dismissed, and any introspection failure renders nothing so
 * manual setup is unaffected.
 */
export function SuggestionsBanner({
  enabled,
  isPending,
  data,
  existingAppNames,
  onAccept,
  onAcceptAll,
}: SuggestionsBannerProps) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  if (!enabled) return undefined;

  if (isPending) {
    return <Skeleton className="h-10 w-full" />;
  }

  if (data == null || data.status !== "ok") return undefined;

  const visible = data.apps.filter(
    (suggestion) => !dismissed.has(suggestionKey(suggestion)) && !existingAppNames.has(suggestion.name),
  );
  if (visible.length === 0) return undefined;

  function dismiss(suggestion: SuggestedApp) {
    setDismissed((current) => new Set([...current, suggestionKey(suggestion)]));
  }

  return (
    <section className="border border-primary-ink/40 bg-primary-ink/5 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <SparkleIcon size={18} weight="duotone" className="text-primary-ink" />
        <p className="text-sm text-text-primary">
          We scanned <span className="font-mono">{data.repo?.fullName ?? "your repo"}</span> and found {visible.length}{" "}
          likely {visible.length === 1 ? "app" : "apps"}. Accept one to replace the starter, or dismiss it and configure
          manually.
        </p>
        <span className="font-mono text-2xs uppercase tracking-widest text-text-secondary">suggestions, not facts</span>
        {visible.length > 1 ? (
          <Button variant="outline" size="xs" className="ml-auto" onClick={() => onAcceptAll(visible)}>
            Accept all
          </Button>
        ) : undefined}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {visible.map((suggestion) => (
          <div key={suggestionKey(suggestion)} className="border border-border-dim bg-surface-base p-4">
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-bold text-text-primary">{suggestion.name}</span>
              <Badge variant={confidenceVariant(suggestion.confidence)}>{suggestion.confidence}</Badge>
            </div>
            <p className="mt-1 font-mono text-2xs text-text-secondary">
              {suggestion.path}
              {suggestion.port != null ? ` · :${suggestion.port}` : ""}
              {suggestion.dockerfile != null ? " · Dockerfile" : ""}
            </p>
            {suggestion.evidence.length > 0 ? (
              <p className="mt-2 truncate text-2xs text-text-secondary" title={suggestion.evidence.join(" · ")}>
                {suggestion.evidence.join(" · ")}
              </p>
            ) : undefined}
            <div className="mt-3 flex gap-2">
              <Button variant="accent" size="xs" onClick={() => onAccept(suggestion)}>
                Accept
              </Button>
              <Button variant="ghost" size="xs" onClick={() => dismiss(suggestion)}>
                Dismiss
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function suggestionKey(suggestion: SuggestedApp): string {
  return `${suggestion.name}:${suggestion.path}`;
}

function confidenceVariant(confidence: SuggestedApp["confidence"]) {
  if (confidence === "high") return "success" as const;
  if (confidence === "medium") return "secondary" as const;
  return "outline" as const;
}
