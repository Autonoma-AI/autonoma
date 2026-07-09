import { FlaskIcon } from "@phosphor-icons/react/Flask";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/tests/")({
  component: TestsIndexPage,
});

function TestsIndexPage() {
  return (
    <div className="flex h-full min-h-[520px] flex-col items-center justify-center gap-4 p-10 text-center">
      <FlaskIcon size={44} className="text-border-highlight" />
      <p className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-secondary">No test selected</p>
      <p className="max-w-sm text-sm leading-relaxed text-text-secondary">
        Choose a test from the list to read its plan, and see the latest runs on this branch with the pull requests that
        triggered them.
      </p>
    </div>
  );
}
