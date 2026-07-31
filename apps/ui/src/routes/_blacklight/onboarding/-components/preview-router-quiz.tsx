import { Button, cn } from "@autonoma/blacklight";
import { ArrowBendUpRightIcon } from "@phosphor-icons/react/ArrowBendUpRight";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/ArrowCounterClockwise";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { PlugsIcon } from "@phosphor-icons/react/Plugs";
import { SlidersHorizontalIcon } from "@phosphor-icons/react/SlidersHorizontal";
import type { OnboardingSignalProvider } from "lib/onboarding/onboarding-search";
import { type ReactNode, useState } from "react";

/**
 * Routing questionnaire shown to onboarding users who opt out of PreviewKit.
 *
 * "Deployed on a host" is not the same as "has preview environments the way
 * Autonoma needs them" - proper isolated testing needs the whole stack (front +
 * back + db) isolated so a scenario's up/down can create and destroy test data
 * without touching anything real. The quiz first asks which host builds their
 * previews (Vercel or a custom/CI webhook today; Netlify and Render soon), then
 * asks small plain-language questions and infers the cheapest safe path.
 *
 * Question order matters: backend location, then TENANT scoping, and only if
 * that falls through, database branching. Tenant scoping is what most apps can
 * answer yes to and needs no infrastructure, so it exits in two questions;
 * database branching exists on only a handful of managed providers and is worth
 * asking about only once tenant isolation is ruled out. The reason tenant
 * isolation failed is carried into the fallback so a user who fails both is told
 * what actually disqualified them.
 *
 * It routes to one of the two destinations onboarding already has:
 *
 *   - Native (Path A) / tenant isolation (Path B) -> the existing "connect your
 *     deploys" webhook UI (previewEnvironmentMode "existing_deploys").
 *   - PreviewKit -> the existing PreviewKit config flow (previewEnvironmentMode
 *     "previewkit"), when the stack can't be safely isolated on the host alone.
 *
 * Nothing is persisted until an outcome button calls `onChoose`; the answers
 * live entirely in local state.
 */

type QuestionScreen = "previews" | "provider" | "backend" | "tenant" | "global" | "database" | "dbBranch";
type IsolationQuestion = Exclude<QuestionScreen, "provider">;
type PkReason = "noPreviews" | "backend" | "tenant" | "global";
type IsolationPath = "A" | "B";
type Provider = OnboardingSignalProvider;
type Phase = "previews" | "backend" | "database";

/**
 * Where an answer sends the user.
 *
 * `carry` records the isolation gap that sent them down the database-branching
 * fallback. The two PreviewKit targets are deliberately distinct: `pk` names its
 * own reason (used before any carry exists), while `pkCarried` defers to the
 * carried one, so an answer that ends the fallback reports the ORIGINAL
 * disqualifier rather than the question they happened to fail last. Spelling
 * that out in the type keeps a dead reason literal from sitting on the fallback
 * options, where editing it would silently do nothing.
 */
type Target =
  | { screen: QuestionScreen; carry?: PkReason }
  | { path: IsolationPath }
  | { pk: PkReason }
  | { pkCarried: true };

/** Reason used if a `pkCarried` target is somehow reached with no carry - unreachable today. */
const FALLBACK_PK_REASON: PkReason = "tenant";

type ViewState =
  | { kind: "question"; screen: QuestionScreen }
  | { kind: "path"; path: IsolationPath }
  | { kind: "pk"; reason: PkReason };

/** One step of the back stack: the screen plus the carried reason at that point. */
interface HistoryEntry {
  view: ViewState;
  carried?: PkReason;
}

/**
 * The worked schema shown on an answer that is itself an example of a shape -
 * the option renders as a card carrying it, so choosing the shape you recognise
 * IS the answer.
 *
 * Deliberately no "this is the good one" styling: neither shape is a better
 * answer to give, they just route differently, and colouring one pushes people
 * toward the answer they think we want rather than the one that is true.
 */
interface OptionCard {
  /** Illustrative products, e.g. "like Stripe or Slack". Plural: one name reads as a claim about that schema. */
  aside: string;
  lines: string[];
  consequence: string;
}

interface QuizOption {
  label: string;
  sub?: string;
  tile?: boolean;
  logo?: string;
  card?: OptionCard;
  target: Target;
}

interface QuestionNode {
  phase: Phase;
  eyebrow: string;
  title: string;
  subtitle: string;
  picker?: boolean;
  options: QuizOption[];
}

interface PathCopy {
  name: string;
  title: string;
  description: string;
}

interface ProviderTile {
  label: string;
  meta: string;
  visual: ReactNode;
  /** Active tiles carry the provider the quiz proceeds as; "soon" tiles omit it. */
  provider?: Provider;
}

// Vercel is the reference copy - kept verbatim for users coming from Vercel.
//
// Tenant scoping is asked BEFORE database branching, because it is the answer most
// apps land on and it needs no infrastructure: if every row hangs off a deletable
// tenant, a run creates one, tests inside it, and deletes it. Database branching is
// a narrower capability (only the managed providers below offer it) and is only
// worth asking about when tenant isolation has already fallen through.
const NODES_VERCEL: Record<IsolationQuestion, QuestionNode> = {
  previews: {
    phase: "previews",
    eyebrow: "Preview environments",
    title: "Do you have preview environments deployed per branch?",
    subtitle:
      "A live preview URL for every pull request - your own Vercel previews, Netlify or Render, or any CI-driven deploy.",
    options: [
      { label: "Yes", sub: "Every PR already gets its own preview URL.", target: { screen: "provider" } },
      { label: "No", sub: "We'll build and host an isolated preview stack for you.", target: { pk: "noPreviews" } },
    ],
  },
  backend: {
    phase: "backend",
    eyebrow: "Backend",
    title: "Where does your backend and API run?",
    subtitle:
      "Your frontend is already on Vercel. We need to know about everything behind it - API routes, services, jobs.",
    options: [
      { label: "All on Vercel", sub: "Serverless functions or the same Vercel project.", target: { screen: "tenant" } },
      {
        label: "Some or all runs elsewhere",
        sub: "A separate server, another cloud, a managed backend.",
        target: { pk: "backend" },
      },
    ],
  },
  tenant: {
    phase: "database",
    eyebrow: "Test data",
    title: "Is all your data owned by a tenant you could delete in one go?",
    subtitle:
      "An org, workspace or account that owns every row, so deleting it takes its data with it. If so, each run creates its own throwaway tenant and removes it afterwards - nothing else has to change.",
    options: [
      {
        label: "Yes, scoped to a tenant",
        card: {
          aside: "like Stripe or Slack",
          lines: ["account", "└─ customer", "   └─ invoice"],
          consequence: "Delete the account and every row under it goes with it.",
        },
        target: { screen: "global" },
      },
      {
        label: "No, some data is shared",
        card: {
          aside: "like Airbnb, Zillow or Instagram",
          lines: ["user", "listing   → shared by everyone", "review    → shared by everyone"],
          consequence: "Rows one run creates are visible to every other run, and to your real users.",
        },
        target: { screen: "database", carry: "tenant" },
      },
      { label: "Not sure", target: { screen: "database", carry: "tenant" } },
    ],
  },
  global: {
    phase: "database",
    eyebrow: "Test data",
    title: "Any global or shared tables not tied to a tenant?",
    subtitle: "Feature flags, config, counters, cross-tenant references - anything a teardown couldn't safely delete.",
    options: [
      { label: "No, everything's tenant-scoped", target: { path: "B" } },
      { label: "Yes, some global tables", target: { screen: "database", carry: "global" } },
      { label: "Not sure", target: { screen: "database", carry: "global" } },
    ],
  },
  database: {
    phase: "database",
    eyebrow: "Database",
    title: "Which database does your app use?",
    subtitle:
      "Since test data can't be isolated by tenant, the other way is a separate copy of the database per preview. Only some providers can do that - pick the closest match.",
    picker: true,
    options: [
      { label: "Neon", tile: true, logo: "/db/db-neon.svg", target: { screen: "dbBranch" } },
      { label: "Supabase", tile: true, logo: "/db/db-supabase.svg", target: { screen: "dbBranch" } },
      { label: "PlanetScale", tile: true, logo: "/db/db-planetscale.svg", target: { screen: "dbBranch" } },
      {
        label: "Something else",
        sub: "Plain Postgres, RDS, MongoDB, MySQL, and the like.",
        target: { pkCarried: true },
      },
      { label: "Not sure", target: { pkCarried: true } },
    ],
  },
  // Host-neutral on purpose: this asks about the database, not about who builds
  // the preview, so naming the host adds nothing - and keeping it neutral means
  // the custom path needs no override of its own.
  dbBranch: {
    phase: "database",
    eyebrow: "Database",
    title: "Does every preview get its own database branch?",
    subtitle:
      "A database branch, not a git one - Neon, Supabase and PlanetScale can fork the whole database per preview. Previews point at the production database by default, so this only happens if it has been wired up.",
    options: [
      { label: "Yes, it's wired up", target: { path: "A" } },
      { label: "Not yet - set it up for me", target: { path: "A" } },
      { label: "No / not sure", target: { pkCarried: true } },
    ],
  },
};

// Custom (non-Vercel) path: same isolation logic, provider-neutral wording. Only
// the questions whose copy names Vercel are overridden; the rest reuse Vercel's.
const NODES_CUSTOM_OVERRIDES: Partial<Record<IsolationQuestion, QuestionNode>> = {
  backend: {
    phase: "backend",
    eyebrow: "Backend",
    title: "Where does your backend and API run?",
    subtitle: "We need to know about everything behind your frontend - API routes, services, jobs.",
    options: [
      {
        label: "All in one deployable unit",
        sub: "Frontend and backend ship together in each preview.",
        target: { screen: "tenant" },
      },
      {
        label: "Some or all runs elsewhere",
        sub: "A separate server, another cloud, a managed backend.",
        target: { pk: "backend" },
      },
    ],
  },
};

// The tenant / global reasons are only reachable after the database-branching
// fallback has ALSO been ruled out, so they say so - otherwise someone who just
// answered a database question gets told only about tenants.
const PK_REASONS: Record<PkReason, string> = {
  noPreviews: "We'll build and host an isolated stack for you.",
  backend: "Backend or services run outside your preview host, so the whole stack can't be isolated.",
  tenant:
    "Data isn't cleanly tenant-scoped, and there's no per-preview database branch to fall back on, so a teardown can't safely delete test data.",
  global:
    "Global / shared tables exist that a tenant teardown would leak into, and there's no per-preview database branch to fall back on.",
};

const PATH_COPY_VERCEL: Record<IsolationPath, PathCopy> = {
  A: {
    name: "Vercel-native",
    title: "You're set for Vercel-native testing",
    description:
      "Scenarios run against a fresh database branch created for each preview. Teardown just discards the branch - nothing shared to clean up.",
  },
  B: {
    name: "Vercel + tenant isolation",
    title: "You're set for Vercel + tenant isolation",
    description:
      "Scenarios run inside a throwaway tenant. Teardown deletes that tenant and everything under it - no global tables to leak into.",
  },
};

const PATH_COPY_CUSTOM: Record<IsolationPath, PathCopy> = {
  A: {
    name: "Branch-per-preview",
    title: "You're set for branch-per-preview testing",
    description:
      "Scenarios run against a fresh database branch created for each preview. Teardown just discards the branch - nothing shared to clean up.",
  },
  B: {
    name: "Tenant isolation",
    title: "You're set for tenant isolation",
    description:
      "Scenarios run inside a throwaway tenant. Teardown deletes that tenant and everything under it - no global tables to leak into.",
  },
};

const PHASE_OF: Record<QuestionScreen, Phase> = {
  previews: "previews",
  provider: "previews",
  backend: "backend",
  tenant: "database",
  global: "database",
  database: "database",
  dbBranch: "database",
};

type PhaseStep = { num: string; label: string; phase: Phase };

const PHASES_WITH_PROVIDER: PhaseStep[] = [
  { num: "01", label: "Previews", phase: "previews" },
  { num: "02", label: "Backend", phase: "backend" },
  { num: "03", label: "Database", phase: "database" },
];

// When arriving from Vercel the intro (the per-branch-previews gate + provider
// picker) is skipped, so the Previews phase drops out and the rest renumber.
const PHASES_WITHOUT_PROVIDER: PhaseStep[] = [
  { num: "01", label: "Backend", phase: "backend" },
  { num: "02", label: "Database", phase: "database" },
];

const PROVIDER_TILES: ProviderTile[] = [
  { label: "Vercel", meta: "Connect project", visual: <VercelMark />, provider: "vercel" },
  { label: "Custom", meta: "Signed webhook", visual: <SlidersHorizontalIcon size={22} />, provider: "custom" },
  { label: "Netlify", meta: "Soon", visual: <PlugsIcon size={22} /> },
  { label: "Render", meta: "Soon", visual: <PlugsIcon size={22} /> },
];

const DEFAULT_PROVIDER: Provider = "vercel";

function nodeFor(screen: IsolationQuestion, provider: Provider): QuestionNode {
  if (provider === "custom") return NODES_CUSTOM_OVERRIDES[screen] ?? NODES_VERCEL[screen];
  return NODES_VERCEL[screen];
}

function pathCopyFor(path: IsolationPath, provider: Provider): PathCopy {
  return provider === "custom" ? PATH_COPY_CUSTOM[path] : PATH_COPY_VERCEL[path];
}

export interface PreviewRouterQuizProps {
  appId?: string;
  /**
   * Commit the routing decision. Reuses the existing preview-environment mutation + navigation.
   * `provider` (only for existing_deploys) preselects the matching tab on the destination screen.
   */
  onChoose: (mode: "previewkit" | "existing_deploys", provider?: Provider) => void;
  /** Fired when Back is pressed on the first screen - returns to the repo step. */
  onBack: () => void;
  /**
   * When set, the quiz skips its intro (the per-branch-previews gate + provider
   * picker) and starts on the backend question with this provider preselected
   * (used for users arriving from that host, e.g. Vercel).
   */
  startProvider?: Provider;
}

export function PreviewRouterQuiz({ appId, onChoose, onBack, startProvider }: PreviewRouterQuizProps) {
  const skipIntro = startProvider != null;
  const initialView: ViewState = skipIntro
    ? { kind: "question", screen: "backend" }
    : { kind: "question", screen: "previews" };
  const initialProvider: Provider = startProvider ?? DEFAULT_PROVIDER;
  const phases = skipIntro ? PHASES_WITHOUT_PROVIDER : PHASES_WITH_PROVIDER;
  const [view, setView] = useState<ViewState>(initialView);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [provider, setProvider] = useState<Provider>(initialProvider);
  const [carried, setCarried] = useState<PkReason | undefined>(undefined);

  function go(target: Target) {
    setHistory((h) => [...h, { view, carried }]);
    if ("screen" in target) {
      if (target.carry != null) setCarried(target.carry);
      return setView({ kind: "question", screen: target.screen });
    }
    if ("path" in target) return setView({ kind: "path", path: target.path });
    // Ending the database fallback reports what actually disqualified them (the
    // carry), not that branching wasn't set up either.
    if ("pkCarried" in target) return setView({ kind: "pk", reason: carried ?? FALLBACK_PK_REASON });
    return setView({ kind: "pk", reason: target.pk });
  }

  function pickProvider(next: Provider) {
    setProvider(next);
    go({ screen: "backend" });
  }

  function back() {
    if (history.length === 0) return onBack();
    const previous = history[history.length - 1];
    if (previous == null) return onBack();
    setHistory((h) => h.slice(0, -1));
    setView(previous.view);
    setCarried(previous.carried);
  }

  function restart() {
    setHistory([]);
    setProvider(initialProvider);
    setCarried(undefined);
    setView(initialView);
  }

  const activePhase = view.kind === "question" ? PHASE_OF[view.screen] : undefined;

  return (
    <div className="mx-auto w-full max-w-xl">
      <QuizFadeStyles />
      <div className="relative border border-border-dim bg-surface-base">
        <CornerAccents />

        <div className="flex min-h-[34rem] flex-col p-8">
          <header className="flex flex-col gap-1">
            <span className="font-mono text-4xs font-semibold uppercase tracking-widest text-text-secondary">
              Autonoma · Environment setup
            </span>
            <span className="text-sm font-medium text-text-primary">Finding the best test setup for your app</span>
          </header>

          <div className="mt-5 h-px bg-border-dim" />

          {activePhase != null ? <PhaseProgress activePhase={activePhase} phases={phases} /> : undefined}

          <div key={viewKey(view)} className="quiz-fade mt-7 flex-1">
            {view.kind === "question" ? (
              view.screen === "provider" ? (
                <ProviderPicker onPick={pickProvider} />
              ) : (
                <QuestionView node={nodeFor(view.screen, provider)} onSelect={go} />
              )
            ) : view.kind === "path" ? (
              <PathOutcome
                copy={pathCopyFor(view.path, provider)}
                disabled={appId == null}
                onContinue={() => onChoose("existing_deploys", provider)}
              />
            ) : (
              <PkOutcome reason={view.reason} disabled={appId == null} onContinue={() => onChoose("previewkit")} />
            )}
          </div>

          <footer className="mt-6 flex items-center justify-between border-t border-border-dim pt-5">
            <button
              type="button"
              onClick={back}
              className="inline-flex items-center gap-1.5 font-sans text-2xs text-text-secondary transition-colors hover:text-text-primary"
            >
              <ArrowLeftIcon size={14} />
              Back
            </button>
            <button
              type="button"
              onClick={restart}
              className="inline-flex items-center gap-1.5 font-mono text-3xs font-semibold uppercase tracking-widest text-text-secondary transition-colors hover:text-primary-ink"
            >
              <ArrowCounterClockwiseIcon size={12} />
              Restart
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}

function viewKey(view: ViewState): string {
  if (view.kind === "question") return view.screen;
  if (view.kind === "path") return `path-${view.path}`;
  return `pk-${view.reason}`;
}

function PhaseProgress({ activePhase, phases }: { activePhase: Phase; phases: PhaseStep[] }) {
  const currentIndex = phases.findIndex((p) => p.phase === activePhase);
  return (
    <div className="mt-5 flex items-center gap-6">
      {phases.map((phase, index) => {
        const isDone = index < currentIndex;
        const isCurrent = index === currentIndex;
        return (
          <div key={phase.phase} className="flex items-center gap-2">
            <span
              className={cn(
                "size-2.5 rounded-full border",
                isDone
                  ? "border-primary-ink bg-primary-ink"
                  : isCurrent
                    ? "border-primary-ink bg-transparent shadow-[0_0_8px_var(--accent-glow)]"
                    : "border-border-mid bg-transparent",
              )}
            />
            <span
              className={cn(
                "font-mono text-3xs font-semibold uppercase tracking-widest",
                isCurrent ? "text-primary-ink" : "text-text-secondary",
              )}
            >
              {phase.num} {phase.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ProviderPicker({ onPick }: { onPick: (provider: Provider) => void }) {
  return (
    <div className="max-w-lg">
      <div className="font-mono text-4xs font-semibold uppercase tracking-widest text-text-secondary">Previews</div>
      <h1 className="mt-3 text-2xl font-semibold leading-tight tracking-tight text-text-primary">
        Where do your preview deployments come from?
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-text-secondary">
        We hook into the previews you already build - pick your host so we tailor the checks.
      </p>

      <div className="mt-6 grid grid-cols-2 gap-2.5">
        {PROVIDER_TILES.map((tile) => (
          <ProviderTileButton key={tile.label} tile={tile} onPick={onPick} />
        ))}
      </div>
    </div>
  );
}

function ProviderTileButton({ tile, onPick }: { tile: ProviderTile; onPick: (provider: Provider) => void }) {
  const selectable = tile.provider != null;
  const content = (
    <>
      <div className="text-text-secondary">{tile.visual}</div>
      <span className="text-sm font-semibold text-text-primary">{tile.label}</span>
      <span className="font-mono text-3xs uppercase tracking-widest text-text-secondary">{tile.meta}</span>
    </>
  );

  if (!selectable) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 border border-border-dim bg-surface-base px-4 py-6 opacity-50">
        {content}
      </div>
    );
  }

  const provider = tile.provider;
  return (
    <button
      type="button"
      onClick={() => (provider != null ? onPick(provider) : undefined)}
      className="flex flex-col items-center justify-center gap-2 border border-border-mid bg-transparent px-4 py-6 transition-all hover:-translate-y-0.5 hover:border-border-highlight hover:bg-surface-raised"
    >
      {content}
    </button>
  );
}

function QuestionView({ node, onSelect }: { node: QuestionNode; onSelect: (target: Target) => void }) {
  const tiles = node.options.filter((o) => o.tile);
  const cards = node.options.filter((o) => o.card != null);
  const rows = node.options.filter((o) => !o.tile && o.card == null);
  // Both the tile picker and the example cards lay their options out in a grid,
  // with the leftovers ("Something else", "Not sure") as wide rows tucked under
  // it - so the gap above those rows tightens the same way either way.
  const hasGrid = node.picker === true || cards.length > 0;

  return (
    <div className="max-w-lg">
      <div className="font-mono text-4xs font-semibold uppercase tracking-widest text-text-secondary">
        {node.eyebrow}
      </div>
      <h1 className="mt-3 text-2xl font-semibold leading-tight tracking-tight text-text-primary">{node.title}</h1>
      <p className="mt-3 text-sm leading-relaxed text-text-secondary">{node.subtitle}</p>

      {node.picker ? (
        <div className="mt-6 grid grid-cols-3 gap-2.5">
          {tiles.map((option) => (
            <button
              key={option.label}
              type="button"
              onClick={() => onSelect(option.target)}
              className="flex aspect-square flex-col items-center justify-center gap-3.5 border border-border-mid bg-transparent transition-all hover:-translate-y-0.5 hover:border-border-highlight hover:bg-surface-raised"
            >
              {option.logo != null ? <img src={option.logo} alt="" className="h-7 w-auto" /> : undefined}
              <span className="text-sm font-semibold text-text-primary">{option.label}</span>
            </button>
          ))}
        </div>
      ) : undefined}

      {cards.length > 0 ? (
        <div className="mt-6 grid gap-2.5 sm:grid-cols-2">
          {cards.map((option) => (
            <ExampleOptionCard key={option.label} option={option} onSelect={() => onSelect(option.target)} />
          ))}
        </div>
      ) : undefined}

      <div className={cn("flex flex-col gap-2.5", hasGrid ? "mt-2.5" : "mt-6")}>
        {rows.map((option) => (
          <OptionRow key={option.label} option={option} onSelect={() => onSelect(option.target)} />
        ))}
      </div>
    </div>
  );
}

/**
 * An answer that is itself an example of a data shape: the schema, who it looks
 * like, and what it costs a test run. "Is your data tenant-scoped?" is abstract
 * enough that people answer it wrong about their own schema, so the answer is
 * the shape you recognise rather than a yes/no you have to translate first.
 *
 * Both cards are styled identically. These are answers, not recommendations, and
 * any colour that singles one out reads either as "already selected" or as the
 * answer we are hoping for - both of which bias a question whose only value is a
 * truthful answer about the user's own schema.
 */
function ExampleOptionCard({ option, onSelect }: { option: QuizOption; onSelect: () => void }) {
  const card = option.card;
  if (card == null) return undefined;
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex flex-col border border-border-mid bg-surface-void p-3 text-left transition-all hover:-translate-y-0.5 hover:border-border-highlight hover:bg-surface-raised"
    >
      {/* Label and aside stack rather than sharing a baseline: side by side, a
          label that wraps shifts its card's body out of line with its neighbour. */}
      <span className="flex w-full flex-col gap-0.5">
        <span className="text-2xs font-semibold leading-tight text-text-primary">{option.label}</span>
        <span className="text-3xs italic leading-tight text-text-secondary">{card.aside}</span>
      </span>
      <pre className="mt-2.5 w-full overflow-x-auto font-mono text-3xs leading-relaxed text-text-primary">
        {card.lines.join("\n")}
      </pre>
      <span className="mt-2.5 text-3xs leading-snug text-text-secondary">{card.consequence}</span>
    </button>
  );
}

function OptionRow({ option, onSelect }: { option: QuizOption; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-3.5 border border-border-mid bg-transparent px-4 py-3.5 text-left transition-all hover:translate-x-0.5 hover:border-border-highlight hover:bg-surface-raised"
    >
      <span className="flex flex-1 flex-col">
        <span className="text-sm font-semibold leading-tight text-text-primary">{option.label}</span>
        {option.sub != null ? (
          <span className="mt-0.5 text-2xs leading-snug text-text-secondary">{option.sub}</span>
        ) : undefined}
      </span>
      <ArrowRightIcon size={15} className="shrink-0 text-text-secondary" />
    </button>
  );
}

function PathOutcome({ copy, disabled, onContinue }: { copy: PathCopy; disabled: boolean; onContinue: () => void }) {
  return (
    <div className="max-w-lg">
      <div className="flex items-center gap-2">
        <CheckCircleIcon size={16} weight="fill" className="text-primary-ink" />
        <span className="font-mono text-4xs font-semibold uppercase tracking-widest text-primary-ink">
          Proposed path
        </span>
      </div>
      <h1 className="mt-3 text-2xl font-medium leading-tight tracking-tight text-text-primary">{copy.title}</h1>
      <p className="mt-3 text-sm leading-relaxed text-text-secondary">{copy.description}</p>

      <div className="mt-5 inline-flex items-center gap-2.5 border border-border-dim bg-surface-void px-3 py-2">
        <span className="font-mono text-4xs font-semibold uppercase tracking-widest text-text-secondary">Path</span>
        <span className="size-1.5 rounded-full bg-primary-ink shadow-[0_0_6px_var(--accent-glow)]" />
        <span className="text-2xs font-semibold text-text-primary">{copy.name}</span>
      </div>

      <div className="mt-6">
        <Button variant="accent" className="gap-2 px-6 py-3" disabled={disabled} onClick={onContinue}>
          Continue setup
          <ArrowRightIcon size={16} weight="bold" />
        </Button>
      </div>
      <p className="mt-4 text-2xs leading-snug text-text-secondary">
        Proposed only. We confirm it with a safe dry-run later, after analyzing your codebase - never on your answers
        alone.
      </p>
    </div>
  );
}

function PkOutcome({ reason, disabled, onContinue }: { reason: PkReason; disabled: boolean; onContinue: () => void }) {
  return (
    <div className="max-w-lg">
      <div className="flex items-center gap-2">
        <ArrowBendUpRightIcon size={15} className="text-primary-ink" />
        <span className="font-mono text-4xs font-semibold uppercase tracking-widest text-primary-ink">
          Routing to PreviewKit
        </span>
      </div>
      <h1 className="mt-3 text-2xl font-medium leading-tight tracking-tight text-text-primary">
        We'll set you up with PreviewKit
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-text-secondary">
        Your stack needs a fully isolated environment - frontend, backend and database together - so a run can create
        and destroy test data without touching anything real. PreviewKit gives you exactly that.
      </p>

      <div className="mt-5 border-l-2 border-primary-ink bg-surface-void px-4 py-3">
        <span className="text-2xs leading-snug text-text-secondary">
          {/* The isolation-gap exits state a diagnosis ("Reason: ..."); the no-previews exit is
              just what we'll do, so it reads as a plain statement without the label. */}
          {reason === "noPreviews" ? undefined : "Reason: "}
          <span className="font-semibold text-text-primary">{PK_REASONS[reason]}</span>
        </span>
      </div>

      <div className="mt-6">
        <Button variant="accent" className="gap-2 px-6 py-3" disabled={disabled} onClick={onContinue}>
          Continue to PreviewKit setup
          <ArrowRightIcon size={16} weight="bold" />
        </Button>
      </div>
      <p className="mt-4 text-2xs leading-snug text-text-secondary">
        Hands off to the PreviewKit onboarding you already have.
      </p>
    </div>
  );
}

function VercelMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5 fill-current">
      <path d="M12 4 22 20H2L12 4Z" />
    </svg>
  );
}

function CornerAccents() {
  const base = "pointer-events-none absolute size-2 border-border-highlight";
  return (
    <>
      <span className={cn(base, "-left-px -top-px border-l border-t")} />
      <span className={cn(base, "-right-px -top-px border-r border-t")} />
      <span className={cn(base, "-bottom-px -left-px border-b border-l")} />
      <span className={cn(base, "-bottom-px -right-px border-b border-r")} />
    </>
  );
}

function QuizFadeStyles() {
  return (
    <style>{`
      @keyframes quizFade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
      .quiz-fade { animation: quizFade 0.22s ease; }
      @media (prefers-reduced-motion: reduce) { .quiz-fade { animation: none; } }
    `}</style>
  );
}
