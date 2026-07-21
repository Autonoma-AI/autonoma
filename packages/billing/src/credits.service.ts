import { analytics } from "@autonoma/analytics";
import type { Prisma, PrismaClient } from "@autonoma/db";
import { type ApplicationArchitecture, CreditTransactionType } from "@autonoma/db";
import { InsufficientCreditsError, SubscriptionGracePeriodExpiredError } from "@autonoma/errors";
import * as Sentry from "@sentry/node";
import type { AutoTopUpService } from "./auto-topup.service";
import type { BillingPricingService } from "./billing-pricing.service";
import { computePreviewUsageCost, getGenerationCreditCost, isUniqueConstraintError } from "./billing-utils";
import type {
    DeductCreditsResultRow,
    GenerationRefundResultRow,
    SubscriptionGrantCustomerRow,
    TopupRefundResultRow,
} from "./billing.types";
import { Service } from "./service";
import type { DeductGenerationContext, LlmProxyGateResult } from "./types";

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

    async checkCreditsGate(organizationId: string, runCount: number, architecture: ApplicationArchitecture) {
        const pricing = await this.pricingService.getOrCreatePricing(organizationId);
        const customer = await this.db.billingCustomer.findUnique({
            where: { organizationId },
            select: { creditBalance: true, gracePeriodEndsAt: true },
        });

        const creditBalance = customer?.creditBalance ?? 0;
        const unitCost = getGenerationCreditCost(architecture, pricing);
        const required = runCount * unitCost;
        const gracePeriodEndsAt = customer?.gracePeriodEndsAt ?? null;

        this.logger.info("Checking credits gate", {
            organizationId,
            creditBalance,
            required,
            unitCost,
            runCount,
            architecture,
            gracePeriodEndsAt,
        });

        if (gracePeriodEndsAt != null && Date.now() > gracePeriodEndsAt.getTime()) {
            this.logger.warn("Credits gate blocked by expired grace period", {
                organizationId,
                architecture,
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

        const transactionId = `ctr_gen_${generationId}`;

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

    /**
     * Pre-flight gate for the managed LLM proxy (CLI). The proxy doesn't know a
     * request's cost up front, so the gate is coarse on spend (blocks once the
     * wallet is empty; the trailing request that hits zero is still served and
     * billed, clamped at zero by `deductCreditsForLlmProxy`, and the *next*
     * request 402s) but hard on abuse: a never-paid org may spend at most
     * `freeCliCreditCap` of its free-start grant through the proxy. Credits the
     * org has paid for (top-up purchases and subscription grants, net of refunds)
     * raise that budget one-for-one, so a paying - or formerly-paying - org is
     * never blocked at the free cap. An active subscription lifts the gate outright.
     */
    async checkLlmProxyGate(organizationId: string, freeCliCreditCap: number): Promise<LlmProxyGateResult> {
        const customer = await this.db.billingCustomer.findUnique({
            where: { organizationId },
            select: { creditBalance: true, gracePeriodEndsAt: true, subscriptionStatus: true },
        });
        const balance = customer?.creditBalance ?? 0;
        const gracePeriodEndsAt = customer?.gracePeriodEndsAt ?? undefined;

        // Mirror the generation/run gate: an expired subscription grace period
        // blocks consumption regardless of balance.
        if (gracePeriodEndsAt != null && Date.now() > gracePeriodEndsAt.getTime()) {
            this.logger.info("LLM proxy gate blocked by expired grace period", {
                organizationId,
                gracePeriodEndsAt: gracePeriodEndsAt.toISOString(),
                balance,
            });
            return { allowed: false, reason: "grace_period_expired" };
        }

        if (balance <= 0) {
            this.logger.info("LLM proxy gate blocked - out of credits", { organizationId, balance });
            return { allowed: false, reason: "out_of_credits" };
        }

        // A recurring subscriber isn't the farming risk the cap targets - exempt
        // them. Only "active", not "trialing": we lean strict on the abuse bound,
        // and a former subscriber's paid spend is already credited via the budget
        // below, so a lapsed sub isn't penalized by dropping the exemption.
        if (customer?.subscriptionStatus === "active") {
            this.logger.info("LLM proxy gate allowed - active subscription", { organizationId });
            return { allowed: true };
        }

        // Free CLI credit cap enforcement is temporarily disabled: the cap no
        // longer blocks non-subscribers. The balance and grace-period gates above
        // still apply. Restore by re-enabling the cliSpent/cliBudget comparison.
        this.logger.info("LLM proxy gate allowed - free CLI credit cap disabled", {
            organizationId,
            balance,
            freeCliCreditCap,
        });
        return { allowed: true };
    }

    /** All-time credits consumed through the managed LLM proxy (as a positive number). */
    private async llmProxyLifetimeSpend(organizationId: string): Promise<number> {
        const aggregate = await this.db.creditTransaction.aggregate({
            where: { organizationId, type: CreditTransactionType.LLM_PROXY_CONSUMPTION },
            _sum: { amount: true },
        });
        return Math.abs(aggregate._sum.amount ?? 0);
    }

    /**
     * Net credits the org has ever paid for - top-up purchases plus subscription
     * grants, minus top-up refunds - floored at zero. Feeds the CLI budget so a
     * paying (or formerly-paying) org can spend what it paid for through the proxy
     * without the free-tier cap cutting it off. The free-start grant is
     * deliberately excluded: that's the pool the cap protects. Actual spend is
     * still bounded by the live `creditBalance` gate, so a generous budget can't
     * be spent past the wallet.
     */
    private async netPaidCreditsGranted(organizationId: string): Promise<number> {
        const [purchased, subscriptionGranted, refunded] = await Promise.all([
            this.db.creditTransaction.aggregate({
                where: { organizationId, type: CreditTransactionType.TOPUP_PURCHASE },
                _sum: { amount: true },
            }),
            this.db.creditTransaction.aggregate({
                where: { organizationId, type: CreditTransactionType.SUBSCRIPTION_GRANT },
                _sum: { amount: true },
            }),
            this.db.creditTransaction.aggregate({
                where: { organizationId, type: CreditTransactionType.TOPUP_REFUND },
                _sum: { amount: true },
            }),
        ]);
        // TOPUP_PURCHASE and SUBSCRIPTION_GRANT amounts are positive; TOPUP_REFUND negative.
        const gross = (purchased._sum.amount ?? 0) + (subscriptionGranted._sum.amount ?? 0);
        const refunds = Math.abs(refunded._sum.amount ?? 0);
        return Math.max(0, gross - refunds);
    }

    /**
     * Deduct credits for a single managed LLM proxy request. `costUsd` is the
     * dollar amount OpenRouter charged us (from the response's usage accounting).
     * We convert to credits at the same rate top-ups are priced
     * (`creditsPerTopup` per `stripeTopupAmountCents`), so the existing margin
     * carries over and there's no separate pricing knob.
     *
     * Unlike generation/run deductions, this does NOT require a sufficient
     * balance: the balance floors at zero so a single over-budget request can't
     * push the wallet negative, while still always recording the consumption.
     * Idempotent on `requestId` (the OpenRouter generation id).
     */
    async deductCreditsForLlmProxy(organizationId: string, costUsd: number, requestId: string): Promise<boolean> {
        this.logger.info("Deducting LLM proxy credits", { organizationId, costUsd, requestId });

        if (!(costUsd > 0)) {
            this.logger.info("Skipping LLM proxy deduction for non-positive cost", {
                organizationId,
                costUsd,
                requestId,
            });
            return false;
        }

        const pricing = await this.pricingService.getOrCreatePricing(organizationId);
        const creditsPerUsd = pricing.creditsPerTopup / (pricing.stripeTopupAmountCents / 100);
        const cost = Math.max(1, Math.ceil(costUsd * creditsPerUsd));
        const transactionId = `ctr_llm_${requestId}`;

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
                            ${transactionId},
                            organization_id,
                            'LLM_PROXY_CONSUMPTION'::credit_transaction_type,
                            ${-cost},
                            GREATEST(credit_balance - ${cost}, 0)
                        FROM eligible
                        ON CONFLICT (id) DO NOTHING
                        RETURNING id
                    ),
                    updated AS (
                        UPDATE billing_customer bc
                        SET
                            credit_balance = GREATEST(eligible.credit_balance - ${cost}, 0),
                            subscription_credit_balance =
                                GREATEST(eligible.subscription_credit_balance - eligible.subscription_consumed, 0)
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
                    this.logger.warn("LLM proxy deduction query returned no result row", {
                        organizationId,
                        requestId,
                    });
                    return false;
                }

                if (result.inserted_count === 0n) {
                    this.logger.info("LLM proxy deduction already recorded, skipping", { organizationId, requestId });
                    return false;
                }

                this.logger.info("LLM proxy credits deducted", {
                    organizationId,
                    requestId,
                    costUsd,
                    cost,
                    newBalance: result.new_balance,
                    newSubscriptionBalance: result.new_subscription_balance,
                });
                return true;
            })
            .catch((error: unknown) => {
                if (isUniqueConstraintError(error)) {
                    this.logger.info("LLM proxy deduction already recorded, skipping", { organizationId, requestId });
                    return false;
                }
                throw error;
            });

        if (didDeduct) {
            await this.autoTopUpService.triggerAutoTopUp(organizationId, pricing);
        }
        return didDeduct;
    }

    /**
     * Deduct credits for one closed PreviewkitUsageWindow's measured compute
     * (vCPU-seconds and memory GB-seconds), at the org's flat per-hour rates.
     * Charges are rounded up to a minimum of 1 whole credit, same as
     * `deductCreditsForLlmProxy` - there is no fractional-credit ledger, so an
     * idle window's sub-credit cost is not tracked between calls. A window
     * whose measured usage prices out to exactly zero (typically a `degraded`
     * window with no samples) is skipped entirely, matching the non-positive-
     * cost guard below.
     *
     * Balance floors at zero rather than requiring sufficiency - a mid-flight
     * environment must never be half-billed. Idempotent on `usageWindowId`
     * (one deduction per window, however many times the sweep retries it).
     */
    async deductCreditsForPreviewUsage(
        organizationId: string,
        usageWindowId: string,
        vcpuSeconds: number,
        gbSeconds: number,
    ): Promise<boolean> {
        this.logger.info("Deducting previewkit usage credits", {
            organizationId,
            usageWindowId,
            vcpuSeconds,
            gbSeconds,
        });

        const pricing = await this.pricingService.getOrCreatePricing(organizationId);
        const rawCost = computePreviewUsageCost(vcpuSeconds, gbSeconds, pricing);

        if (!(rawCost > 0)) {
            this.logger.info("Skipping previewkit usage deduction for non-positive cost", {
                organizationId,
                usageWindowId,
                vcpuSeconds,
                gbSeconds,
                rawCost,
            });
            return false;
        }

        const cost = Math.max(1, Math.ceil(rawCost));
        const transactionId = `ctr_preview_${usageWindowId}`;

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
                    ),
                    inserted AS (
                        INSERT INTO credit_transaction (
                            id,
                            organization_id,
                            type,
                            amount,
                            balance_after,
                            usage_window_id
                        )
                        SELECT
                            ${transactionId},
                            organization_id,
                            'PREVIEW_RUNTIME_CONSUMPTION'::credit_transaction_type,
                            ${-cost},
                            GREATEST(credit_balance - ${cost}, 0),
                            ${usageWindowId}
                        FROM eligible
                        ON CONFLICT (id) DO NOTHING
                        RETURNING id
                    ),
                    updated AS (
                        UPDATE billing_customer bc
                        SET
                            credit_balance = GREATEST(eligible.credit_balance - ${cost}, 0),
                            subscription_credit_balance =
                                GREATEST(eligible.subscription_credit_balance - eligible.subscription_consumed, 0)
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
                    this.logger.warn("Previewkit usage deduction query returned no result row", {
                        organizationId,
                        usageWindowId,
                    });
                    return false;
                }

                if (result.inserted_count === 0n) {
                    this.logger.info("Previewkit usage deduction already recorded, skipping", {
                        organizationId,
                        usageWindowId,
                    });
                    return false;
                }

                this.logger.info("Previewkit usage credits deducted", {
                    organizationId,
                    usageWindowId,
                    vcpuSeconds,
                    gbSeconds,
                    cost,
                    newBalance: result.new_balance,
                    newSubscriptionBalance: result.new_subscription_balance,
                });
                return true;
            })
            .catch((error: unknown) => {
                if (isUniqueConstraintError(error)) {
                    this.logger.info("Previewkit usage deduction already recorded, skipping", {
                        organizationId,
                        usageWindowId,
                    });
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

    async grantSubscriptionCredits(organizationId: string, invoiceId: string, customerEmail?: string) {
        const pricing = await this.pricingService.getOrCreatePricing(organizationId);
        const creditAmount = pricing.creditsPerSubscription;

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
                const newBalance = topupBalance + creditAmount;

                await rawTx.$executeRaw`
                    UPDATE billing_customer
                    SET
                        credit_balance = ${newBalance},
                        subscription_credit_balance = ${creditAmount}
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
                            ${`ctr_sub_reset_${invoiceId}`},
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
                        amount: creditAmount,
                        balanceAfter: newBalance,
                        stripeInvoiceId: invoiceId,
                    },
                });

                this.logger.info("Subscription credits granted", {
                    organizationId,
                    invoiceId,
                    creditAmount,
                    newBalance,
                    replacedSubscriptionBalance: customer.subscription_credit_balance,
                    topupBalance,
                });

                this.logger.info("Capturing PostHog billing.subscription_purchased event", {
                    organizationId,
                    invoiceId,
                    creditsGranted: creditAmount,
                    newBalance,
                    replacedSubscriptionBalance: customer.subscription_credit_balance,
                    customerEmail,
                });
                analytics.capture(organizationId, "billing.subscription_purchased", {
                    organizationId,
                    invoiceId,
                    creditsGranted: creditAmount,
                    newBalance,
                    replacedSubscriptionBalance: customer.subscription_credit_balance,
                    customerEmail,
                });
            })
            .catch((error: unknown) => {
                if (isUniqueConstraintError(error)) {
                    this.logger.info("Subscription credits already granted, skipping", { invoiceId });
                    return;
                }
                throw error;
            });
    }

    async grantTopupCredits(organizationId: string, stripePaymentIntentId: string, customerEmail?: string) {
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

                this.logger.info("Capturing PostHog billing.topup_purchased event", {
                    organizationId,
                    stripePaymentIntentId,
                    creditsGranted: amount,
                    newBalance,
                    customerEmail,
                });
                analytics.capture(organizationId, "billing.topup_purchased", {
                    organizationId,
                    stripePaymentIntentId,
                    creditsGranted: amount,
                    newBalance,
                    customerEmail,
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
