import { type PrismaClient, applyMigrations, createClient } from "@autonoma/db";
import { type IntegrationHarness, stopContainer } from "@autonoma/integration-test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { AutoTopUpService } from "../src/auto-topup.service";
import { BillingPricingService } from "../src/billing-pricing.service";
import { CreditsService } from "../src/credits.service";

const POSTGRES_IMAGE = "postgres:17-alpine";

/**
 * Real-Postgres harness for the billing credit logic. Mirrors the scenario
 * harness: a throwaway Postgres testcontainer with migrations applied. We never
 * mock the DB - the deduction logic is raw SQL (row locks, idempotency, balance
 * clamping), so only a real database exercises it meaningfully.
 */
export class BillingTestHarness implements IntegrationHarness {
    public readonly db: PrismaClient;
    public readonly creditsService: CreditsService;

    private readonly pgContainer: StartedPostgreSqlContainer;

    constructor(db: PrismaClient, pgContainer: StartedPostgreSqlContainer) {
        this.db = db;
        this.pgContainer = pgContainer;
        this.creditsService = new CreditsService(db, new AutoTopUpService(db), new BillingPricingService(db));
    }

    static async create(): Promise<BillingTestHarness> {
        const pgContainer = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
        applyMigrations(pgContainer.getConnectionUri());
        const db = createClient(pgContainer.getConnectionUri());
        return new BillingTestHarness(db, pgContainer);
    }

    async beforeAll() {
        // No-op - harness is ready after create()
    }

    async afterAll() {
        await stopContainer(this.pgContainer);
    }

    async beforeEach() {
        // No-op
    }

    async afterEach() {
        // No-op
    }

    /**
     * Create an org with a billing customer at a known credit balance. Pricing is
     * left to default (creditsPerTopup=150000 for stripeTopupAmountCents=10000 =
     * 1500 credits/USD), created lazily on first deduction.
     */
    async createOrgWithBalance(creditBalance: number): Promise<string> {
        const date = Date.now();
        const org = await this.db.organization.create({
            data: { name: `Billing Org ${date}`, slug: `billing-org-${date}-${Math.floor(creditBalance)}` },
        });
        await this.db.billingCustomer.create({
            data: { organizationId: org.id, creditBalance },
        });
        return org.id;
    }
}
