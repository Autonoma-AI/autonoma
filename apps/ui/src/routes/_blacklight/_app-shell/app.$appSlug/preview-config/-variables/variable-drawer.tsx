import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Switch,
  Textarea,
  cn,
} from "@autonoma/blacklight";
import { connectionTokens } from "@autonoma/types";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { EyeIcon } from "@phosphor-icons/react/Eye";
import { EyeSlashIcon } from "@phosphor-icons/react/EyeSlash";
import { LockIcon } from "@phosphor-icons/react/Lock";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { useRef, useState, type ReactNode } from "react";
import type { AppDraft } from "../../../../onboarding/-components/previewkit/topology-draft";
import { formFromView, validateForm, type BindTarget, type VariableForm, type VariableView } from "./variable-model";

// Human-readable meaning for each connection property, shown as the subtitle in
// the reference picker so a user doesn't have to know what `{{db.url}}` resolves to.
const PROPERTY_MEANINGS: Record<string, string> = {
  url: "connection string",
  host: "hostname",
  port: "port",
};

interface ConnectionReference {
  token: string;
  meaning: string;
}

/** Every `{{name.property}}` a connection can reference, paired with a readable meaning. */
function connectionReferences(targets: BindTarget[]): ConnectionReference[] {
  return targets.flatMap((target) =>
    target.properties.map((property) => {
      const meaning =
        target.kind === "app" && property === "url" ? "public URL" : (PROPERTY_MEANINGS[property] ?? property);
      return { token: `{{${target.name}.${property}}}`, meaning: `${target.kind} · ${meaning}` };
    }),
  );
}

interface ReferenceStatus {
  token: string;
  /** False when the target isn't a real app/service, or the property it exposes. */
  valid: boolean;
  /** What the token becomes at deploy, or why it's wrong. */
  meaning: string;
}

/** Validate one `{{name.property}}` token and describe what it resolves to (or why it can't). */
function describeReference(target: string, property: string, targets: BindTarget[]): ReferenceStatus {
  const token = `{{${target}.${property}}}`;
  const match = targets.find((candidate) => candidate.name === target);
  if (match == null) return { token, valid: false, meaning: "not an app or service in this preview" };
  if (!match.properties.includes(property)) {
    return { token, valid: false, meaning: `${target} has no "${property}" (exposes: ${match.properties.join(", ")})` };
  }
  const readable =
    match.kind === "app" && property === "url" ? "public URL" : (PROPERTY_MEANINGS[property] ?? property);
  return { token, valid: true, meaning: `${target}'s ${readable}` };
}

/** Every distinct token in a connection value, validated and described, in first-seen order. */
function referencedTokens(value: string, targets: BindTarget[]): ReferenceStatus[] {
  const seen = new Map<string, ReferenceStatus>();
  for (const token of connectionTokens(value)) {
    const status = describeReference(token.target, token.property, targets);
    if (!seen.has(status.token)) seen.set(status.token, status);
  }
  return [...seen.values()];
}

interface VariableDrawerProps {
  app: AppDraft;
  /** The variable being edited (a real draft row - a freshly added one starts blank). */
  view: VariableView;
  targets: BindTarget[];
  /** Whether this app supports AWS-stored secrets - primary-repo apps only. */
  secretsSupported: boolean;
  onChange: (form: VariableForm) => void;
  onDelete: () => void;
}

/**
 * The focused editor for one variable: key, source (secret or connection), the
 * value, and the build-time flag. Edits apply to the shared draft **live** (like
 * every other editor on this page) - there is no per-variable save; the page's
 * "Save config" bar persists the whole draft as one config revision.
 */
export function VariableDrawer({ app, view, targets, secretsSupported, onChange, onDelete }: VariableDrawerProps) {
  const [revealed, setRevealed] = useState(false);
  // Stored secret being replaced: the user opted to type a new value over the
  // write-only stored one.
  const [replacing, setReplacing] = useState(false);
  const valueRef = useRef<HTMLTextAreaElement>(null);

  const form = formFromView(view);
  const isStoredSecret = view.isStoredSecret;
  const isNew = view.key === "";
  const error = validateForm(form, app, view, targets, secretsSupported);
  const pristine = form.key === "" && form.value === "";
  const references = connectionReferences(targets);
  const resolved = referencedTokens(form.value, targets);

  function update(next: Partial<VariableForm>) {
    onChange({ ...form, ...next });
  }

  function setSource(source: "secret" | "connection") {
    update({ source });
  }

  function insertToken(token: string) {
    const el = valueRef.current;
    const start = el?.selectionStart ?? form.value.length;
    const end = el?.selectionEnd ?? form.value.length;
    const nextValue = form.value.slice(0, start) + token + form.value.slice(end);
    update({ value: nextValue });
    if (el != null) {
      requestAnimationFrame(() => {
        el.focus();
        const caret = start + token.length;
        el.setSelectionRange(caret, caret);
      });
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-5 p-5">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-mono text-2xs font-bold uppercase tracking-wider text-text-primary">
          <span className="size-1.5 bg-primary" />
          {isNew ? "New variable" : "Edit variable"}
        </p>
        <Button
          variant="ghost"
          size="icon-xs"
          title="Delete variable"
          aria-label="pk-variable-delete"
          className="hover:text-status-critical"
          onClick={onDelete}
        >
          <TrashIcon size={13} />
        </Button>
      </div>

      <div>
        <FieldLabel htmlFor="pk-variable-key">Key</FieldLabel>
        <Input
          id="pk-variable-key"
          value={form.key}
          onChange={(event) => update({ key: event.target.value })}
          placeholder="DATABASE_URL"
          autoFocus={isNew}
        />
      </div>

      <div>
        <FieldLabel>Source</FieldLabel>
        <div className="inline-flex border border-border-mid">
          <SourceSegment active={form.source === "secret"} onClick={() => setSource("secret")}>
            Secret
          </SourceSegment>
          <SourceSegment
            active={form.source === "connection"}
            disabled={targets.length === 0}
            className="border-l border-border-mid"
            onClick={() => setSource("connection")}
          >
            Connection
          </SourceSegment>
        </div>
        <p className="mt-1.5 text-2xs text-text-secondary">
          {form.source === "secret"
            ? "Stored encrypted in AWS, injected at runtime. Never shown again after saving."
            : targets.length === 0
              ? "Attach a managed service in the Services section to wire a connection."
              : "Wired to a service or app in this preview, resolved at deploy time."}
        </p>
      </div>

      {form.source === "connection" ? (
        <div>
          <FieldLabel htmlFor="pk-variable-value">Value</FieldLabel>
          <Textarea
            id="pk-variable-value"
            ref={valueRef}
            value={form.value}
            onChange={(event) => update({ value: event.target.value })}
            placeholder="mongodb://{{db.host}}:{{db.port}}/preview   or   {{api.url}}"
            rows={2}
            className="min-h-8 resize-y py-1.5 font-mono [field-sizing:content]"
          />
          <p className="mt-1.5 text-2xs text-text-secondary">
            Reference a service or app with a <code className="text-text-primary">{"{{name.property}}"}</code> token.
            Combine tokens with literal text (schemes, ports, paths); resolved at deploy time.
          </p>
          {resolved.length > 0 ? (
            <div className="mt-2 flex flex-col gap-1">
              <span className="font-mono text-4xs uppercase tracking-widest text-text-secondary">
                Fills in at deploy
              </span>
              {resolved.map((reference) => (
                <div key={reference.token} className="flex flex-wrap items-center gap-1.5 font-mono text-4xs">
                  <span
                    className={cn(
                      "border px-1.5 py-0.5",
                      reference.valid
                        ? "border-border-mid text-text-primary"
                        : "border-status-critical/50 bg-status-critical/10 text-status-critical",
                    )}
                  >
                    {reference.token}
                  </span>
                  <span className={reference.valid ? "text-text-secondary" : "text-status-critical"}>
                    {reference.valid ? "becomes" : "won't resolve:"} {reference.meaning}
                  </span>
                </div>
              ))}
            </div>
          ) : undefined}
          {references.length > 0 ? (
            <div className="mt-2">
              <DropdownMenu>
                <DropdownMenuTrigger className="inline-flex items-center gap-1.5 border border-border-mid px-2 py-1 font-mono text-4xs uppercase tracking-widest text-text-secondary transition-colors hover:border-primary hover:text-text-primary">
                  Insert a reference
                  <CaretDownIcon size={11} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-64 overflow-y-auto">
                  {references.map((reference) => (
                    <DropdownMenuItem
                      key={reference.token}
                      onClick={() => insertToken(reference.token)}
                      className="flex-col items-start gap-0.5"
                    >
                      <span className="font-mono text-2xs text-text-primary">{reference.token}</span>
                      <span className="font-mono text-4xs uppercase tracking-widest text-text-secondary">
                        {reference.meaning}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : (
            <p className="mt-2 text-2xs text-status-warn">
              No services or apps to reference yet - attach one in the Services section.
            </p>
          )}
        </div>
      ) : (
        <div>
          <FieldLabel htmlFor="pk-variable-value">Value</FieldLabel>
          {isStoredSecret && !replacing ? (
            <>
              <div className="flex h-8 items-center justify-between gap-2 border border-border-mid bg-surface-void px-2.5">
                <span className="font-mono text-xs tracking-widest text-text-secondary">•••••• (set)</span>
                <Button variant="outline" size="xs" onClick={() => setReplacing(true)}>
                  Replace value
                </Button>
              </div>
              <p className="mt-1.5 text-2xs text-text-secondary">
                The stored value can't be read back. Replacing it overwrites the secret on save.
              </p>
            </>
          ) : !revealed ? (
            <div className="relative">
              <Input
                id="pk-variable-value"
                type="password"
                value={form.value}
                onChange={(event) => update({ value: event.target.value })}
                placeholder={isStoredSecret ? "new value" : "value"}
                className="pr-9"
              />
              <RevealButton revealed={false} onClick={() => setRevealed(true)} />
            </div>
          ) : (
            <div className="relative">
              <Textarea
                id="pk-variable-value"
                value={form.value}
                onChange={(event) => update({ value: event.target.value })}
                placeholder={isStoredSecret ? "new value" : "value"}
                rows={1}
                // A textarea preserves pasted newlines (PEM keys, certs); auto-grows
                // where supported, manually resizable otherwise.
                className="min-h-8 resize-y py-1.5 pr-9 font-mono [field-sizing:content]"
              />
              <RevealButton revealed onClick={() => setRevealed(false)} />
            </div>
          )}
          {!isStoredSecret ? (
            <p className="mt-1.5 flex items-center gap-1.5 text-2xs text-text-secondary">
              <LockIcon size={11} className="shrink-0" />
              Stored encrypted - never shown again after saving.
            </p>
          ) : undefined}
        </div>
      )}

      <div className="border-t border-border-dim pt-4">
        <FieldLabel>Injection</FieldLabel>
        <p className="mt-1 flex items-center gap-2 text-xs text-text-secondary">
          <span className="size-1.5 shrink-0 bg-primary" />
          <span>
            {form.source === "connection" ? (
              <>
                Resolved at deploy and injected at <span className="font-medium text-text-primary">runtime</span> -
                always on.
              </>
            ) : (
              <>
                Injected at <span className="font-medium text-text-primary">runtime</span> - always on for every
                variable.
              </>
            )}
          </span>
        </p>
        <div className="mt-3 flex items-start gap-3">
          <Switch
            id="pk-variable-buildtime"
            checked={form.buildTime}
            onCheckedChange={(buildTime) => update({ buildTime })}
          />
          <div className="min-w-0">
            <label
              htmlFor="pk-variable-buildtime"
              className="block font-mono text-3xs font-semibold uppercase tracking-wider text-text-primary"
            >
              Also inject at build time
            </label>
            <p className="mt-1 text-2xs text-text-secondary">
              Expose during image build too. Leave off unless the build needs it.
            </p>
          </div>
        </div>
      </div>

      {error != null && !pristine ? (
        <p className="border-l-2 border-status-critical pl-2 text-2xs text-status-critical">{error}</p>
      ) : undefined}
    </div>
  );
}

function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1.5 block font-mono text-4xs font-semibold uppercase tracking-widest text-text-secondary"
    >
      {children}
    </label>
  );
}

function SourceSegment({
  active,
  disabled,
  className,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "px-2.5 py-1.5 font-mono text-3xs font-semibold uppercase tracking-wider transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        active ? "bg-primary text-primary-foreground" : "text-text-secondary hover:text-text-primary",
        className,
      )}
    >
      {children}
    </button>
  );
}

function RevealButton({ revealed, onClick }: { revealed: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      title={revealed ? "Hide value" : "Reveal value"}
      aria-label={revealed ? "Hide value" : "Reveal value"}
      onClick={onClick}
      className="absolute right-2 top-1.5 text-text-secondary transition-colors hover:text-text-primary"
    >
      {revealed ? <EyeSlashIcon size={14} /> : <EyeIcon size={14} />}
    </button>
  );
}
