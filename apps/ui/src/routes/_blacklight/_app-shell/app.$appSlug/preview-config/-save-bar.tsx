import { Button } from "@autonoma/blacklight";
import { FloppyDiskIcon } from "@phosphor-icons/react/FloppyDisk";
import { fieldIssueSummaries } from "../../../onboarding/-components/previewkit/topology-draft";
import { usePreviewDraft } from "./-draft-context";

/**
 * Shared validation banners + save/cancel bar for the Preview Environments
 * sections. Sits below the section outlet so config problems and the pending
 * save are visible no matter which section (Apps / Secrets / Services) made the
 * draft dirty. Saving writes one new config revision covering all sections -
 * except when only secrets changed, which go straight to their secret bundles and
 * so remain saveable while the config itself is blocked.
 */
export function PreviewSaveBar() {
  const { draft, issues, hookErrors, isDirty, canSave, isSaving, secretsOnly, save, cancel } = usePreviewDraft();
  // Field errors render next to their own field, which may be on another app or
  // another tab than the one being edited - so a config change made anywhere
  // would hit a disabled Save with nothing on screen saying why.
  const blockers = fieldIssueSummaries(issues.fieldErrors, draft.apps);

  return (
    <div className="flex flex-col gap-4">
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
      {blockers.length > 0 ? (
        <div className="border-l-2 border-status-critical bg-status-critical/10 px-4 py-3">
          <p className="font-mono text-2xs uppercase tracking-widest text-status-critical">Blocks saving the config</p>
          {blockers.map((blocker) => (
            <p key={blocker.key} className="mt-2 text-sm text-text-secondary">
              <span className="font-mono text-2xs uppercase tracking-wider text-text-primary">
                {blocker.app} · {blocker.field} ({blocker.tab} tab)
              </span>{" "}
              {blocker.message}
            </p>
          ))}
          {secretsOnly ? (
            <p className="mt-3 text-sm text-text-secondary">Secrets are stored separately and still save.</p>
          ) : undefined}
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
      {hookErrors.size > 0 ? (
        <p className="text-sm text-text-secondary">
          Some deploy hooks are invalid - check the Hooks tab of the affected app.
        </p>
      ) : undefined}

      <div className="sticky bottom-0 z-10 flex items-center justify-between gap-3 border-t border-border-dim bg-surface-void/95 py-3 backdrop-blur">
        <p className="font-mono text-2xs uppercase tracking-widest text-text-secondary">
          {isDirty ? (secretsOnly ? "Unsaved secrets" : "Unsaved changes") : "All changes saved"}
        </p>
        <div className="flex items-center gap-3">
          <Button variant="ghost" onClick={cancel} disabled={!isDirty || isSaving} aria-label="preview-config-cancel">
            Cancel
          </Button>
          <Button
            variant="accent"
            className="gap-2"
            onClick={save}
            disabled={!canSave}
            aria-label="preview-config-save"
          >
            <FloppyDiskIcon size={16} weight="bold" />
            {isSaving ? "Saving..." : secretsOnly ? "Save secrets" : "Save config"}
          </Button>
        </div>
      </div>
    </div>
  );
}
