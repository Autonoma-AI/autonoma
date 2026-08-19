import { Prisma, type PrismaClient } from "@autonoma/db";
import type { CreditTransactionType } from "@autonoma/db";
import type { Logger } from "@autonoma/logger";
import { isUniqueConstraintError } from "./billing-utils";

type TxClient = Prisma.TransactionClient;
type RawTxClient = TxClient & Pick<PrismaClient, "$queryRaw">;

type DeductCreditsFlooredResultRow = {
    inserted_count: bigint;
    new_balance: number | null;
    new_subscription_balance: number | null;
};

/** Which extra column on `credit_transaction` links this deduction back to the exact row it charges for. */
export interface CreditTransactionFkColumn {
    name: "ai_cost_record_id" | "previewkit_app_build_id" | "usage_window_id";
    value: string;
}

export interface DeductCreditsFlooredParams {
    organizationId: string;
    transactionId: string;
    transactionType: CreditTransactionType;
    cost: number;
    fkColumn: CreditTransactionFkColumn;
}

export interface DeductCreditsFlooredResult {
    deducted: boolean;
    newBalance?: number;
}

/**
 * Deducts `cost` credits from an org's balance, clamped at the org's own `BillingCustomer.creditFloor`
 * rather than requiring sufficiency - an already-running PR's jobs (AI calls, builds, running compute)
 * always get charged in full and never get half-billed mid-flight. Every org defaults to a floor of 0
 * (today's zero-clamp behavior, unchanged), raised only by a deliberate admin action.
 *
 * Generalizes the floor-at-zero CTE pattern shared by `deductCreditsForLlmProxy`/
 * `deductCreditsForPreviewUsage`: same `FOR UPDATE` lock on `billing_customer`, same
 * `ON CONFLICT (id) DO NOTHING` idempotency on a deterministic `transactionId`, same proportional
 * `subscription_credit_balance` consumption (which still floors at 0 - only the combined
 * `credit_balance` gets the org's configurable floor). `fkColumn` is one of a small, code-controlled
 * set of column names, safe to splice as a raw identifier since it's never user input.
 */
export async function deductCreditsFloored(
    db: PrismaClient,
    params: DeductCreditsFlooredParams,
    logger: Logger,
): Promise<DeductCreditsFlooredResult> {
    const { organizationId, transactionId, transactionType, cost, fkColumn } = params;

    return db
        .$transaction(async (tx) => {
            const rawTx = tx as RawTxClient;
            const fkColumnIdentifier = Prisma.raw(fkColumn.name);
            const [result] = await rawTx.$queryRaw<Array<DeductCreditsFlooredResultRow>>`
                WITH customer AS (
                    SELECT organization_id, credit_balance, subscription_credit_balance, credit_floor
                    FROM billing_customer
                    WHERE organization_id = ${organizationId}
                    FOR UPDATE
                ),
                eligible AS (
                    SELECT
                        organization_id,
                        credit_balance,
                        subscription_credit_balance,
                        credit_floor,
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
                        ${fkColumnIdentifier}
                    )
                    SELECT
                        ${transactionId},
                        organization_id,
                        ${transactionType}::credit_transaction_type,
                        ${-cost},
                        GREATEST(credit_balance - ${cost}, credit_floor),
                        ${fkColumn.value}
                    FROM eligible
                    ON CONFLICT (id) DO NOTHING
                    RETURNING id
                ),
                updated AS (
                    UPDATE billing_customer bc
                    SET
                        credit_balance = GREATEST(eligible.credit_balance - ${cost}, eligible.credit_floor),
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
                logger.warn("Floored deduction query returned no result row", { organizationId, transactionId });
                return { deducted: false };
            }

            if (result.inserted_count === 0n) {
                logger.info("Floored deduction already recorded, skipping", { organizationId, transactionId });
                return { deducted: false };
            }

            logger.info("Deducted credits (floored)", {
                organizationId,
                transactionId,
                transactionType,
                cost,
                newBalance: result.new_balance,
            });
            return { deducted: true, newBalance: result.new_balance ?? undefined };
        })
        .catch((error: unknown) => {
            if (isUniqueConstraintError(error)) {
                logger.info("Floored deduction already recorded, skipping", { organizationId, transactionId });
                return { deducted: false };
            }
            throw error;
        });
}
