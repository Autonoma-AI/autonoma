import { previewConfigSchema } from "@autonoma/types";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { userEvent, within } from "storybook/test";
import { BranchMatchingField } from "../routes/_blacklight/onboarding/-components/previewkit/branch-matching-field";
import { DatabaseSection } from "../routes/_blacklight/onboarding/-components/previewkit/database-section";
import { HooksSection } from "../routes/_blacklight/onboarding/-components/previewkit/hooks-section";
import { ServiceCard } from "../routes/_blacklight/onboarding/-components/previewkit/service-card";
import {
  draftFromConfig,
  hookFieldErrors,
  serviceRecipeIsDatabase,
  type BranchConventionDraft,
  type HooksDraft,
  type ServiceDraft,
} from "../routes/_blacklight/onboarding/-components/previewkit/topology-draft";

// A two-app storefront on Postgres, with the database setup tasks and the
// lifecycle hooks a Prisma-backed project ends up with. Parsed through the real
// config schema so the drafts match what the editor loads from a saved config.
const storefrontConfig = previewConfigSchema.parse({
  version: 1,
  apps: [
    {
      name: "storefront",
      path: "apps/web",
      port: 3000,
      primary: true,
      dockerfile: "apps/web/Dockerfile",
      connections: [{ key: "DATABASE_URL", value: "{{db.url}}" }],
    },
    {
      name: "checkout-api",
      path: "apps/api",
      port: 8080,
      dockerfile: "apps/api/Dockerfile",
      connections: [{ key: "DATABASE_URL", value: "{{db.url}}" }],
    },
  ],
  services: [
    {
      name: "db",
      recipe: "postgres",
      version: "16",
      setup_tasks: [
        {
          command: "pnpm prisma migrate deploy\npnpm prisma db seed",
          frequency: "on_create",
          location: { type: "in_build", app: "checkout-api", position: "after" },
        },
        {
          command: "pnpm prisma migrate deploy",
          frequency: "every_commit",
          location: { type: "in_build", app: "checkout-api", position: "after" },
        },
      ],
    },
  ],
  hooks: {
    pre_deploy: [{ app: "checkout-api", command: "pnpm prisma migrate deploy" }],
    post_deploy: [{ app: "checkout-api", command: "pnpm run seed:demo-orders" }],
  },
});

const storefrontDraft = draftFromConfig(storefrontConfig, [], "saved");
const storefrontAppNames = storefrontDraft.apps.map((app) => app.name);
const storefrontDatabases = storefrontDraft.services.filter((service) => serviceRecipeIsDatabase(service.recipe));

// A Mailpit dev-mail container: the "extra service" shape - a user-supplied
// image with its own ports and plain environment variables.
const mailpitConfig = previewConfigSchema.parse({
  version: 1,
  apps: [{ name: "storefront", path: "apps/web", port: 3000, primary: true, dockerfile: "apps/web/Dockerfile" }],
  services: [
    {
      name: "mailpit",
      recipe: "docker-image",
      options: {
        image: "axllent/mailpit:v1.21",
        port_definition: { name: "web", port: 8025 },
        additional_ports: [{ name: "smtp", port: 1025 }],
        env: [
          { key: "MP_SMTP_AUTH_ACCEPT_ANY", value: "1" },
          { key: "MP_MAX_MESSAGES", value: "500" },
        ],
      },
    },
  ],
});

// The same container with an HTTP readiness probe recorded, so the probe's
// conditional fields (path, port, delays) come back out of the options bag.
const mailpitProbeConfig = previewConfigSchema.parse({
  version: 1,
  apps: [{ name: "storefront", path: "apps/web", port: 3000, primary: true, dockerfile: "apps/web/Dockerfile" }],
  services: [
    {
      name: "mailpit",
      recipe: "docker-image",
      options: {
        image: "axllent/mailpit:v1.21",
        port_definition: { name: "web", port: 8025 },
        additional_ports: [{ name: "smtp", port: 1025 }],
        env: [
          { key: "MP_SMTP_AUTH_ACCEPT_ANY", value: "1" },
          { key: "MP_MAX_MESSAGES", value: "500" },
        ],
        readiness: {
          http: { path: "/readyz", port_definition: { port: 8025 } },
          initial_delay_seconds: 5,
          period_seconds: 10,
        },
      },
    },
  ],
});

const mailpitService = draftFromConfig(mailpitConfig, [], "saved").services[0]!;
const mailpitProbeService = draftFromConfig(mailpitProbeConfig, [], "saved").services[0]!;

// A preview spanning a second repo, on the regex branch-matching rule: a PR on
// `feature/checkout-v2` builds the dependency repo's `checkout-v2` branch.
const multirepoConfig = previewConfigSchema.parse({
  version: 1,
  apps: [{ name: "storefront", path: "apps/web", port: 3000, primary: true, dockerfile: "apps/web/Dockerfile" }],
  config: {
    multirepo: {
      branch_convention: { type: "regex", pattern: "^feature/(.+)$", replacement: "$1" },
      repos: [{ name: "payments-api", repo: "acme/payments-api", fallback_branch: "main" }],
    },
  },
});

const regexConvention = draftFromConfig(multirepoConfig, [], "saved").branchConvention;

function DatabaseEditor({ initial, appNames }: { initial: ServiceDraft[]; appNames: string[] }) {
  const [databases, setDatabases] = useState(initial);
  return (
    <DatabaseSection
      databases={databases}
      existingNames={databases.map((database) => database.name)}
      appNames={appNames}
      repos={[]}
      onChange={setDatabases}
    />
  );
}

function ServiceEditor({ initial }: { initial: ServiceDraft }) {
  const [service, setService] = useState(initial);
  return (
    <ServiceCard
      service={service}
      onUpdate={(patch) => setService((current) => ({ ...current, ...patch }))}
      onRemove={() => setService(initial)}
    />
  );
}

function BranchMatchingEditor({ initial }: { initial: BranchConventionDraft }) {
  const [convention, setConvention] = useState(initial);
  return <BranchMatchingField convention={convention} onChange={setConvention} />;
}

function HooksEditor({ initial, appNames }: { initial: HooksDraft; appNames: string[] }) {
  const [hooks, setHooks] = useState(initial);
  return (
    <HooksSection hooks={hooks} appNames={appNames} errors={hookFieldErrors(hooks, appNames)} onChange={setHooks} />
  );
}

const meta = {
  title: "Onboarding/PreviewConfigSections",
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-5xl bg-surface-void p-14">
        <Story />
      </div>
    ),
  ],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The Database step before anything is added: the engine palette, one card per
 * supported engine (Postgres, MySQL, Redis, Valkey, MongoDB), each showing the
 * version and container port it provisions.
 */
export const DatabaseEnginePalette: Story = {
  render: () => <DatabaseEditor initial={[]} appNames={storefrontAppNames} />,
};

/**
 * A Postgres database with both setup groups filled - schema + seed on create,
 * migrations on every commit. Each task carries the Where control (in the build
 * vs its own job), the App picker the second app unlocks, the Phase sub-control
 * nested under "In the build", and the explainer contrasting the two.
 */
export const SetupTaskWhere: Story = {
  render: () => <DatabaseEditor initial={storefrontDatabases} appNames={storefrontAppNames} />,
};

/**
 * An extra service from a custom image: name, image and port up top, the plain
 * environment variables with their count chip and the bulk `.env` paste, and the
 * advanced options folded away until they are needed.
 */
export const ServiceCardFilled: Story = {
  render: () => <ServiceEditor initial={mailpitService} />,
};

/**
 * The same service with Advanced service config open on an HTTP readiness probe:
 * picking HTTP reveals the probe path, the port it probes (blank reuses the
 * primary port), and the initial-delay / period timings.
 */
export const ServiceAdvancedProbe: Story = {
  render: () => <ServiceEditor initial={mailpitProbeService} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByText("Advanced service config"));
  },
};

/**
 * Branch matching on the regex rule, which is the only one with fields of its
 * own: the pattern matched against the PR branch and the replacement that names
 * the dependency repo's branch.
 */
export const BranchMatchingRegex: Story = {
  render: () => <BranchMatchingEditor initial={regexConvention} />,
};

/**
 * Both lifecycle groups in use: migrations pre-deploy, demo-order seeding
 * post-deploy, each row pairing the app whose image the job runs from with the
 * command it runs.
 */
export const LifecycleHooks: Story = {
  render: () => <HooksEditor initial={storefrontDraft.hooks} appNames={storefrontAppNames} />,
};
