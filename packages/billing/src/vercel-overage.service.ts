import type { Prisma, PrismaClient } from "@autonoma/db";
import { VercelBillingPeriodStatus, VercelInstallationStatus } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { isUniqueConstraintError } from "./billing-utils";
import { Service } from "./service";

type TxClient = Prisma.TransactionClient;
type RawTxClient = TxClient & Pick<PrismaClient, "$queryRaw">;

type OverageGrantResultRow = {
    inserted_count: bigint;
};

type OverageEligibleContext = {
    installationId: string;
    periodId: string;
    /** Whole credits, floored - the running total this period can never grant. */
    maxOverageCredits: number;
    overageCreditsGranted: number;
};

export type VercelOverageStatus = {
    enabled: boolean;
    maxOverageAmountUsd: number | undefined;
    overagePricePerCredit: number | undefined;
    overageCreditsGrantedThisPeriod: number;
    overageAmountUsdThisPeriod: number;
};

export class VercelOverageService extends Service {
    constructor(private readonly db: PrismaClient) {
        super();
    }

    /**
     * Finds the org's active Vercel installation, its plan's overage rate, and
     * the active billing period to attribute a grant to. Returns undefined
     * when the org isn't Vercel-billed, hasn't opted into overage
     * (`maxOverageAmountUsd` unset), or the plan doesn't support it
     * (`overagePricePerCredit` unset) - callers then fall back to today's
     * hard-block-at-zero behavior.
     */
    private async findEligibleContext(organizationId: string): Promise<OverageEligibleContext | undefined> {
        const installation = await this.db.vercelInstallation.findFirst({
            where: {
                organizationId,
                status: VercelInstallationStatus.active,
                maxOverageAmountUsd: { not: null },
            },
            orderBy: { createdAt: "desc" },
            include: { billingPlan: true },
        });

        if (installation?.maxOverageAmountUsd == null || installation.billingPlan?.overagePricePerCredit == null) {
            return undefined;
        }

        const period = await this.db.vercelBillingPeriod.findFirst({
            where: { installationId: installation.id, status: VercelBillingPeriodStatus.active },
            orderBy: { startDate: "desc" },
        });
        if (period == null) return undefined;

        const maxOverageAmountUsd = parseFloat(installation.maxOverageAmountUsd.toString());
        const overagePricePerCredit = parseFloat(installation.billingPlan.overagePricePerCredit.toString());

        return {
            installationId: installation.id,
            periodId: period.id,
            maxOverageCredits: Math.floor(maxOverageAmountUsd / overagePricePerCredit),
            overageCreditsGranted: period.overageCreditsGranted,
        };
    }

    /**
     * Called from the credits gate right before it would otherwise throw
     * `InsufficientCreditsError`. Proactively grants exactly `creditsNeeded`
     * credits into the org's balance - bounded by the installation's
     * `maxOverageAmountUsd` for the current billing period - so the
     * immediately-following deduction succeeds through the existing
     * balance-sufficiency check with no changes needed there. Returns false
     * (grants nothing) when the org isn't overage-eligible or the grant would
     * push this period's total past the cap.
     */
    async grantOverageIfEligible(organizationId: string, creditsNeeded: number): Promise<boolean> {
        if (!(creditsNeeded > 0)) return false;

        const context = await this.findEligibleContext(organizationId);
        if (context == null) return false;

        const { periodId, maxOverageCredits, overageCreditsGranted } = context;
        // Deterministic on (period, running total, amount) rather than a call-site
        // id - checkCreditsGate has no generation id yet at pre-flight time. A
        // retried gate check with the exact same period state and request size
        // is intentionally idempotent; the important invariant (never exceed
        // maxOverageCredits) is enforced by the `eligible` CTE below regardless.
        const transactionId = `ctr_vercel_overage_${periodId}_${overageCreditsGranted}_${creditsNeeded}`;

        this.logger.info("Checking Vercel overage grant eligibility", {
            organizationId,
            periodId,
            creditsNeeded,
            maxOverageCredits,
            overageCreditsGranted,
        });

        const didGrant = await this.db
            .$transaction(async (tx) => {
                const rawTx = tx as RawTxClient;
                const [result] = await rawTx.$queryRaw<Array<OverageGrantResultRow>>`
                    WITH locked_period AS (
                        SELECT id, overage_credits_granted
                        FROM vercel_billing_period
                        WHERE id = ${periodId}
                        FOR UPDATE
                    ),
                    locked_customer AS (
                        SELECT organization_id, credit_balance
                        FROM billing_customer
                        WHERE organization_id = ${organizationId}
                        FOR UPDATE
                    ),
                    eligible AS (
                        SELECT locked_customer.organization_id, locked_customer.credit_balance, locked_period.id AS period_id
                        FROM locked_period, locked_customer
                        WHERE locked_period.overage_credits_granted + ${creditsNeeded} <= ${maxOverageCredits}
                    ),
                    inserted AS (
                        INSERT INTO credit_transaction (id, organization_id, type, amount, balance_after)
                        SELECT
                            ${transactionId},
                            organization_id,
                            'VERCEL_OVERAGE_GRANT'::credit_transaction_type,
                            ${creditsNeeded},
                            credit_balance + ${creditsNeeded}
                        FROM eligible
                        ON CONFLICT (id) DO NOTHING
                        RETURNING id
                    ),
                    updated_customer AS (
                        UPDATE billing_customer bc
                        SET credit_balance = eligible.credit_balance + ${creditsNeeded}
                        FROM eligible
                        WHERE bc.organization_id = eligible.organization_id
                          AND EXISTS (SELECT 1 FROM inserted)
                        RETURNING bc.credit_balance
                    ),
                    updated_period AS (
                        UPDATE vercel_billing_period vbp
                        SET overage_credits_granted = vbp.overage_credits_granted + ${creditsNeeded}
                        FROM eligible
                        WHERE vbp.id = eligible.period_id
                          AND EXISTS (SELECT 1 FROM inserted)
                        RETURNING vbp.id
                    )
                    SELECT (SELECT COUNT(*)::bigint FROM inserted) AS inserted_count
                `;

                return result != null && result.inserted_count > 0n;
            })
            .catch((error: unknown) => {
                if (isUniqueConstraintError(error)) {
                    this.logger.info("Vercel overage grant already recorded, skipping", { transactionId });
                    return false;
                }
                throw error;
            });

        if (didGrant) {
            this.logger.info("Granted Vercel overage credits", { organizationId, periodId, creditsNeeded });
        } else {
            this.logger.info("Vercel overage grant denied - would exceed cap", {
                organizationId,
                periodId,
                creditsNeeded,
                maxOverageCredits,
                overageCreditsGranted,
            });
        }

        return didGrant;
    }

    /** Current overage configuration and this-period consumption, for display in billing settings. */
    async getOverageStatus(organizationId: string): Promise<VercelOverageStatus> {
        const installation = await this.db.vercelInstallation.findFirst({
            where: { organizationId, status: VercelInstallationStatus.active },
            orderBy: { createdAt: "desc" },
            include: { billingPlan: true },
        });

        const emptyStatus: VercelOverageStatus = {
            enabled: false,
            maxOverageAmountUsd: undefined,
            overagePricePerCredit: undefined,
            overageCreditsGrantedThisPeriod: 0,
            overageAmountUsdThisPeriod: 0,
        };
        if (installation == null) return emptyStatus;

        const overagePricePerCredit =
            installation.billingPlan?.overagePricePerCredit != null
                ? parseFloat(installation.billingPlan.overagePricePerCredit.toString())
                : undefined;
        const maxOverageAmountUsd =
            installation.maxOverageAmountUsd != null
                ? parseFloat(installation.maxOverageAmountUsd.toString())
                : undefined;

        const period = await this.db.vercelBillingPeriod.findFirst({
            where: { installationId: installation.id, status: VercelBillingPeriodStatus.active },
            orderBy: { startDate: "desc" },
            select: { overageCreditsGranted: true },
        });
        const overageCreditsGrantedThisPeriod = period?.overageCreditsGranted ?? 0;

        return {
            enabled: maxOverageAmountUsd != null && overagePricePerCredit != null,
            maxOverageAmountUsd,
            overagePricePerCredit,
            overageCreditsGrantedThisPeriod,
            overageAmountUsdThisPeriod:
                overagePricePerCredit != null ? overageCreditsGrantedThisPeriod * overagePricePerCredit : 0,
        };
    }

    /** Sets or clears (`undefined`) the org's monthly pay-per-usage overage cap. */
    async updateOverageCap(organizationId: string, maxOverageAmountUsd: number | undefined): Promise<void> {
        const installation = await this.db.vercelInstallation.findFirst({
            where: { organizationId, status: VercelInstallationStatus.active },
            orderBy: { createdAt: "desc" },
            select: { id: true },
        });
        if (installation == null) {
            throw new NotFoundError("No active Vercel installation found for this organization");
        }

        await this.db.vercelInstallation.update({
            where: { id: installation.id },
            data: { maxOverageAmountUsd: maxOverageAmountUsd ?? null },
        });

        this.logger.info("Updated Vercel overage cap", { organizationId, maxOverageAmountUsd });
    }
}
