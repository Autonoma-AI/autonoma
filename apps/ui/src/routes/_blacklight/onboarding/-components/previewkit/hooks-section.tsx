import {
  Badge,
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@autonoma/blacklight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { nextDraftId, type HookDraft, type HookGroup, type HooksDraft } from "./topology-draft";

const HOOKS_DOCS_URL = "https://docs.autonoma.app/previewkit/hooks/";

interface HooksSectionProps {
  hooks: HooksDraft;
  /** Declared app names, offered in the `app` picker on each hook row. */
  appNames: string[];
  /** Per-row validation messages keyed `${hookId}:${"app" | "command"}` (see `hookFieldErrors`). */
  errors: Map<string, string[]>;
  onChange: (hooks: HooksDraft) => void;
}

const HOOK_GROUPS: Array<{ key: HookGroup; label: string; description: string }> = [
  {
    key: "pre_deploy",
    label: "Pre-deploy",
    description: "Runs before your apps start, as a one-off job from the app's image - e.g. database migrations",
  },
  {
    key: "post_deploy",
    label: "Post-deploy",
    description: "Runs after your apps are ready, as a one-off job from the app's image - e.g. seed data",
  },
];

/**
 * Authors the config document's lifecycle hooks. Each row maps an `app` to a
 * `command`; every hook runs as a one-off Job built from the target app's image.
 * The `app` is picked from the declared apps; invalid hooks (missing/unknown app,
 * missing command) are flagged inline from `errors` and block saving.
 */
export function HooksSection({ hooks, appNames, errors, onChange }: HooksSectionProps) {
  function updateGroup(group: HookGroup, steps: HookDraft[]) {
    onChange({ ...hooks, [group]: steps });
  }

  return (
    <section className="border border-border-dim bg-surface-base">
      <div className="flex items-center justify-between border-b border-border-dim bg-surface-raised px-5 py-4">
        <div className="flex items-center gap-2">
          <h3 className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">Lifecycle hooks</h3>
          <Badge variant="outline" className="text-3xs uppercase tracking-widest">
            Optional
          </Badge>
        </div>
        <span className="font-mono text-2xs text-text-secondary">
          skip this, or run commands in the preview around each deploy{" "}
          <a
            href={HOOKS_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary-ink underline underline-offset-2"
          >
            Learn more
            <ArrowSquareOutIcon size={11} />
          </a>
        </span>
      </div>
      <div className="space-y-6 p-5">
        {HOOK_GROUPS.map((group) => (
          <HookGroupEditor
            key={group.key}
            label={group.label}
            description={group.description}
            steps={hooks[group.key]}
            appNames={appNames}
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
  appNames,
  errors,
  onChange,
}: {
  label: string;
  description: string;
  steps: HookDraft[];
  appNames: string[];
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
                  <Select<string> value={step.app} onValueChange={(value) => updateStep(step.id, { app: value ?? "" })}>
                    <SelectTrigger
                      id={`pk-hook-${step.id}-app`}
                      aria-invalid={appError != null}
                      className="mt-1 w-full font-mono"
                    >
                      <SelectValue placeholder="Pick an app" />
                    </SelectTrigger>
                    <SelectContent>
                      {appNames.map((name) => (
                        <SelectItem key={name} value={name} className="font-mono">
                          {name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {appError != null ? <p className="mt-1 text-2xs text-status-critical">{appError}</p> : undefined}
                </div>
                <div>
                  <Label htmlFor={`pk-hook-${step.id}-command`}>Command</Label>
                  <Textarea
                    id={`pk-hook-${step.id}-command`}
                    value={step.command}
                    onChange={(event) => updateStep(step.id, { command: event.target.value })}
                    placeholder="npx prisma migrate deploy"
                    aria-invalid={commandError != null}
                    rows={2}
                    className="mt-1 resize-y font-mono text-2xs"
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
