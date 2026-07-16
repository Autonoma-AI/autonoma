import {
  Alert,
  AlertDescription,
  AlertTitle,
  BrailleSpinner,
  Button,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@autonoma/blacklight";
import { ArrowLineDownIcon } from "@phosphor-icons/react/ArrowLineDown";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CodeIcon } from "@phosphor-icons/react/Code";
import { CookieIcon } from "@phosphor-icons/react/Cookie";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { InfoIcon } from "@phosphor-icons/react/Info";
import type { Icon } from "@phosphor-icons/react/lib";
import { UserFocusIcon } from "@phosphor-icons/react/UserFocus";
import { UserPlusIcon } from "@phosphor-icons/react/UserPlus";
import {
  usePreviewTestUserOptions,
  usePreviewTestUserProvision,
  usePreviewTestUserTeardown,
} from "lib/query/deployments.queries";
import type { RouterOutputs } from "lib/trpc";
import { type ReactNode, useState } from "react";

// A test user is only reachable while the preview is actually serving traffic,
// so the card is interactive only when the environment is "ready". Every other
// status renders the card disabled with a status-specific reason.
const NOT_READY_REASON: Record<string, string> = {
  building: "The preview is still building. Provision a test user once it's ready.",
  stale: "This preview is stale. Redeploy it, then provision a test user.",
  stopped: "This preview is stopped. Start it to provision a test user.",
  failed: "This preview failed to deploy. Provision a test user once it's ready.",
};
const DEFAULT_NOT_READY_REASON = "This preview isn't running yet. Provision a test user once it's ready.";

type ProvisionResult = RouterOutputs["deployments"]["testUserProvision"];
type AuthPayload = ProvisionResult["auth"];
type AuthCookie = NonNullable<NonNullable<AuthPayload>["cookies"]>[number];

// A provisioned test user held only while the card is mounted - nothing is
// persisted server-side, so the teardown call needs these values back.
type ActiveTestUser = {
  instanceId: string;
  scenarioId: string;
  auth: AuthPayload;
  refs: ProvisionResult["refs"];
  refsToken: string | undefined;
};

// One credential mode returned by the SDK. An app implements a single mode in
// practice, so the card shows only the modes actually present (no empty tabs).
// Each mode carries its own renderer so cookies/headers/credentials keep their
// distinct presentation without a type-erasing union `value`.
type CredentialMode = { key: string; label: string; render: () => ReactNode };

export function TestUserCard({ applicationId, environmentId }: { applicationId: string; environmentId: string }) {
  const { data: options } = usePreviewTestUserOptions(applicationId, environmentId);
  const provision = usePreviewTestUserProvision();
  const teardown = usePreviewTestUserTeardown();

  const [scenarioOverride, setScenarioOverride] = useState("");
  const [active, setActive] = useState<ActiveTestUser | undefined>(undefined);

  const scenarioId = scenarioOverride !== "" ? scenarioOverride : (options.scenarios[0]?.id ?? "");

  const handleProvision = () => {
    if (scenarioId === "") return;
    provision.mutate(
      { applicationId, environmentId, scenarioId },
      {
        onSuccess: (data) => {
          setActive({
            instanceId: data.instanceId,
            scenarioId,
            auth: data.auth,
            refs: data.refs,
            refsToken: data.refsToken,
          });
        },
      },
    );
  };

  const handleTeardown = () => {
    if (active == null) return;
    teardown.mutate(
      {
        applicationId,
        environmentId,
        scenarioId: active.scenarioId,
        instanceId: active.instanceId,
        refs: active.refs,
        refsToken: active.refsToken,
      },
      { onSuccess: () => setActive(undefined) },
    );
  };

  return (
    <div className="border border-border-dim bg-surface-base shadow-sm">
      <TestUserHeader />
      {active != null ? (
        <ActiveTestUserBody
          active={active}
          previewUrl={options.previewUrl}
          teardownPending={teardown.isPending}
          onTeardown={handleTeardown}
        />
      ) : options.disabledReason != null ? (
        <p className="px-4 py-2.5 text-2xs text-status-warn">{options.disabledReason}</p>
      ) : provision.isPending ? (
        <ProvisioningBody />
      ) : (
        <EmptyBody
          scenarios={options.scenarios}
          scenarioId={scenarioId}
          onScenarioChange={setScenarioOverride}
          onProvision={handleProvision}
          canProvision={scenarioId !== ""}
          errorMessage={provision.error?.message}
          previewUrl={options.previewUrl}
        />
      )}
    </div>
  );
}

function TestUserHeader() {
  return (
    <div className="flex items-center gap-2 border-b border-border-dim px-4 py-2.5 font-mono text-2xs font-bold uppercase tracking-wider text-text-primary">
      <span className="size-1.5 shrink-0 bg-primary" />
      <UserFocusIcon size={14} className="text-text-secondary" />
      Test user
    </div>
  );
}

function EmptyBody({
  scenarios,
  scenarioId,
  onScenarioChange,
  onProvision,
  canProvision,
  errorMessage,
  previewUrl,
}: {
  scenarios: Array<{ id: string; name: string }>;
  scenarioId: string;
  onScenarioChange: (id: string) => void;
  onProvision: () => void;
  canProvision: boolean;
  errorMessage: string | undefined;
  previewUrl: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <p className="text-2xs text-text-secondary">
        Sign in to the app's frontend as a throwaway user - returns cookies, headers or an email + password.
      </p>
      {errorMessage != null && <ProvisionErrorBanner message={errorMessage} previewUrl={previewUrl} />}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="flex min-w-56 flex-1 flex-col gap-1">
          <span className="font-mono text-3xs uppercase tracking-widest text-text-secondary">Scenario</span>
          <select
            value={scenarioId}
            onChange={(e) => onScenarioChange(e.target.value)}
            aria-label="Select a scenario"
            className="h-8 rounded-none border border-border-mid bg-surface-void px-2.5 text-2xs text-text-primary"
          >
            {scenarios.map((scenario) => (
              <option key={scenario.id} value={scenario.id}>
                {scenario.name}
              </option>
            ))}
          </select>
        </label>
        <Button variant="cta" size="sm" disabled={!canProvision} onClick={onProvision}>
          <UserPlusIcon />
          Provision user
        </Button>
      </div>
    </div>
  );
}

// A cold preview (scaled to zero) not answering the provision in time is the
// common failure, and reads as a timeout or - if a proxy cut the request - an
// HTML "not valid JSON" parse error. Both mean the same thing to the user: wake
// the preview first, then retry. Anything else shows the raw message.
function ProvisionErrorBanner({ message, previewUrl }: { message: string; previewUrl: string | undefined }) {
  if (looksUnresponsive(message)) {
    return (
      <Alert variant="warning">
        <AlertTitle>Preview waking up</AlertTitle>
        <AlertDescription>
          The preview didn't respond in time - it's likely still waking up.{" "}
          {previewUrl != null ? (
            <a href={previewUrl} target="_blank" rel="noreferrer" className="font-medium text-text-primary underline">
              Open it
            </a>
          ) : (
            "Open it"
          )}
          , wait until it loads, then provision again.
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="critical">
      <AlertTitle>Couldn't provision</AlertTitle>
      <AlertDescription className="break-words">{message}</AlertDescription>
    </Alert>
  );
}

// The SDK client's timeout message, or the "Unexpected token '<'" a proxy 504
// yields when it cuts the request and returns an HTML error page.
function looksUnresponsive(message: string): boolean {
  return /timed out/i.test(message) || /not valid JSON/i.test(message) || /Unexpected token/i.test(message);
}

function ProvisioningBody() {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="flex items-center gap-2 text-2xs text-text-secondary">
        <BrailleSpinner animation="braille" size="sm" />
        Spinning up an isolated user and minting credentials…
      </div>
      <Button variant="cta" size="sm" disabled>
        Provisioning…
      </Button>
    </div>
  );
}

function ActiveTestUserBody({
  active,
  previewUrl,
  teardownPending,
  onTeardown,
}: {
  active: ActiveTestUser;
  previewUrl: string | undefined;
  teardownPending: boolean;
  onTeardown: () => void;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-dim px-4 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <span className="inline-flex items-center border border-status-success bg-status-success/10 px-2 py-0.5 font-mono text-2xs font-bold uppercase tracking-wider text-status-success">
            Active
          </span>
          <span className="break-all font-mono text-2xs text-text-secondary">instance {active.instanceId}</span>
        </div>
        <div className="flex items-center gap-2">
          {previewUrl != null && (
            <Button variant="outline" size="sm" render={<a href={previewUrl} target="_blank" rel="noreferrer" />}>
              <ArrowSquareOutIcon />
              Open preview
            </Button>
          )}
          <Button variant="destructive" size="sm" disabled={teardownPending} onClick={onTeardown}>
            {teardownPending ? <BrailleSpinner animation="braille" size="sm" /> : <ArrowLineDownIcon />}
            Tear down
          </Button>
        </div>
      </div>

      <div className="px-4 py-3">
        <CredentialsView auth={active.auth} previewUrl={previewUrl} />
        <div className="mt-3 flex items-center gap-1.5 font-mono text-2xs text-text-secondary">
          <InfoIcon size={13} className="shrink-0" />
          Sign in to the frontend as this user. The session is isolated and torn down automatically on expiry.
        </div>
      </div>
    </div>
  );
}

function CredentialsView({ auth, previewUrl }: { auth: AuthPayload; previewUrl: string | undefined }) {
  const modes = collectModes(auth, previewUrl);

  if (modes.length === 0) {
    return <p className="text-2xs text-text-secondary">The session returned no credentials.</p>;
  }

  if (modes.length === 1) {
    const mode = modes[0];
    if (mode == null) return null;
    return <>{mode.render()}</>;
  }

  return (
    <Tabs defaultValue={modes[0]?.key}>
      <TabsList variant="line">
        {modes.map((mode) => (
          <TabsTrigger key={mode.key} value={mode.key}>
            {mode.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {modes.map((mode) => (
        <TabsContent key={mode.key} value={mode.key} className="mt-3">
          {mode.render()}
        </TabsContent>
      ))}
    </Tabs>
  );
}

// The SDK auth payload carries at most one populated mode in practice; collect
// whichever are non-empty so the card renders exactly those (an empty `{}`
// headers or credentials object counts as absent, not as a blank tab).
function collectModes(auth: AuthPayload, previewUrl: string | undefined): CredentialMode[] {
  const modes: CredentialMode[] = [];
  if (auth?.cookies != null && auth.cookies.length > 0) {
    const cookies = auth.cookies;
    modes.push({
      key: "cookies",
      label: "Cookies",
      render: () => <CookiesBody cookies={cookies} previewUrl={previewUrl} />,
    });
  }
  if (auth?.headers != null && Object.keys(auth.headers).length > 0) {
    const headers = auth.headers;
    modes.push({ key: "headers", label: "Headers", render: () => <JsonBlock value={headers} /> });
  }
  if (auth?.credentials != null && Object.keys(auth.credentials).length > 0) {
    const credentials = auth.credentials;
    modes.push({ key: "creds", label: "Email + password", render: () => <CredentialFields fields={credentials} /> });
  }
  return modes;
}

// The cookie mode is the one that can log the user in directly. Two ready-to-use
// exports: the Cookie-Editor import shape (sets httpOnly cookies too) and a
// `document.cookie` console snippet (quicker, but can't set httpOnly - it omits
// those and says how many). Raw JSON stays below for reference / other tooling.
function CookiesBody({ cookies, previewUrl }: { cookies: AuthCookie[]; previewUrl: string | undefined }) {
  const cookieEditorJson = toCookieEditorJson(cookies, safeHostname(previewUrl));
  const documentCookieSnippet = toDocumentCookieSnippet(cookies);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-2xs text-text-secondary">
          <InfoIcon size={13} className="shrink-0" />
          Load these into the preview to sign in - via the Cookie-Editor extension, or paste the snippet in the console.
        </p>
        <div className="flex items-center gap-2">
          <CopyActionButton value={cookieEditorJson} label="Copy for Cookie-Editor" icon={CookieIcon} />
          <CopyActionButton value={documentCookieSnippet} label="Copy document.cookie" icon={CodeIcon} />
        </div>
      </div>
      <JsonBlock value={cookies} />
    </div>
  );
}

function CopyActionButton({ value, label, icon: Icon }: { value: string; label: string; icon: Icon }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      <Icon />
      {copied ? "Copied" : label}
    </Button>
  );
}

// Credentials are a flat string map (email / password / login URL, …). Each
// value gets its own copy button since a user typically pastes one at a time.
function CredentialFields({ fields }: { fields: Record<string, string> }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {Object.entries(fields).map(([key, value]) => (
        <div key={key} className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-3xs uppercase tracking-widest text-text-secondary">{humanize(key)}</span>
            <CopyButton value={value} />
          </div>
          <div className="flex h-9 items-center break-all border border-border-mid bg-surface-void px-3 font-mono text-2xs text-text-primary">
            {value}
          </div>
        </div>
      ))}
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  const json = JSON.stringify(value, null, 2);
  return (
    <div className="relative">
      <div className="absolute right-2 top-2">
        <CopyButton value={json} />
      </div>
      <pre className="max-h-56 overflow-auto border border-border-dim bg-surface-void p-4 pr-16 font-mono text-2xs leading-relaxed whitespace-pre text-text-secondary">
        {json}
      </pre>
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
      aria-label="Copy"
      className="inline-flex items-center gap-1 rounded-none px-1.5 py-0.5 font-mono text-3xs uppercase tracking-wider text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary"
    >
      <CopyIcon size={11} />
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

// Map an SDK auth cookie to the Cookie-Editor extension's import entry. Missing
// fields fall back to browser cookie defaults; a cookie with no domain of its
// own is scoped to the preview host. `undefined` fields are dropped by
// JSON.stringify, so absent domain/expiry simply don't appear.
function toCookieEditorJson(cookies: AuthCookie[], previewHost: string | undefined): string {
  const entries = cookies.map((cookie) => {
    const domain = cookie.domain ?? safeHostname(cookie.url) ?? previewHost;
    return {
      name: cookie.name,
      value: cookie.value,
      domain,
      path: cookie.path ?? "/",
      secure: cookie.secure ?? false,
      httpOnly: cookie.httpOnly ?? false,
      sameSite: toCookieEditorSameSite(cookie.sameSite),
      hostOnly: domain == null,
      session: cookie.expires == null,
      expirationDate: cookie.expires,
      storeId: null,
    };
  });
  return JSON.stringify(entries, null, 2);
}

// Cookie-Editor uses the chrome.cookies sameSite vocabulary, where "none" is
// spelled "no_restriction"; anything unrecognized falls back to "unspecified".
function toCookieEditorSameSite(sameSite: string | undefined): string {
  switch (sameSite?.toLowerCase()) {
    case "strict":
      return "strict";
    case "lax":
      return "lax";
    case "none":
      return "no_restriction";
    default:
      return "unspecified";
  }
}

// A console snippet that sets each cookie via `document.cookie` and reloads.
// httpOnly cookies are included as-is; the browser silently ignores the ones it
// won't let JS set, which is fine. The domain is left implicit so each cookie
// binds to whatever host the snippet runs on (the preview).
function toDocumentCookieSnippet(cookies: AuthCookie[]): string {
  const lines = cookies.map((cookie) => {
    const parts = [`${cookie.name}=${cookie.value}`, `path=${cookie.path ?? "/"}`];
    if (cookie.secure === true) parts.push("secure");
    const sameSite = documentCookieSameSite(cookie.sameSite);
    if (sameSite != null) parts.push(`samesite=${sameSite}`);
    return `document.cookie = ${JSON.stringify(parts.join("; "))};`;
  });
  return `${lines.join("\n")}\nlocation.reload();`;
}

// `document.cookie` accepts the capitalized SameSite spelling; "none" needs a
// Secure cookie to be accepted. Unknown values are omitted so the browser
// applies its default.
function documentCookieSameSite(sameSite: string | undefined): string | undefined {
  switch (sameSite?.toLowerCase()) {
    case "strict":
      return "Strict";
    case "lax":
      return "Lax";
    case "none":
      return "None";
    default:
      return undefined;
  }
}

function safeHostname(url: string | undefined): string | undefined {
  if (url == null) return undefined;
  try {
    return new URL(url).hostname;
  } catch (err) {
    console.debug("Failed to parse URL for cookie domain", { url, err });
    return undefined;
  }
}

// "loginUrl" -> "Login URL", "email" -> "Email". Splits camelCase and
// snake_case so arbitrary credential keys read as labels.
function humanize(key: string): string {
  const words = key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/);
  return words.map((word) => (word === "url" ? "URL" : word.charAt(0).toUpperCase() + word.slice(1))).join(" ");
}

// Shown in place of the interactive card when the preview isn't "ready": the
// app can't be signed into, so provisioning is gated behind a reason instead of
// running the options query.
export function TestUserCardUnavailable({ status }: { status: string }) {
  return (
    <div className="border border-border-dim bg-surface-base shadow-sm">
      <TestUserHeader />
      <p className="px-4 py-2.5 text-2xs text-text-secondary">{NOT_READY_REASON[status] ?? DEFAULT_NOT_READY_REASON}</p>
    </div>
  );
}

export function TestUserCardSkeleton() {
  return (
    <div className="border border-border-dim bg-surface-base shadow-sm">
      <TestUserHeader />
      <div className="flex items-center justify-between gap-4 px-4 py-3">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-7 w-32" />
      </div>
    </div>
  );
}
