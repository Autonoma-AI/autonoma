import { type PrismaClient, PreviewkitStatus, applyMigrations, createClient } from "@autonoma/db";
import { type IntegrationHarness, stopContainer } from "@autonoma/integration-test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { AutoTopUpService } from "../src/auto-topup.service";
import { EnabledBillingService } from "../src/billing-enabled.service";
import { BillingPricingService } from "../src/billing-pricing.service";
import { CreditsService } from "../src/credits.service";
import type { BillingService } from "../src/types";

const POSTGRES_IMAGE = "postgres:17-alpine";

export interface CreatePreviewkitEnvironmentInput {
    organizationId: string;
    status?: PreviewkitStatus;
    meteredAt?: Date;
    deployedAt?: Date;
    tornDownAt?: Date;
}

export interface CreatedPreviewkitEnvironment {
    id: string;
    organizationId: string;
    namespace: string;
}

/**
 * Real-Postgres harness for the billing credit logic. Mirrors the scenario
 * harness: a throwaway Postgres testcontainer with migrations applied. We never
 * mock the DB - the deduction logic is raw SQL (row locks, idempotency, balance
 * clamping), so only a real database exercises it meaningfully.
 */
export class BillingTestHarness implements IntegrationHarness {
    public readonly db: PrismaClient;
    public readonly creditsService: CreditsService;
    public readonly billingService: BillingService;

    private readonly pgContainer: StartedPostgreSqlContainer;
    private previewkitEnvironmentSeq = 0;

    constructor(db: PrismaClient, pgContainer: StartedPostgreSqlContainer) {
        this.db = db;
        this.pgContainer = pgContainer;
        this.creditsService = new CreditsService(db, new AutoTopUpService(db), new BillingPricingService(db));
        this.billingService = new EnabledBillingService(db);
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
        // Cascades from organization to billing_customer, billing_pricing,
        // credit_transaction, and previewkit_environment/previewkit_usage_window -
        // every test starts from an empty table, so the previewkit usage-meter
        // sweep (which scans across all environments, not a single org) never
        // sees another test's leftover rows.
        await this.db.$executeRawUnsafe('TRUNCATE TABLE "organization" CASCADE');
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

    /** A PreviewkitEnvironment row for the usage-meter sweep tests, uniquely named per call. */
    async createPreviewkitEnvironment(input: CreatePreviewkitEnvironmentInput): Promise<CreatedPreviewkitEnvironment> {
        const seq = this.previewkitEnvironmentSeq++;
        const namespace = `preview-test-org-repo-pr-${seq}`;

        const env = await this.db.previewkitEnvironment.create({
            data: {
                organizationId: input.organizationId,
                namespace,
                repoFullName: "test-org/repo",
                prNumber: seq,
                headSha: `sha-${seq}`,
                headRef: `branch-${seq}`,
                status: input.status ?? PreviewkitStatus.ready,
                meteredAt: input.meteredAt,
                deployedAt: input.deployedAt ?? new Date(0),
                tornDownAt: input.tornDownAt,
            },
        });

        return { id: env.id, organizationId: env.organizationId, namespace: env.namespace };
    }
}
