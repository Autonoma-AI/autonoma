import { Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@autonoma/blacklight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { GitBranchIcon } from "@phosphor-icons/react/GitBranch";
import type { BranchConventionDraft } from "./topology-draft";

const MULTIREPO_DOCS_URL = "https://docs.autonoma.app/previewkit/multirepo/";

interface BranchMatchingFieldProps {
  convention: BranchConventionDraft;
  onChange: (convention: BranchConventionDraft) => void;
}

/**
 * Global rule for which branch of every dependency repo a PR preview builds. Shown
 * only once the project has a dependency repo (the primary repo always builds the
 * PR's own branch). "Fallback branch only" maps to the config's `none` convention;
 * the legacy `manual` convention resolves the same way but is not offered here.
 */
export function BranchMatchingField({ convention, onChange }: BranchMatchingFieldProps) {
  // A saved config may still carry the legacy `manual` convention; surface it as
  // its behavioural equivalent so the control has a value.
  const selected = convention.type === "manual" ? "none" : convention.type;

  function handleTypeChange(type: string | null) {
    if (type === "regex") {
      onChange({ type: "regex", pattern: "", replacement: "" });
    } else if (type === "same_branch_name" || type === "none") {
      onChange({ type });
    }
  }

  return (
    <section className="border border-border-dim bg-surface-base p-5">
      <div className="flex items-center gap-2">
        <GitBranchIcon size={16} className="text-primary-ink" />
        <h3 className="font-mono text-2xs font-bold uppercase tracking-widest text-text-primary">Branch matching</h3>
      </div>
      <p className="mt-1 text-2xs text-text-secondary">
        Which branch of each dependency repo a PR preview builds. Each repo falls back to its own fallback branch when
        no match exists.{" "}
        <a
          href={MULTIREPO_DOCS_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-primary-ink underline underline-offset-2"
        >
          How branch matching works
          <ArrowSquareOutIcon size={11} />
        </a>
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="pk-branch-convention">Rule</Label>
          <Select value={selected} onValueChange={handleTypeChange}>
            <SelectTrigger id="pk-branch-convention">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="same_branch_name">Same branch name</SelectItem>
              <SelectItem value="none">Fallback branch only</SelectItem>
              <SelectItem value="regex">Regex rewrite</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {convention.type === "regex" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="pk-branch-pattern">Pattern</Label>
              <Input
                id="pk-branch-pattern"
                value={convention.pattern}
                onChange={(event) => onChange({ ...convention, pattern: event.target.value })}
                placeholder="^feature/(.+)$"
                className="font-mono"
              />
            </div>
            <div>
              <Label htmlFor="pk-branch-replacement">Replacement</Label>
              <Input
                id="pk-branch-replacement"
                value={convention.replacement}
                onChange={(event) => onChange({ ...convention, replacement: event.target.value })}
                placeholder="$1"
                className="font-mono"
              />
            </div>
          </div>
        ) : undefined}
      </div>
    </section>
  );
}
