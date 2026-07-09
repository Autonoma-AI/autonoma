import { Button } from "@autonoma/blacklight";
import { FloppyDiskIcon } from "@phosphor-icons/react/FloppyDisk";
import { usePreviewDraft } from "./-draft-context";

/**
 * Shared validation banners + save/cancel bar for the Preview Environments
 * sections. Sits below the section outlet so config problems and the pending
 * save are visible no matter which section (Apps / Secrets / Services) made the
 * draft dirty. Saving writes one new config revision covering all sections.
 */
export function PreviewSaveBar() {
  const { issues, hookErrors, hasUntouchedStarterApps, isDirty, canSave, isSaving, save, cancel } = usePreviewDraft();

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
      {hasUntouchedStarterApps ? (
        <p className="text-sm text-text-secondary">
          Edit the starter app before saving - the placeholder values are only a guide.
        </p>
      ) : undefined}
      {hookErrors.size > 0 ? (
        <p className="text-sm text-text-secondary">
          Some deploy hooks are invalid - check the Hooks tab of the affected app.
        </p>
      ) : undefined}

      <div className="sticky bottom-0 z-10 flex items-center justify-between gap-3 border-t border-border-dim bg-surface-void/95 py-3 backdrop-blur">
        <p className="font-mono text-2xs uppercase tracking-widest text-text-secondary">
          {isDirty ? "Unsaved changes" : "All changes saved"}
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
            {isSaving ? "Saving..." : "Save config"}
          </Button>
        </div>
      </div>
    </div>
  );
}
