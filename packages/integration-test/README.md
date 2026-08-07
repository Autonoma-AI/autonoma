# @autonoma/integration-test

Lightweight harness and test suite helper for writing integration tests with Vitest. Provides a structured pattern for managing test lifecycle (setup, teardown, seeding) and exposes harness/seed data as Vitest fixtures.

## Exports

| Export                 | Kind      | Description                                                        |
| ---------------------- | --------- | ------------------------------------------------------------------ |
| `integrationTestSuite` | Function  | Wires a harness into Vitest `describe`/`beforeAll`/`afterAll` etc. |
| `IntegrationHarness`   | Interface | Contract every harness must implement.                             |
| `startSharedPostgres`  | Function  | Call once from a package's Vitest `globalSetup`: boots one Postgres container and migrates a template database. |
| `createTestDatabase`   | Function  | Call from each harness's `create()`: forks an isolated, fully-migrated database from the template. |
| `POSTGRES_IMAGE`       | Constant  | The Testcontainers Postgres image tag `startSharedPostgres` boots. |
| `stopContainer`        | Function  | Stops a Testcontainers container, tolerating a benign teardown race. |

## IntegrationHarness interface

```ts
interface IntegrationHarness {
  beforeAll(): Promise<void>;
  afterAll(): Promise<void>;
  beforeEach(): Promise<void>;
  afterEach(): Promise<void>;
}
```

Implement this interface to manage infrastructure for your tests - Testcontainers (Postgres, Redis, MiniStack), Prisma clients, service instances, etc.

## stopContainer

```ts
function stopContainer(container: StartedTestContainer): Promise<void>;
```

Stops a Testcontainers container from a harness's `afterAll()`. On a contended CI runner, the Docker daemon can report a container as still running by the time removal is attempted - often because Testcontainers' own Ryuk reaper raced the explicit `stop()` call - even though the container is already gone or going. `stopContainer` swallows (and logs a warning for) that specific removal race; any other error still fails the suite. Prefer this over calling `.stop()` directly in harness teardown.

## integrationTestSuite

```ts
function integrationTestSuite<THarness extends IntegrationHarness, TSeedResult = void>(params: {
  name: string;
  createHarness: () => Promise<THarness>;
  seed?: (harness: THarness) => Promise<TSeedResult>;
  cases: (test: TestAPI<{ harness: THarness; seedResult: TSeedResult }>) => void;
}): void;
```

- `createHarness` - called once before all tests (120s timeout). Returns the harness instance.
- `seed` - optional. Runs after `harness.beforeAll()`. Use it to insert baseline data. The return value is available as the `seedResult` fixture.
- `cases` - receives a Vitest `test` function pre-extended with `harness` and `seedResult` fixtures.

## Shared Postgres (recommended for every Postgres-backed harness)

`integrationTestSuite`'s `createHarness` runs once per test **file**. If every harness boots its own
`PostgreSqlContainer`, a package with N integration test files boots N containers and replays every
migration N times - the dominant cost in most integration suites. `startSharedPostgres` +
`createTestDatabase` fix this: one container for the whole Vitest run, one migrated template
database, and each harness forks its own isolated database from that template (a fast Postgres-side
file copy, not a migration replay). Databases are fully isolated from each other - no shared tables,
no cross-suite visibility - so parallel test files stay exactly as safe as separate containers were.

```ts
function startSharedPostgres(opts: { migrate: (connectionUri: string) => void | Promise<void> }): Promise<{ stop: () => Promise<void> }>;
function createTestDatabase(): Promise<string>; // returns a connection URI for a fresh, migrated database
```

**1. Call `startSharedPostgres` once from the package's Vitest `globalSetup`:**

```ts
// test/global-setup.ts
import { startSharedPostgres } from "@autonoma/integration-test";

let stop: (() => Promise<void>) | undefined;

export async function setup(): Promise<void> {
  // Set TESTING before any @autonoma/* imports so createEnv skips validation.
  process.env.TESTING = "true";
  const { applyMigrations } = await import("@autonoma/db");
  const shared = await startSharedPostgres({ migrate: applyMigrations });
  stop = shared.stop;
}

export async function teardown(): Promise<void> {
  await stop?.();
}
```

```ts
// vitest.config.ts
export default defineConfig({
  test: { globalSetup: ["./test/global-setup.ts"] },
});
```

**2. Call `createTestDatabase` from each harness instead of booting a container:**

```ts
import { createTestDatabase, type IntegrationHarness } from "@autonoma/integration-test";

export class MyHarness implements IntegrationHarness {
  constructor(public readonly db: PrismaClient) {}

  static async create(): Promise<MyHarness> {
    const connectionUri = await createTestDatabase();
    const db = createClient(connectionUri);
    return new MyHarness(db);
  }

  async beforeAll() { /* create shared seed data */ }
  async afterAll() { await this.db.$disconnect(); }
  async beforeEach() {}
  async afterEach() {}
}
```

No container to stop per harness - `afterAll` only needs to close the Prisma client's connection
pool. The shared container itself is stopped once, by the package's `globalSetup` teardown.

For a non-Postgres container a harness still owns end-to-end (Redis, MiniStack, ...), start it
directly with `PostgreSqlContainer`/`GenericContainer` and pair it with `stopContainer` as before.

## Usage

### 1. Implement a harness

See [Shared Postgres](#shared-postgres-recommended-for-every-postgres-backed-harness) above for the
recommended Postgres-backed harness shape.

### 2. Write a test suite

```ts
import { integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { MyHarness } from "./harness";

integrationTestSuite({
  name: "widgets",
  createHarness: () => MyHarness.create(),
  seed: async (harness) => {
    const widget = await harness.db.widget.create({ data: { name: "test" } });
    return { widget };
  },
  cases: (test) => {
    test("returns the seeded widget", async ({ harness, seedResult }) => {
      const result = await harness.db.widget.findUnique({ where: { id: seedResult.widget.id } });
      expect(result).toBeDefined();
    });
  },
});
```

### 3. Create a domain-specific wrapper (optional)

For repeated boilerplate, wrap `integrationTestSuite` with your own helper:

```ts
import { integrationTestSuite } from "@autonoma/integration-test";
import { APITestHarness } from "./harness";

export function apiTestSuite<TSeedResult>({ name, seed, cases }) {
  integrationTestSuite<APITestHarness, TSeedResult>({
    name,
    createHarness: () => APITestHarness.create(),
    seed: (harness) => seed({ harness }),
    cases,
  });
}
```

## Architecture notes

- The harness is created once per `describe` block, not per test. Keep per-test isolation in `beforeEach`/`afterEach`.
- `beforeAll` has a 120-second timeout to allow for container startup.
- Fixtures (`harness`, `seedResult`) are injected via Vitest's `test.extend`, so they are available as destructured parameters in every test callback.
- The package is ESM-only (`"type": "module"`).
- `startSharedPostgres` sets an internal env var (`AUTONOMA_SHARED_POSTGRES_ADMIN_URL`) that `createTestDatabase` reads. It relies on Vitest's `globalSetup` running once in the main process, before any test-file workers spawn - the same mechanism `apps/api`'s `global-setup.ts` already used for its S3 endpoint, so this is a proven pattern in this repo, not a new assumption. Calling `createTestDatabase` before `startSharedPostgres` has run throws immediately.
- `createTestDatabase` does not `DROP` the databases it creates - the whole container (and everything in it) is torn down at the end of the run regardless, so per-suite cleanup would only add complexity for no benefit at this scale.
- Depends on `@autonoma/logger` (for `stopContainer`'s teardown-race warning), `testcontainers` (for the `StartedTestContainer` type), `@testcontainers/postgresql`, and `pg` (the admin connection `createTestDatabase` uses to run `CREATE DATABASE ... TEMPLATE ...`); Vitest remains a dev dependency only.
