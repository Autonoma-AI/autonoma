import type { Prisma, PrismaClient } from "@autonoma/db";
import { type ApplicationArchitecture, CreditTransactionType } from "@autonoma/db";
import { InsufficientCreditsError, SubscriptionGracePeriodExpiredError } from "@autonoma/errors";
import * as Sentry from "@sentry/node";
import type { AutoTopUpService } from "./auto-topup.service";
import type { BillingPricingService } from "./billing-pricing.service";
import { getGenerationCreditCost, getRunCreditCost, isUniqueConstraintError } from "./billing-utils";
import type {
    DeductCreditsResultRow,
    GenerationRefundResultRow,
    SubscriptionGrantCustomerRow,
    TopupRefundResultRow,
} from "./billing.types";
import { Service } from "./service";
import type { BillingConsumptionTarget, DeductGenerationContext } from "./types";

type TxClient = Prisma.TransactionClient;
type RawTxClient = TxClient & Pick<PrismaClient, "$queryRaw" | "$executeRaw">;

export class CreditsService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly autoTopUpService: AutoTopUpService,
        private readonly pricingService: BillingPricingService,
    ) {
        super();
    }

    async checkCreditsGate(
        organizationId: string,
        runCount: number,
        architecture: ApplicationArchitecture,
        target: BillingConsumptionTarget = "generation",
    ) {
        const pricing = await this.pricingService.getOrCreatePricing(organizationId);
        const customer = await this.db.billingCustomer.findUnique({
            where: { organizationId },
            select: { creditBalance: true, gracePeriodEndsAt: true },
        });

        const creditBalance = customer?.creditBalance ?? 0;
        const unitCost =
            target === "run" ? getRunCreditCost(architecture, pricing) : getGenerationCreditCost(architecture, pricing);
        const required = runCount * unitCost;
        const gracePeriodEndsAt = customer?.gracePeriodEndsAt ?? null;

        this.logger.info("Checking credits gate", {
            organizationId,
            creditBalance,
            required,
            unitCost,
            target,
            runCount,
            architecture,
            gracePeriodEndsAt,
        });

        if (gracePeriodEndsAt != null && Date.now() > gracePeriodEndsAt.getTime()) {
            this.logger.warn("Credits gate blocked by expired grace period", {
                organizationId,
                architecture,
                target,
                gracePeriodEndsAt: gracePeriodEndsAt.toISOString(),
                required,
                creditBalance,
                runCount,
                unitCost,
            });
            throw new SubscriptionGracePeriodExpiredError(
                `Subscription payment overdue: grace period expired on ${gracePeriodEndsAt.toISOString()}.`,
            );
        }

        if (creditBalance < required) {
            throw new InsufficientCreditsError(
                `Insufficient credits: ${creditBalance} available, ${required} required for ${runCount} run(s). Please top up your credits.`,
            );
        }
    }

    async deductCreditsForGeneration(generationId: string, context?: DeductGenerationContext): Promise<boolean> {
        let organizationId = context?.organizationId;
        let architecture = context?.architecture;

        if (organizationId == null || architecture == null) {
            const generation = await this.db.testGeneration.findUnique({
                where: { id: generationId },
                select: {
                    organizationId: true,
                    testPlan: {
                        select: {
                            testCase: {
                                select: {
                                    application: {
                                        select: {
                                            architecture: true,
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            });

            if (generation == null) {
                this.logger.warn("Generation not found for billing deduction", { generationId });
                return false;
            }

            organizationId = generation.organizationId;
            architecture = generation.testPlan.testCase.application.architecture;
        }

        const isRerun = context?.isRerun ?? false;
        let transactionId: string;

        if (isRerun) {
            const existingCount = await this.db.creditTransaction.count({
                where: { generationId, type: CreditTransactionType.GENERATION_CONSUMPTION },
            });
            transactionId = `ctr_gen_${generationId}_rerun_${existingCount + 1}`;
        } else {
            transactionId = `ctr_gen_${generationId}`;
        }

        const pricing = await this.pricingService.getOrCreatePricing(organizationId);
        const cost = getGenerationCreditCost(architecture, pricing);

        const didDeduct = await this.db
            .$transaction(async (tx) => {
                const rawTx = this.asRawTx(tx);
                const [result] = await rawTx.$queryRaw<Array<DeductCreditsResultRow>>`
                    WITH customer AS (
                        SELECT organization_id, credit_balance, subscription_credit_balance
                        FROM billing_customer
                        WHERE organization_id = ${organizationId}
                        FOR UPDATE
                    ),
                    eligible AS (
                        SELECT
                            organization_id,
                            credit_balance,
                            subscription_credit_balance,
                            LEAST(subscription_credit_balance, ${cost}) AS subscription_consumed
                        FROM customer
                        WHERE credit_balance >= ${cost}
                    ),
                    inserted AS (
                        INSERT INTO credit_transaction (
                            id,
                            organization_id,
                            type,
                            amount,
                            balance_after,
                            generation_id
                        )
                        SELECT
                            ${transactionId},
                            organization_id,
                            'GENERATION_CONSUMPTION'::credit_transaction_type,
                            ${-cost},
                            credit_balance - ${cost},
                            ${generationId}
                        FROM eligible
                        ON CONFLICT (id) DO NOTHING
                        RETURNING id
                    ),
                    updated AS (
                        UPDATE billing_customer bc
                        SET
                            credit_balance = eligible.credit_balance - ${cost},
                            subscription_credit_balance = eligible.subscription_credit_balance - eligible.subscription_consumed
                        FROM eligible
                        WHERE bc.organization_id = eligible.organization_id
                          AND EXISTS (SELECT 1 FROM inserted)
                        RETURNING bc.credit_balance, bc.subscription_credit_balance
                    )
                    SELECT
                        (SELECT COUNT(*)::bigint FROM inserted) AS inserted_count,
                        (SELECT credit_balance FROM updated LIMIT 1) AS new_balance,
                        (SELECT subscription_credit_balance FROM updated LIMIT 1) AS new_subscription_balance
                `;
                if (result == null) {
                    this.logger.warn("Credit deduction query returned no result row", {
                        organizationId,
                        generationId,
                    });
                    return false;
                }

                if (result.inserted_count === 0n) {
                    const existing = await tx.creditTransaction.findUnique({
                        where: { id: transactionId },
                        select: { id: true },
                    });
                    if (existing != null) {
                        this.logger.info("Credit deduction already recorded, skipping", { generationId });
                        return false;
                    }

                    this.logger.warn("No billing customer with sufficient credits for deduction", {
                        organizationId,
                        generationId,
                        cost,
                    });
                    throw new InsufficientCreditsError(
                        `Insufficient credits to deduct for generation ${generationId} (organization ${organizationId}).`,
                    );
                }

                const newBalance = result.new_balance;
                if (newBalance == null) {
                    this.logger.warn("Credit deduction inserted but balance was not updated", {
                        organizationId,
                        generationId,
                    });
                    return false;
                }

                const newSubscriptionBalance = result.new_subscription_balance ?? null;

                Sentry.addBreadcrumb({
                    category: "billing",
                    level: "info",
                    message: "Credits deducted for generation",
                    data: {
                        organizationId,
                        generationId,
                        cost,
                        newBalance,
                        newSubscriptionBalance,
                        architecture,
                    },
                });

                this.logger.info("Credits deducted", {
                    organizationId,
                    generationId,
                    cost,
                    newBalance,
                    newSubscriptionBalance,
                    architecture,
                });
                return true;
            })
            .catch((error: unknown) => {
                if (isUniqueConstraintError(error)) {
                    this.logger.info("Credit deduction already recorded, skipping", { generationId });
                    return false;
                }
                throw error;
            });

        if (didDeduct) {
            await this.autoTopUpService.triggerAutoTopUp(organizationId, pricing);
        }
        return didDeduct;
    }

    async deductCreditsForRun(runId: string): Promise<boolean> {
        const run = await this.db.run.findUnique({
            where: { id: runId },
            select: {
                id: true,
                organizationId: true,
                assignment: {
                    select: {
                        testCase: {
                            select: {
                                application: {
                                    select: { architecture: true },
                                },
                            },
                        },
                    },
                },
            },
        });
        if (run == null) {
            this.logger.warn("Run not found for billing deduction", { runId });
            return false;
        }

        const organizationId = run.organizationId;
        const architecture = run.assignment.testCase.application.architecture;
        const pricing = await this.pricingService.getOrCreatePricing(organizationId);
        const cost = getRunCreditCost(architecture, pricing);
        const transactionId = `ctr_run_${runId}`;

        const didDeduct = await this.db
            .$transaction(async (tx) => {
                const rawTx = this.asRawTx(tx);
                const [result] = await rawTx.$queryRaw<Array<DeductCreditsResultRow>>`
                    WITH customer AS (
                        SELECT organization_id, credit_balance, subscription_credit_balance
                        FROM billing_customer
                        WHERE organization_id = ${organizationId}
                        FOR UPDATE
                    ),
                    eligible AS (
                        SELECT
                            organization_id,
                            credit_balance,
                            subscription_credit_balance,
                            LEAST(subscription_credit_balance, ${cost}) AS subscription_consumed
                        FROM customer
                        WHERE credit_balance >= ${cost}
                    ),
                    inserted AS (
                        INSERT INTO credit_transaction (
                            id,
                            organization_id,
                            type,
                            amount,
                            balance_after,
                            run_id
                        )
                        SELECT
                            ${transactionId},
                            organization_id,
                            'RUN_CONSUMPTION'::credit_transaction_type,
                            ${-cost},
                            credit_balance - ${cost},
                            ${runId}
                        FROM eligible
                        ON CONFLICT (run_id) DO NOTHING
                        RETURNING id
                    ),
                    updated AS (
                        UPDATE billing_customer bc
                        SET
                            credit_balance = eligible.credit_balance - ${cost},
                            subscription_credit_balance = eligible.subscription_credit_balance - eligible.subscription_consumed
                        FROM eligible
                        WHERE bc.organization_id = eligible.organization_id
                          AND EXISTS (SELECT 1 FROM inserted)
                        RETURNING bc.credit_balance, bc.subscription_credit_balance
                    )
                    SELECT
                        (SELECT COUNT(*)::bigint FROM inserted) AS inserted_count,
                        (SELECT credit_balance FROM updated LIMIT 1) AS new_balance,
                        (SELECT subscription_credit_balance FROM updated LIMIT 1) AS new_subscription_balance
                `;
                if (result == null) {
                    this.logger.warn("Run deduction query returned no result row", { runId, organizationId });
                    return false;
                }

                if (result.inserted_count === 0n) {
                    const existing = await tx.creditTransaction.findUnique({
                        where: { id: transactionId },
                        select: { id: true },
                    });
                    if (existing != null) {
                        this.logger.info("Run deduction already recorded, skipping", { runId });
                        return false;
                    }

                    this.logger.warn("No billing customer with sufficient credits for run deduction", {
                        organizationId,
                        runId,
                        cost,
                    });
                    throw new InsufficientCreditsError(
                        `Insufficient credits to deduct for run ${runId} (organization ${organizationId}).`,
                    );
                }

                const newBalance = result.new_balance;
                if (newBalance == null) {
                    this.logger.warn("Run deduction inserted but balance was not updated", { organizationId, runId });
                    return false;
                }

                const newSubscriptionBalance = result.new_subscription_balance ?? null;
                this.logger.info("Run credits deducted", {
                    organizationId,
                    runId,
                    cost,
                    newBalance,
                    newSubscriptionBalance,
                    architecture,
                });
                return true;
            })
            .catch((error: unknown) => {
                if (isUniqueConstraintError(error)) {
                    this.logger.info("Run deduction already recorded, skipping", { runId });
                    return false;
                }
                throw error;
            });

        if (didDeduct) {
            await this.autoTopUpService.triggerAutoTopUp(organizationId, pricing);
        }
        return didDeduct;
    }

    async refundCreditsForGeneration(generationId: string) {
        const generation = await this.db.testGeneration.findUnique({
            where: { id: generationId },
            select: { organizationId: true, status: true },
        });

        if (generation == null) {
            this.logger.warn("Generation not found for billing refund", { generationId });
            return;
        }

        if (generation.status !== "failed") {
            this.logger.info("Skipping generation refund because status is not failed", {
                generationId,
                status: generation.status,
            });
            return;
        }

        const organizationId = generation.organizationId;

        await this.db.$transaction(async (tx) => {
            const rawTx = this.asRawTx(tx);
            const [result] = await rawTx.$queryRaw<Array<GenerationRefundResultRow>>`
                WITH customer AS (
                    SELECT organization_id, credit_balance, subscription_credit_balance
                    FROM billing_customer
                    WHERE organization_id = ${organizationId}
                    FOR UPDATE
                ),
                pricing AS (
                    SELECT credits_per_subscription
                    FROM billing_pricing
                    WHERE organization_id = ${organizationId}
                    LIMIT 1
                ),
                consumed AS (
                    SELECT
                        id,
                        organization_id,
                        ABS(amount)::int AS refunded_amount
                    FROM credit_transaction
                    WHERE generation_id = ${generationId}
                      AND type = 'GENERATION_CONSUMPTION'::credit_transaction_type
                    ORDER BY created_at DESC
                    LIMIT 1
                ),
                adjusted AS (
                    SELECT
                        customer.organization_id,
                        consumed.id AS consumption_id,
                        consumed.refunded_amount,
                        customer.credit_balance + consumed.refunded_amount AS new_balance,
                        customer.subscription_credit_balance
                            + LEAST(
                                consumed.refunded_amount,
                                GREATEST(
                                    COALESCE((SELECT credits_per_subscription FROM pricing), 0)
                                        - customer.subscription_credit_balance,
                                    0
                                )
                            ) AS new_subscription_balance
                    FROM customer
                    JOIN consumed ON consumed.organization_id = customer.organization_id
                ),
                inserted AS (
                    INSERT INTO credit_transaction (
                        id,
                        organization_id,
                        type,
                        amount,
                        balance_after
                    )
                    SELECT
                        'ctr_gen_refund_' || adjusted.consumption_id,
                        adjusted.organization_id,
                        'GENERATION_REFUND'::credit_transaction_type,
                        adjusted.refunded_amount,
                        adjusted.new_balance
                    FROM adjusted
                    ON CONFLICT (id) DO NOTHING
                    RETURNING id
                ),
                updated AS (
                    UPDATE billing_customer bc
                    SET
                        credit_balance = adjusted.new_balance,
                        subscription_credit_balance = adjusted.new_subscription_balance
                    FROM adjusted
                    WHERE bc.organization_id = adjusted.organization_id
                      AND EXISTS (SELECT 1 FROM inserted)
                    RETURNING bc.credit_balance, bc.subscription_credit_balance
                )
                SELECT
                    (SELECT COUNT(*)::bigint FROM consumed) AS consumed_count,
                    (SELECT COUNT(*)::bigint FROM inserted) AS inserted_count,
                    (SELECT refunded_amount FROM consumed LIMIT 1) AS refunded_amount,
                    (SELECT credit_balance FROM updated LIMIT 1) AS new_balance,
                    (SELECT subscription_credit_balance FROM updated LIMIT 1) AS new_subscription_balance
            `;

            if (result == null) {
                this.logger.warn("Generation refund query returned no result row", { generationId, organizationId });
                return;
            }

            if (result.consumed_count === 0n) {
                this.logger.info("No prior generation consumption found for generation refund", {
                    generationId,
                    organizationId,
                });
                return;
            }

            if (result.inserted_count === 0n) {
                this.logger.info("Generation refund already processed, skipping", { generationId, organizationId });
                return;
            }

            if (result.new_balance == null || result.refunded_amount == null) {
                this.logger.warn("Generation refund inserted but balance was not updated", {
                    generationId,
                    organizationId,
                });
                return;
            }

            this.logger.info("Generation credits refunded", {
                generationId,
                organizationId,
                amount: result.refunded_amount,
                newBalance: result.new_balance,
                newSubscriptionBalance: result.new_subscription_balance,
            });
        });
    }

    async grantSubscriptionCredits(organizationId: string, stripeInvoiceId: string) {
        const pricing = await this.pricingService.getOrCreatePricing(organizationId);
        const amount = pricing.creditsPerSubscription;

        await this.db
            .$transaction(async (tx) => {
                const rawTx = this.asRawTx(tx);
                const [customer] = await rawTx.$queryRaw<Array<SubscriptionGrantCustomerRow>>`
                    SELECT credit_balance, subscription_credit_balance
                    FROM billing_customer
                    WHERE organization_id = ${organizationId}
                    FOR UPDATE
                `;

                if (customer == null) {
                    this.logger.warn("No billing customer found for subscription grant", { organizationId });
                    return;
                }

                const topupBalance = Math.max(0, customer.credit_balance - customer.subscription_credit_balance);
                const newBalance = topupBalance + amount;

                await rawTx.$executeRaw`
                    UPDATE billing_customer
                    SET
                        credit_balance = ${newBalance},
                        subscription_credit_balance = ${amount}
                    WHERE organization_id = ${organizationId}
                `;

                if (customer.subscription_credit_balance > 0) {
                    await rawTx.$executeRaw`
                        INSERT INTO credit_transaction (
                            id,
                            organization_id,
                            type,
                            amount,
                            balance_after
                        ) VALUES (
                            ${`ctr_sub_reset_${stripeInvoiceId}`},
                            ${organizationId},
                            'SUBSCRIPTION_RESET'::credit_transaction_type,
                            ${-customer.subscription_credit_balance},
                            ${topupBalance}
                        )
                    `;
                }

                await tx.creditTransaction.create({
                    data: {
                        organizationId,
                        type: CreditTransactionType.SUBSCRIPTION_GRANT,
                        amount,
                        balanceAfter: newBalance,
                        stripeInvoiceId,
                    },
                });

                this.logger.info("Subscription credits granted", {
                    organizationId,
                    stripeInvoiceId,
                    amount,
                    newBalance,
                    replacedSubscriptionBalance: customer.subscription_credit_balance,
                    topupBalance,
                });
            })
            .catch((error: unknown) => {
                if (isUniqueConstraintError(error)) {
                    this.logger.info("Subscription credits already granted, skipping", { stripeInvoiceId });
                    return;
                }
                throw error;
            });
    }

    async grantTopupCredits(organizationId: string, stripePaymentIntentId: string) {
        const pricing = await this.pricingService.getOrCreatePricing(organizationId);
        const amount = pricing.creditsPerTopup;

        await this.db
            .$transaction(async (tx) => {
                const customer = await tx.billingCustomer.findUnique({
                    where: { organizationId },
                });

                if (customer == null) {
                    this.logger.warn("No billing customer found for top-up grant", { organizationId });
                    return;
                }

                const updatedCustomer = await tx.billingCustomer.update({
                    where: { organizationId },
                    data: { creditBalance: { increment: amount } },
                    select: { creditBalance: true },
                });
                const newBalance = updatedCustomer.creditBalance;

                await tx.creditTransaction.create({
                    data: {
                        organizationId,
                        type: CreditTransactionType.TOPUP_PURCHASE,
                        amount,
                        balanceAfter: newBalance,
                        stripePaymentIntentId,
                    },
                });

                this.logger.info("Top-up credits granted", {
                    organizationId,
                    stripePaymentIntentId,
                    amount,
                    newBalance,
                });
            })
            .catch((error: unknown) => {
                if (isUniqueConstraintError(error)) {
                    this.logger.info("Top-up credits already granted, skipping", { stripePaymentIntentId });
                    return;
                }
                throw error;
            });
    }

    async revokeTopupCredits(
        organizationId: string,
        stripeRefundId: string,
        stripePaymentIntentId: string,
        refundedAmountCents: number,
        originalChargedAmountCents: number,
    ) {
        await this.db
            .$transaction(async (tx) => {
                const rawTx = this.asRawTx(tx);
                const customer = await tx.billingCustomer.findUnique({
                    where: { organizationId },
                    select: { id: true },
                });
                if (customer == null) {
                    this.logger.warn("No billing customer found for top-up refund revoke", {
                        organizationId,
                        stripeRefundId,
                    });
                    return;
                }

                const purchase = await tx.creditTransaction.findUnique({
                    where: { stripePaymentIntentId },
                    select: { amount: true },
                });
                if (purchase == null) {
                    this.logger.warn("No top-up purchase found for refund revoke", {
                        organizationId,
                        stripeRefundId,
                        stripePaymentIntentId,
                    });
                    return;
                }

                const amount = this.mapRefundAmountToCredits(
                    refundedAmountCents,
                    originalChargedAmountCents,
                    purchase.amount,
                );
                if (amount <= 0) {
                    this.logger.info("Skipping top-up refund credit revoke because mapped credit amount is zero", {
                        organizationId,
                        stripeRefundId,
                        stripePaymentIntentId,
                        refundedAmountCents,
                        originalChargedAmountCents,
                        purchaseCreditsGranted: purchase.amount,
                    });
                    return;
                }

                const [result] = await rawTx.$queryRaw<Array<TopupRefundResultRow>>`
                    WITH customer AS (
                        SELECT organization_id, credit_balance, subscription_credit_balance
                        FROM billing_customer
                        WHERE organization_id = ${organizationId}
                        FOR UPDATE
                    ),
                    mapped AS (
                        SELECT
                            organization_id,
                            credit_balance,
                            subscription_credit_balance,
                            LEAST(credit_balance, ${amount}) AS applied_amount,
                            GREATEST(credit_balance - subscription_credit_balance, 0) AS topup_balance
                        FROM customer
                    ),
                    adjusted AS (
                        SELECT
                            organization_id,
                            applied_amount,
                            credit_balance - applied_amount AS new_balance,
                            GREATEST(
                                subscription_credit_balance - GREATEST(applied_amount - topup_balance, 0),
                                0
                            ) AS new_subscription_balance
                        FROM mapped
                    ),
                    inserted AS (
                        INSERT INTO credit_transaction (
                            id,
                            organization_id,
                            type,
                            amount,
                            balance_after,
                            stripe_refund_id
                        )
                        SELECT
                            ${`ctr_${stripeRefundId}`},
                            adjusted.organization_id,
                            'TOPUP_REFUND'::credit_transaction_type,
                            -adjusted.applied_amount,
                            adjusted.new_balance,
                            ${stripeRefundId}
                        FROM adjusted
                        WHERE adjusted.applied_amount > 0
                        ON CONFLICT (stripe_refund_id) DO NOTHING
                        RETURNING id
                    ),
                    updated AS (
                        UPDATE billing_customer bc
                        SET
                            credit_balance = adjusted.new_balance,
                            subscription_credit_balance = adjusted.new_subscription_balance
                        FROM adjusted
                        WHERE bc.organization_id = adjusted.organization_id
                          AND EXISTS (SELECT 1 FROM inserted)
                        RETURNING bc.credit_balance
                    )
                    SELECT
                        (SELECT COUNT(*)::bigint FROM inserted) AS inserted_count,
                        (SELECT credit_balance FROM updated LIMIT 1) AS new_balance
                `;
                if (result == null) {
                    this.logger.warn("Top-up refund query returned no result row", {
                        organizationId,
                        stripeRefundId,
                    });
                    return;
                }

                if (result.inserted_count === 0n) {
                    this.logger.info("Top-up refund already processed, skipping", { stripeRefundId });
                    return;
                }

                const newBalance = result.new_balance;
                if (newBalance == null) {
                    this.logger.warn("Top-up refund inserted but credit balance was not updated", {
                        organizationId,
                        stripeRefundId,
                    });
                    return;
                }

                this.logger.info("Top-up refund credits revoked", {
                    organizationId,
                    stripeRefundId,
                    stripePaymentIntentId,
                    refundedAmountCents,
                    originalChargedAmountCents,
                    requestedAmount: amount,
                    newBalance,
                });
            })
            .catch((error: unknown) => {
                if (isUniqueConstraintError(error)) {
                    this.logger.info("Top-up refund already processed, skipping", { stripeRefundId });
                    return;
                }
                throw error;
            });
    }

    private asRawTx(tx: TxClient): RawTxClient {
        return tx as RawTxClient;
    }

    private mapRefundAmountToCredits(
        refundedAmountCents: number,
        originalChargedAmountCents: number,
        purchaseCreditsGranted: number,
    ) {
        if (purchaseCreditsGranted <= 0 || refundedAmountCents <= 0 || originalChargedAmountCents <= 0) return 0;
        if (refundedAmountCents >= originalChargedAmountCents) return purchaseCreditsGranted;

        const proportional = Math.floor((refundedAmountCents / originalChargedAmountCents) * purchaseCreditsGranted);
        return Math.min(purchaseCreditsGranted, proportional);
    }
}
