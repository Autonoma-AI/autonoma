import { Button, Input } from "@autonoma/blacklight";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import {
  nextDraftId,
  type AppDraft,
  type HookDraft,
  type HookGroup,
} from "../../../onboarding/-components/previewkit/topology-draft";
import { usePreviewDraft } from "./-draft-context";

const HOOK_GROUPS: Array<{ key: HookGroup; label: string; description: string }> = [
  { key: "pre_deploy", label: "Pre-deploy", description: "Run before apps start - e.g. database migrations" },
  { key: "post_deploy", label: "Post-deploy", description: "Run after apps are ready - e.g. seed data" },
];

/**
 * One app's slice of the config document's lifecycle hooks. The document keeps
 * a single global `hooks` block whose rows target apps by name; this tab
 * filters it to the current app and pins the target, so a row is just the
 * command. Every hook runs as a one-off Kubernetes Job built from this app's
 * image.
 */
export function AppHooks({ app }: { app: AppDraft }) {
  const { draft, hookErrors, setHooks } = usePreviewDraft();
  const appName = app.name.trim();

  if (appName === "") {
    return (
      <p className="text-sm text-text-secondary">
        Name the app in its Overview tab first - hooks target the app by name.
      </p>
    );
  }

  function updateGroup(group: HookGroup, steps: HookDraft[]) {
    setHooks({ ...draft.hooks, [group]: steps });
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <p className="flex items-start gap-2.5 font-mono text-3xs text-text-secondary">
        <span className="mt-0.5 size-1.5 shrink-0 bg-primary" />
        Hooks run around each preview deploy as one-off jobs built from this app's image.
      </p>
      {HOOK_GROUPS.map((group) => (
        <AppHookGroup
          key={group.key}
          label={group.label}
          description={group.description}
          appName={appName}
          steps={draft.hooks[group.key]}
          errors={hookErrors}
          onChange={(steps) => updateGroup(group.key, steps)}
        />
      ))}
    </div>
  );
}

function AppHookGroup({
  label,
  description,
  appName,
  steps,
  errors,
  onChange,
}: {
  label: string;
  description: string;
  appName: string;
  /** The full group list across all apps - edits map over it, display filters it. */
  steps: HookDraft[];
  errors: Map<string, string[]>;
  onChange: (steps: HookDraft[]) => void;
}) {
  const ownSteps = steps.filter((step) => step.app.trim() === appName);

  function updateStep(id: number, command: string) {
    onChange(steps.map((step) => (step.id === id ? { ...step, command } : step)));
  }

  function removeStep(id: number) {
    onChange(steps.filter((step) => step.id !== id));
  }

  function addStep() {
    onChange([...steps, { id: nextDraftId(), app: appName, command: "" }]);
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-mono text-4xs font-semibold uppercase tracking-widest text-text-secondary">{label}</p>
          <p className="mt-1 text-2xs text-text-secondary">{description}</p>
        </div>
        <Button variant="outline" size="xs" className="gap-1" onClick={addStep}>
          <PlusIcon size={12} weight="bold" />
          Add hook
        </Button>
      </div>
      {ownSteps.length === 0 ? (
        <p className="mt-2.5 border border-border-dim px-3.5 py-3 font-mono text-2xs text-text-secondary">
          No {label.toLowerCase()} hooks.
        </p>
      ) : (
        <div className="mt-2.5 space-y-2">
          {ownSteps.map((step) => {
            // App errors can still occur here (e.g. the app is an unedited
            // starter), so surface them alongside command problems.
            const error = errors.get(`${step.id}:command`)?.[0] ?? errors.get(`${step.id}:app`)?.[0];
            return (
              <div key={step.id}>
                <div className="flex items-center gap-2">
                  <Input
                    value={step.command}
                    onChange={(event) => updateStep(step.id, event.target.value)}
                    placeholder="npx prisma migrate deploy"
                    aria-label={`${label} hook command`}
                    aria-invalid={error != null}
                    className="font-mono"
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title="Remove hook"
                    className="shrink-0 hover:text-status-critical"
                    onClick={() => removeStep(step.id)}
                  >
                    <TrashIcon size={14} />
                  </Button>
                </div>
                {error != null ? <p className="mt-1 text-2xs text-status-critical">{error}</p> : undefined}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
