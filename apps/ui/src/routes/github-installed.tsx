import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

/**
 * Terminal page for an install opened in a NEW tab (the add-another-repo flow): GitHub redirects
 * the new tab here, the user's real work is still in the original tab, so all this has to say is
 * "you can close this".
 *
 * Success only. Failures land on the install screen instead, which has the Install button and the
 * steps out - this page has neither, and when it carried them it was a dead end with no context.
 */
export const Route = createFileRoute("/github-installed")({
  validateSearch: z.object({ status: z.enum(["ok"]).optional() }),
  component: GithubInstalledPage,
});

function GithubInstalledPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-void p-6">
      <div className="flex max-w-md flex-col items-center gap-4 border border-border-dim bg-surface-base p-8 text-center">
        <CheckCircleIcon size={40} weight="fill" className="text-status-success" />
        <h1 className="text-xl font-medium text-text-primary">GitHub access granted</h1>
        <p className="text-sm text-text-secondary">
          GitHub granted Autonoma access to your repositories. You can close this tab and go back to the Autonoma tab -
          your new repo will appear there.
        </p>
        <button
          type="button"
          onClick={() => window.close()}
          className="mt-2 border border-border-mid px-4 py-2 font-mono text-2xs uppercase tracking-widest text-text-secondary transition-colors hover:border-border-highlight hover:text-text-primary"
        >
          Close tab
        </button>
      </div>
    </div>
  );
}
