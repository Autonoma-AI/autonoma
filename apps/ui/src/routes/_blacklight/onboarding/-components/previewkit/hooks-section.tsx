import { Button, Input, Label } from "@autonoma/blacklight";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { nextDraftId, type HookDraft, type HookGroup, type HooksDraft } from "./topology-draft";

interface HooksSectionProps {
  hooks: HooksDraft;
  /** Declared app names, offered as a non-blocking autocomplete for the free-text `app` field. */
  appNames: string[];
  /** Per-row validation messages keyed `${hookId}:${"app" | "command"}` (see `hookFieldErrors`). */
  errors: Map<string, string[]>;
  onChange: (hooks: HooksDraft) => void;
}

const HOOK_GROUPS: Array<{ key: HookGroup; label: string; description: string }> = [
  { key: "pre_deploy", label: "Pre-deploy", description: "Run before apps start - e.g. database migrations" },
  { key: "post_deploy", label: "Post-deploy", description: "Run after apps are ready - e.g. seed data" },
];

/**
 * Authors the config document's lifecycle hooks. Each row maps an `app` to a
 * `command`; every hook runs as a one-off Kubernetes Job built from the target
 * app's image. The `app` field is free-text; invalid hooks (missing/unknown app,
 * missing command) are flagged inline from `errors` and block saving.
 */
export function HooksSection({ hooks, appNames, errors, onChange }: HooksSectionProps) {
  function updateGroup(group: HookGroup, steps: HookDraft[]) {
    onChange({ ...hooks, [group]: steps });
  }

  return (
    <section className="border border-border-dim bg-surface-base">
      <div className="flex items-center justify-between border-b border-border-dim bg-surface-raised px-5 py-4">
        <h3 className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">Deploy hooks</h3>
        <span className="font-mono text-2xs text-text-secondary">commands run around each deploy</span>
      </div>
      <datalist id="pk-hook-app-options">
        {appNames.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <div className="space-y-6 p-5">
        {HOOK_GROUPS.map((group) => (
          <HookGroupEditor
            key={group.key}
            label={group.label}
            description={group.description}
            steps={hooks[group.key]}
            errors={errors}
            onChange={(steps) => updateGroup(group.key, steps)}
          />
        ))}
      </div>
    </section>
  );
}

function HookGroupEditor({
  label,
  description,
  steps,
  errors,
  onChange,
}: {
  label: string;
  description: string;
  steps: HookDraft[];
  errors: Map<string, string[]>;
  onChange: (steps: HookDraft[]) => void;
}) {
  function updateStep(id: number, patch: Partial<HookDraft>) {
    onChange(steps.map((step) => (step.id === id ? { ...step, ...patch } : step)));
  }

  function removeStep(id: number) {
    onChange(steps.filter((step) => step.id !== id));
  }

  function addStep() {
    onChange([...steps, { id: nextDraftId(), app: "", command: "" }]);
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <p className="font-mono text-2xs uppercase tracking-widest text-text-primary">{label}</p>
          <p className="mt-1 text-2xs text-text-secondary">{description}</p>
        </div>
        <Button variant="ghost" size="xs" className="gap-1" onClick={addStep}>
          <PlusIcon size={12} weight="bold" />
          Add hook
        </Button>
      </div>
      {steps.length === 0 ? (
        <p className="mt-2 text-sm text-text-secondary">No {label.toLowerCase()} hooks.</p>
      ) : (
        <div className="mt-3 space-y-2">
          {steps.map((step) => {
            const appError = errors.get(`${step.id}:app`)?.[0];
            const commandError = errors.get(`${step.id}:command`)?.[0];
            return (
              <div
                key={step.id}
                className="grid grid-cols-[minmax(7rem,0.5fr)_minmax(10rem,1fr)_auto] items-start gap-2"
              >
                <div>
                  <Label htmlFor={`pk-hook-${step.id}-app`}>App</Label>
                  <Input
                    id={`pk-hook-${step.id}-app`}
                    list="pk-hook-app-options"
                    value={step.app}
                    onChange={(event) => updateStep(step.id, { app: event.target.value })}
                    placeholder="api"
                    aria-invalid={appError != null}
                    className="mt-1 font-mono"
                  />
                  {appError != null ? <p className="mt-1 text-2xs text-status-critical">{appError}</p> : undefined}
                </div>
                <div>
                  <Label htmlFor={`pk-hook-${step.id}-command`}>Command</Label>
                  <Input
                    id={`pk-hook-${step.id}-command`}
                    value={step.command}
                    onChange={(event) => updateStep(step.id, { command: event.target.value })}
                    placeholder="npx prisma migrate deploy"
                    aria-invalid={commandError != null}
                    className="mt-1 font-mono"
                  />
                  {commandError != null ? (
                    <p className="mt-1 text-2xs text-status-critical">{commandError}</p>
                  ) : undefined}
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title="Remove hook"
                  className="mt-6"
                  onClick={() => removeStep(step.id)}
                >
                  <TrashIcon size={14} />
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
