import { BuildingsIcon } from "@phosphor-icons/react/Buildings";
import { useActiveOrg } from "lib/query/auth.queries";

/**
 * Says out loud that a destination edits organization state, on a page reached through one application's
 * URL. Without it, changing billing or a key from application A and having it apply to application B is
 * invisible - which is precisely why these were worth moving in the first place. The rail's group heading
 * makes the same point; this repeats it where the controls actually are.
 */
export function OrgScopeNote({ children }: { children: string }) {
  const { data: activeOrg } = useActiveOrg();

  return (
    <div className="flex items-start gap-2.5 border border-border-dim bg-surface-base px-4 py-3">
      <BuildingsIcon size={15} className="mt-0.5 shrink-0 text-text-secondary" />
      <p className="text-xs text-text-secondary">
        {children} They apply to every application in{" "}
        <span className="font-medium text-text-primary">{activeOrg?.name ?? "this organization"}</span>, not just this
        one.
      </p>
    </div>
  );
}
