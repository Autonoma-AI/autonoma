# @autonoma/integration-test

Lightweight harness and test suite helper for writing integration tests with Vitest. Provides a structured pattern for managing test lifecycle (setup, teardown, seeding) and exposes harness/seed data as Vitest fixtures.

## Exports

| Export                 | Kind      | Description                                                        |
| ---------------------- | --------- | ------------------------------------------------------------------ |
| `integrationTestSuite` | Function  | Wires a harness into Vitest `describe`/`beforeAll`/`afterAll` etc. |
| `IntegrationHarness`   | Interface | Contract every harness must implement.                             |
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

Implement this interface to manage infrastructure for your tests - Testcontainers (Postgres, Redis, LocalStack), Prisma clients, service instances, etc.

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

## Usage

### 1. Implement a harness

```ts
import { type IntegrationHarness, stopContainer } from "@autonoma/integration-test";
import { PostgreSqlContainer } from "@testcontainers/postgresql";

export class MyHarness implements IntegrationHarness {
  constructor(public readonly db: PrismaClient, private container: StartedPostgreSqlContainer) {}

  static async create(): Promise<MyHarness> {
    const container = await new PostgreSqlContainer("postgres:17-alpine").start();
    const db = createClient(container.getConnectionUri());
    return new MyHarness(db, container);
  }

  async beforeAll() { /* create shared seed data */ }
  async afterAll() { await stopContainer(this.container); }
  async beforeEach() {}
  async afterEach() {}
}
```

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
- Depends on `@autonoma/logger` (for `stopContainer`'s teardown-race warning) and `testcontainers` (for the `StartedTestContainer` type); Vitest remains a dev dependency only.
