import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { XCircleIcon } from "@phosphor-icons/react/XCircle";

const ENVIRONMENT_FACTORY_DOCS_URL = "https://docs.autonoma.app/guides/environment-factory/";

type SystemFailureKind = "scenario_setup" | "engine_error";

/**
 * A system/infra failure (the scenario environment never came up, or the
 * execution engine threw). Both carry an unwrapped root-cause `message` and
 * render in the shared critical panel below. Agent-outcome failures
 * (agent_failed/max_steps/replay_failed) are not system failures and render via
 * the existing agent UI instead.
 */
export interface SystemFailure {
  kind: SystemFailureKind;
  message: string;
}

const TITLES: Record<SystemFailureKind, string> = {
  scenario_setup: "Scenario setup failed",
  engine_error: "Engine error",
};

/**
 * Narrows a generation `failure` union down to its system variants so the
 * caller can render the critical panel. Generic so it works for any
 * `{ kind }` failure union without naming `GenerationFailure`.
 */
export function isSystemFailure<T extends { kind: string }>(
  failure: T | null | undefined,
): failure is Extract<T, { kind: SystemFailureKind }> {
  return failure != null && (failure.kind === "scenario_setup" || failure.kind === "engine_error");
}

/**
 * Critical-styled panel shown in the main content area when a generation
 * failed at the system level. Replaces the generic "No steps recorded" void.
 */
export function SystemFailurePanel({ failure }: { failure: SystemFailure }) {
  return (
    <div className="flex flex-col gap-4 border border-status-critical/40 bg-status-critical/5 p-6">
      <div className="flex items-center gap-2.5">
        <XCircleIcon size={20} weight="fill" className="text-status-critical" />
        <h2 className="text-base font-semibold text-text-primary">{TITLES[failure.kind]}</h2>
      </div>

      <div className="border-l-2 border-status-critical/50 bg-surface-base px-3 py-2.5">
        <p className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-status-critical">
          {failure.message}
        </p>
      </div>

      {failure.kind === "scenario_setup" && <ScenarioSetupHint />}
      {failure.kind === "engine_error" && <EngineErrorHint />}
    </div>
  );
}

/**
 * Guidance shown under an `engine_error` failure. Unlike `scenario_setup`, this
 * is a failure inside Autonoma's own execution engine, so the copy reassures
 * the customer it is not their environment factory and points them at a retry
 * plus support rather than asking them to fix anything.
 */
function EngineErrorHint() {
  return (
    <div className="flex flex-col gap-2 border-l-2 border-status-warn/50 bg-surface-base px-3 py-2.5">
      <div className="flex items-start gap-2">
        <WarningIcon size={16} weight="fill" className="mt-0.5 shrink-0 text-status-warn" />
        <p className="text-sm font-medium text-text-primary">
          This is an error on Autonoma's side, not in your application.
        </p>
      </div>

      <p className="text-sm leading-relaxed text-text-secondary">
        Autonoma's execution engine hit an unexpected error while running this test (the underlying error is shown
        above), so it stopped before completing. Retrying often clears a transient failure. If it keeps happening,
        contact support with the error above and we'll look into it.
      </p>
    </div>
  );
}

/**
 * Guidance shown under a `scenario_setup` failure. The `up` call to the
 * customer's environment factory endpoint returned a response Autonoma could
 * not process - this is almost always a bug in their implementation, not in
 * Autonoma, so the copy points the blame at their endpoint and lists concrete
 * things to check.
 */
function ScenarioSetupHint() {
  return (
    <div className="flex flex-col gap-3 border-l-2 border-status-warn/50 bg-surface-base px-3 py-2.5">
      <div className="flex items-start gap-2">
        <WarningIcon size={16} weight="fill" className="mt-0.5 shrink-0 text-status-warn" />
        <p className="text-sm font-medium text-text-primary">
          This is an error in your environment factory, not in Autonoma.
        </p>
      </div>

      <p className="text-sm leading-relaxed text-text-secondary">
        Before this test could run, Autonoma called your environment factory's{" "}
        <code className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-2xs text-primary-ink">up</code> endpoint
        to create the scenario data. It responded with something Autonoma could not process (the underlying error is
        shown above), so the test environment never came up.
      </p>

      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-medium text-text-primary">What to check</p>
        <ul className="ml-4 flex list-disc flex-col gap-1 text-sm leading-relaxed text-text-secondary">
          <li>Your endpoint is deployed, reachable, and returns a 2xx response for the {`"up"`} action.</li>
          <li>The factory for each entity in this scenario runs without throwing and returns the expected shape.</li>
          <li>Your webhook URL and signing secret are configured correctly.</li>
        </ul>
      </div>

      <a
        href={ENVIRONMENT_FACTORY_DOCS_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 self-start text-sm text-primary-ink underline decoration-primary-ink/30 underline-offset-2 transition-colors hover:decoration-primary-ink"
      >
        See the Environment Factory guide
        <ArrowSquareOutIcon size={12} weight="bold" className="shrink-0" />
      </a>
    </div>
  );
}
