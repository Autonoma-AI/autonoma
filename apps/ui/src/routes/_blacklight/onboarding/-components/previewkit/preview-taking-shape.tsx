import {
  Badge,
  Drawer,
  DrawerBackdrop,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@autonoma/blacklight";
import { type Build, isPreviewkitDatabaseEngine } from "@autonoma/types";
import { CubeIcon } from "@phosphor-icons/react/Cube";
import { DatabaseIcon } from "@phosphor-icons/react/Database";
import { KeyIcon } from "@phosphor-icons/react/Key";
import { type Icon } from "@phosphor-icons/react/lib";
import { LockSimpleIcon } from "@phosphor-icons/react/LockSimple";
import { StackIcon } from "@phosphor-icons/react/Stack";
import { XIcon } from "@phosphor-icons/react/X";
import { usePreviewkitConfig } from "lib/onboarding/onboarding-api";
import { useState } from "react";

// The value shown for a secret key - the actual value never reaches this UI (it lives
// only in the user's browser and AWS Secrets Manager), so we show the key and a note.
const SECRET_PLACEHOLDER = "set in the Autonoma UI";

const DRAWER_FOOTER_NOTE = "Configured by your coding agent via MCP. Take over to edit any of this in the setup UI.";

interface DetailRow {
  label: string;
  value: string;
}

interface DetailSection {
  heading: string;
  rows: DetailRow[];
}

interface ConfigCard {
  id: string;
  icon: Icon;
  kicker: string;
  title: string;
  summary: string;
  sections: DetailSection[];
}

/**
 * The "Preview taking shape" column: a read-only card per piece of the config the
 * agent has written (each app, database, service, and the variables). Clicking a
 * card opens a read-only drawer with that item's detail - the user watches what the
 * agent set up without an editable surface they are told not to touch.
 */
export function PreviewTakingShape({ applicationId }: { applicationId: string }) {
  const { data } = usePreviewkitConfig(applicationId);
  const [openCardId, setOpenCardId] = useState<string | undefined>(undefined);

  const cards = buildCards(data.document);
  const openCard = cards.find((card) => card.id === openCardId);

  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-center gap-1.5 font-mono text-2xs uppercase tracking-widest text-text-secondary">
        <StackIcon size={13} />
        Preview taking shape
      </p>

      {cards.length === 0 ? (
        <p className="font-mono text-2xs text-text-secondary">The agent hasn't written a configuration yet…</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {cards.map((card) => (
            <CardRow key={card.id} card={card} onOpen={() => setOpenCardId(card.id)} />
          ))}
        </div>
      )}

      <p className="pt-1 font-mono text-2xs text-text-secondary">
        You don't have to touch any of this - the agent fills it in from your repo and asks only if something's
        ambiguous.
      </p>

      <Drawer
        side="right"
        open={openCard != null}
        onOpenChange={(open) => {
          if (!open) setOpenCardId(undefined);
        }}
      >
        <DrawerBackdrop />
        <DrawerContent side="right" className="flex w-96 flex-col gap-5 overflow-y-auto">
          {openCard != null ? <CardDetail card={openCard} /> : undefined}
        </DrawerContent>
      </Drawer>
    </div>
  );
}

function CardRow({ card, onOpen }: { card: ConfigCard; onOpen: () => void }) {
  const CardIcon = card.icon;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex items-center gap-3 border border-border-dim bg-surface-void px-3 py-2 text-left transition-colors hover:border-border-mid"
    >
      <CardIcon size={16} className="shrink-0 text-text-secondary" />
      <div className="flex min-w-0 flex-col">
        <span className="font-mono text-3xs uppercase tracking-widest text-text-secondary">{card.kicker}</span>
        <span className="truncate font-mono text-2xs text-text-primary">{card.summary}</span>
      </div>
      <span className="ml-auto font-mono text-3xs uppercase tracking-widest text-text-secondary group-hover:text-primary">
        View
      </span>
    </button>
  );
}

function CardDetail({ card }: { card: ConfigCard }) {
  const CardIcon = card.icon;
  return (
    <>
      <DrawerHeader className="gap-2 pb-0">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <CardIcon size={18} className="text-primary" />
            <div className="flex flex-col">
              <span className="font-mono text-3xs uppercase tracking-widest text-text-secondary">{card.kicker}</span>
              <DrawerTitle className="text-sm normal-case">{card.title}</DrawerTitle>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="gap-1 font-mono text-3xs">
              <LockSimpleIcon size={11} />
              read only
            </Badge>
            <DrawerClose
              render={
                <button
                  type="button"
                  aria-label="Close"
                  className="text-text-secondary transition-colors hover:text-text-primary"
                >
                  <XIcon size={16} />
                </button>
              }
            />
          </div>
        </div>
      </DrawerHeader>

      <div className="flex flex-col gap-5">
        {card.sections.map((section) => (
          <div key={section.heading} className="flex flex-col gap-2">
            <p className="font-mono text-3xs uppercase tracking-widest text-primary">{section.heading}</p>
            <div className="flex flex-col gap-1.5">
              {section.rows.map((row) => (
                <div key={row.label} className="flex flex-col gap-0.5">
                  <span className="font-mono text-3xs uppercase tracking-wider text-text-secondary">{row.label}</span>
                  <span className="whitespace-pre-wrap break-words border border-border-dim bg-surface-void px-2.5 py-1.5 font-mono text-2xs text-text-primary">
                    {row.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <p className="mt-auto border-t border-border-dim pt-4 font-mono text-2xs text-text-secondary">
        {DRAWER_FOOTER_NOTE}
      </p>
    </>
  );
}

function buildCards(document: ReturnType<typeof usePreviewkitConfig>["data"]["document"]): ConfigCard[] {
  if (document == null) return [];
  const apps = document.apps;
  const services = document.services ?? [];
  const addons = document.addons ?? [];

  const cards: ConfigCard[] = [];

  for (const app of apps) {
    const identity: DetailRow[] = [
      { label: "name", value: app.name },
      { label: "port", value: String(app.port) },
    ];
    if (app.health_check != null) identity.push({ label: "health check", value: app.health_check });

    cards.push({
      id: `app:${app.name}`,
      icon: CubeIcon,
      kicker: "application",
      title: app.name,
      summary: `${app.name} · ${buildMethodLabel(app.build)}`,
      sections: [
        { heading: "identity", rows: identity },
        { heading: "build", rows: buildDetailRows(app.build) },
      ],
    });
  }

  for (const service of services) {
    const isDatabase = isPreviewkitDatabaseEngine(service.recipe);
    const rows: DetailRow[] = [
      { label: "name", value: service.name },
      { label: "engine", value: service.recipe },
    ];
    if (service.version != null) rows.push({ label: "version", value: service.version });
    cards.push({
      id: `service:${service.name}`,
      icon: isDatabase ? DatabaseIcon : StackIcon,
      kicker: isDatabase ? "database" : "service",
      title: service.name,
      summary: `${service.name} · ${service.recipe}${service.version != null ? ` ${service.version}` : ""}`,
      sections: [{ heading: "config", rows }],
    });
  }

  for (const addon of addons) {
    cards.push({
      id: `addon:${addon.name}`,
      icon: StackIcon,
      kicker: "extra service",
      title: addon.name,
      summary: `${addon.name} · ${addon.provider}`,
      sections: [
        {
          heading: "config",
          rows: [
            { label: "name", value: addon.name },
            { label: "provider", value: addon.provider },
          ],
        },
      ],
    });
  }

  const variablesCard = buildVariablesCard(apps);
  if (variablesCard != null) cards.push(variablesCard);

  return cards;
}

function buildVariablesCard(
  apps: NonNullable<ReturnType<typeof usePreviewkitConfig>["data"]["document"]>["apps"],
): ConfigCard | undefined {
  const secrets: DetailRow[] = [];
  const connections: DetailRow[] = [];
  for (const app of apps) {
    for (const key of app.build_secrets) secrets.push({ label: key, value: SECRET_PLACEHOLDER });
    for (const connection of app.connections) connections.push({ label: connection.key, value: connection.value });
  }
  if (secrets.length === 0 && connections.length === 0) return undefined;

  const sections: DetailSection[] = [];
  if (secrets.length > 0) sections.push({ heading: "secrets", rows: secrets });
  if (connections.length > 0) sections.push({ heading: "connections", rows: connections });

  const summaryParts: string[] = [];
  if (secrets.length > 0) summaryParts.push(`${secrets.length} secret${secrets.length === 1 ? "" : "s"}`);
  if (connections.length > 0) {
    summaryParts.push(`${connections.length} connection${connections.length === 1 ? "" : "s"}`);
  }

  return {
    id: "variables",
    icon: KeyIcon,
    kicker: "variables",
    title: "Variables",
    summary: summaryParts.join(" · "),
    sections,
  };
}

function buildMethodLabel(build: Build | undefined): string {
  if (build == null) return "auto";
  if (build.framework === "runtime") return `${build.runtime} runtime`;
  return build.framework;
}

function buildDetailRows(build: Build | undefined): DetailRow[] {
  if (build == null) return [{ label: "method", value: "auto-detected" }];

  if (build.framework === "dockerfile") {
    const rows: DetailRow[] = [
      { label: "method", value: "dockerfile" },
      { label: "dockerfile", value: build.dockerfile },
    ];
    if (build.target != null) rows.push({ label: "target", value: build.target });
    rows.push({ label: "context", value: build.build_context });
    return rows;
  }

  if (build.framework === "runtime") {
    const rows: DetailRow[] = [
      { label: "method", value: "manual runtime" },
      { label: "runtime", value: build.runtime },
      { label: "version", value: build.version ?? "default" },
    ];
    if (build.build_script != null) rows.push({ label: "build script", value: build.build_script });
    rows.push({ label: "entrypoint", value: build.entrypoint });
    rows.push({ label: "context", value: build.build_context });
    return rows;
  }

  if (build.framework === "bun") {
    return [
      { label: "method", value: "bun" },
      { label: "install", value: build.install_command ?? "default" },
      { label: "build", value: build.build_command ?? "default" },
      { label: "start", value: build.run_command ?? "default" },
      { label: "context", value: build.build_context },
    ];
  }

  return [
    { label: "method", value: build.framework },
    { label: "node", value: build.node_version },
    { label: "package manager", value: build.package_manager },
    { label: "install", value: build.install_command ?? "default" },
    { label: "build", value: build.build_command ?? "default" },
    { label: "start", value: build.run_command ?? "default" },
    { label: "context", value: build.build_context },
  ];
}
