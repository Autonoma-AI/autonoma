import { createHash, randomBytes } from "node:crypto";
import { ApplicationArchitecture } from "@autonoma/db";
import {
    CreateSecretCommand,
    DescribeSecretCommand,
    GetSecretValueCommand,
    InvalidRequestException,
    ResourceExistsException,
    ResourceNotFoundException,
    RestoreSecretCommand,
    SecretsManagerClient,
    UpdateSecretCommand,
} from "@aws-sdk/client-secrets-manager";
import { mockClient } from "aws-sdk-client-mock";
import { expect } from "vitest";
import { PreviewkitSecretsService } from "../../src/previewkit/previewkit-secrets.service";
import { apiTestSuite } from "../api-test";

/**
 * The upsert must self-heal DB<->AWS drift instead of throwing - BUT it must only
 * adopt a bundle it actually owns. Real Postgres (harness) holds the
 * `previewkit_secret` rows; AWS Secrets Manager is faked with aws-sdk-client-mock
 * so no real secrets are touched. Each case reproduces one drift mode and asserts
 * the row converges on the reconciled ARN - and that a foreign, tag-mismatched
 * secret (a sanitized-name collision with another application) is refused, not read.
 */
const smMock = mockClient(SecretsManagerClient);

const ARN_PREFIX = "arn:aws:secretsmanager:us-east-1:000000000000:secret:previewkit/o/web-app";
const items = [{ key: "API_KEY", value: "sk_live_1" }];

/** LEGACY-era owner tags (names only, no identity tags) - exercises the fallback comparison on adopt. */
function ownerTags(orgSlug: string, applicationName: string, appName: string) {
    return [
        { Key: "previewkit:org", Value: orgSlug },
        { Key: "previewkit:application", Value: applicationName },
        { Key: "previewkit:app", Value: appName },
    ];
}

/** Current-era owner tags: the lossy name tags plus the non-lossy identity pair ownership compares on. */
function ownerTagsWithIdentity(orgSlug: string, applicationName: string, appName: string, applicationId: string) {
    return [
        ...ownerTags(orgSlug, applicationName, appName),
        { Key: "previewkit:applicationId", Value: applicationId },
        { Key: "previewkit:appNameHash", Value: createHash("sha256").update(appName, "utf8").digest("hex") },
    ];
}

apiTestSuite<{ applicationId: string; orgSlug: string; applicationName: string }>({
    name: "previewkit-secrets.upsert (self-healing DB<->AWS drift)",
    seed: async ({ harness }) => {
        const applicationName = "web app";
        const application = await harness.db.application.create({
            data: {
                name: applicationName,
                slug: `web-app-${randomBytes(4).toString("hex")}`,
                architecture: ApplicationArchitecture.WEB,
                organizationId: harness.organizationId,
            },
        });
        const org = await harness.db.organization.findUniqueOrThrow({
            where: { id: harness.organizationId },
            select: { slug: true },
        });
        return { applicationId: application.id, orgSlug: org.slug, applicationName };
    },
    cases: (test) => {
        test("happy path: creates the AWS secret and registers the DB row", async ({ harness, seedResult }) => {
            smMock.reset();
            const arn = `${ARN_PREFIX}/happy-AAAAAA`;
            smMock.on(CreateSecretCommand).resolves({ ARN: arn });

            const svc = new PreviewkitSecretsService("us-east-1", harness.db);
            const result = await svc.upsert(seedResult.applicationId, "happy", items, harness.organizationId);

            expect(result).toEqual({ created: true, changed: true });
            const row = await harness.db.previewkitSecret.findUnique({
                where: { applicationId_appName: { applicationId: seedResult.applicationId, appName: "happy" } },
            });
            expect(row?.awsSecretArn).toBe(arn);
        });

        test("adopts our own existing AWS secret when the DB row is missing (ResourceExists)", async ({
            harness,
            seedResult,
        }) => {
            smMock.reset();
            const arn = `${ARN_PREFIX}/adopt-BBBBBB`;
            smMock
                .on(CreateSecretCommand)
                .rejects(new ResourceExistsException({ message: "already exists", $metadata: {} }));
            // The existing bundle is tagged as ours -> adoption allowed.
            smMock
                .on(DescribeSecretCommand)
                .resolves({ ARN: arn, Tags: ownerTags(seedResult.orgSlug, seedResult.applicationName, "adopt") });
            smMock.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify({ PRE_EXISTING: "1" }) });
            smMock.on(UpdateSecretCommand).resolves({});

            const svc = new PreviewkitSecretsService("us-east-1", harness.db);
            const result = await svc.upsert(seedResult.applicationId, "adopt", items, harness.organizationId);

            expect(result.created).toBe(false);
            const row = await harness.db.previewkitSecret.findUnique({
                where: { applicationId_appName: { applicationId: seedResult.applicationId, appName: "adopt" } },
            });
            expect(row?.awsSecretArn).toBe(arn);
        });

        test("REFUSES to adopt a foreign secret whose owner tags don't match (name collision)", async ({
            harness,
            seedResult,
        }) => {
            smMock.reset();
            smMock
                .on(CreateSecretCommand)
                .rejects(new ResourceExistsException({ message: "already exists", $metadata: {} }));
            // The colliding AWS secret belongs to a DIFFERENT application in the org.
            smMock.on(DescribeSecretCommand).resolves({
                ARN: `${ARN_PREFIX}/victim-VVVVVV`,
                Tags: ownerTags(seedResult.orgSlug, "victim app", "web"),
            });
            smMock.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify({ VICTIM: "top-secret" }) });
            smMock.on(UpdateSecretCommand).resolves({});

            const svc = new PreviewkitSecretsService("us-east-1", harness.db);

            await expect(
                svc.upsert(seedResult.applicationId, "collide", items, harness.organizationId),
            ).rejects.toThrow(/collides with the preview secrets of application "victim app"/);

            // No row written, and the foreign bundle was never read or merged.
            const row = await harness.db.previewkitSecret.findUnique({
                where: { applicationId_appName: { applicationId: seedResult.applicationId, appName: "collide" } },
            });
            expect(row).toBeNull();
            expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(0);
            expect(smMock.commandCalls(UpdateSecretCommand)).toHaveLength(0);
        });

        test("assertSecretPathsAvailable flags a foreign-owned path and passes owned/absent ones", async ({
            harness,
            seedResult,
        }) => {
            smMock.reset();
            // "taken" is owned by a different application; "mine" is ours; "fresh" doesn't exist.
            smMock.on(DescribeSecretCommand).callsFake((input: { SecretId: string }) => {
                if (input.SecretId.endsWith("/taken")) {
                    return {
                        ARN: `${ARN_PREFIX}/taken-TTTTTT`,
                        Tags: ownerTags(seedResult.orgSlug, "victim app", "taken"),
                    };
                }
                if (input.SecretId.endsWith("/mine")) {
                    return {
                        ARN: `${ARN_PREFIX}/mine-MMMMMM`,
                        Tags: ownerTags(seedResult.orgSlug, seedResult.applicationName, "mine"),
                    };
                }
                if (input.SecretId.endsWith("/alien")) {
                    return {
                        ARN: `${ARN_PREFIX}/alien-XXXXXX`,
                        Tags: ownerTags("some-other-org", "Rival App", "alien"),
                    };
                }
                throw new ResourceNotFoundException({ message: "not found", $metadata: {} });
            });

            const svc = new PreviewkitSecretsService("us-east-1", harness.db);

            await expect(
                svc.assertSecretPathsAvailable(seedResult.applicationId, ["mine", "fresh"], harness.organizationId),
            ).resolves.toBeUndefined();
            await expect(
                svc.assertSecretPathsAvailable(seedResult.applicationId, ["taken"], harness.organizationId),
            ).rejects.toThrow(/collides with the preview secrets of application "victim app"/);
            // A cross-org owner is never named: naming is allowed only inside the
            // caller's own org, where those names are already visible.
            await expect(
                svc.assertSecretPathsAvailable(seedResult.applicationId, ["alien"], harness.organizationId),
            ).rejects.toThrow(/collides with the preview secrets of another application/);
        });

        test("REFUSES adoption when name tags collide but the identity tags belong to another application", async ({
            harness,
            seedResult,
        }) => {
            smMock.reset();
            // The bug this closes: `Bank:)` and `Bank:(` both sanitize to the path
            // segment `Bank` AND both tag as `Bank:-`, so the lossy name tags alone
            // would call the foreign secret self-owned. The identity tags cannot alias.
            const victim = await harness.db.application.create({
                data: {
                    name: "Bank:)",
                    slug: `bank-victim-${randomBytes(4).toString("hex")}`,
                    architecture: ApplicationArchitecture.WEB,
                    organizationId: harness.organizationId,
                },
            });
            const caller = await harness.db.application.create({
                data: {
                    name: "Bank:(",
                    slug: `bank-caller-${randomBytes(4).toString("hex")}`,
                    architecture: ApplicationArchitecture.WEB,
                    organizationId: harness.organizationId,
                },
            });
            smMock
                .on(CreateSecretCommand)
                .rejects(new ResourceExistsException({ message: "already exists", $metadata: {} }));
            // Name tags are the sanitized twins ("Bank:-"), identity is the victim's.
            smMock.on(DescribeSecretCommand).resolves({
                ARN: `${ARN_PREFIX}/twin-WWWWWW`,
                Tags: ownerTagsWithIdentity(seedResult.orgSlug, "Bank:-", "web", victim.id),
            });
            smMock.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify({ VICTIM: "top-secret" }) });
            smMock.on(UpdateSecretCommand).resolves({});

            const svc = new PreviewkitSecretsService("us-east-1", harness.db);

            await expect(svc.upsert(caller.id, "web", items, harness.organizationId)).rejects.toThrow(
                /collides with the preview secrets/,
            );
            expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(0);
            expect(smMock.commandCalls(UpdateSecretCommand)).toHaveLength(0);
        });

        test("sanitizes owner tag values AWS would reject (application name with punctuation)", async ({ harness }) => {
            smMock.reset();
            const application = await harness.db.application.create({
                data: {
                    name: "Cripto-Bank:)",
                    slug: `cripto-${randomBytes(4).toString("hex")}`,
                    architecture: ApplicationArchitecture.WEB,
                    organizationId: harness.organizationId,
                },
            });
            const arn = `${ARN_PREFIX}/cripto-CCCCCC`;
            smMock.on(CreateSecretCommand).resolves({ ARN: arn });

            const svc = new PreviewkitSecretsService("us-east-1", harness.db);
            await svc.upsert(application.id, "web", items, harness.organizationId);

            // ")" is not a legal AWS tag character - sending it raw fails the whole
            // CreateSecret with AWS's opaque "downstream tagging service" error.
            const create = smMock.commandCalls(CreateSecretCommand)[0]?.args[0].input;
            const applicationTag = create?.Tags?.find((tag) => tag.Key === "previewkit:application");
            expect(applicationTag?.Value).toBe("Cripto-Bank:-");
            // And the non-lossy identity pair rides along - it is what ownership compares.
            const applicationIdTag = create?.Tags?.find((tag) => tag.Key === "previewkit:applicationId");
            expect(applicationIdTag?.Value).toBe(application.id);
            const appNameHashTag = create?.Tags?.find((tag) => tag.Key === "previewkit:appNameHash");
            expect(appNameHashTag?.Value).toBe(createHash("sha256").update("web", "utf8").digest("hex"));
        });

        test("recreates + repoints when the DB row points at a deleted secret (ResourceNotFound)", async ({
            harness,
            seedResult,
        }) => {
            smMock.reset();
            const staleArn = `${ARN_PREFIX}/gone-OLD`;
            const newArn = `${ARN_PREFIX}/gone-NEW`;
            await harness.db.previewkitSecret.create({
                data: { applicationId: seedResult.applicationId, appName: "gone", awsSecretArn: staleArn },
            });
            // The stored ARN is dead: reads and the merge-update both 404.
            smMock
                .on(GetSecretValueCommand)
                .rejects(new ResourceNotFoundException({ message: "not found", $metadata: {} }));
            smMock
                .on(UpdateSecretCommand)
                .rejects(new ResourceNotFoundException({ message: "not found", $metadata: {} }));
            smMock.on(CreateSecretCommand).resolves({ ARN: newArn });

            const svc = new PreviewkitSecretsService("us-east-1", harness.db);
            const result = await svc.upsert(seedResult.applicationId, "gone", items, harness.organizationId);

            expect(result.created).toBe(true);
            const row = await harness.db.previewkitSecret.findUnique({
                where: { applicationId_appName: { applicationId: seedResult.applicationId, appName: "gone" } },
            });
            expect(row?.awsSecretArn).toBe(newArn);
        });

        test("restores + adopts our own secret when it is scheduled for deletion (InvalidRequest)", async ({
            harness,
            seedResult,
        }) => {
            smMock.reset();
            const arn = `${ARN_PREFIX}/sched-CCCCCC`;
            smMock.on(CreateSecretCommand).rejects(
                new InvalidRequestException({
                    message:
                        "You can't create this secret because a secret with this name is already scheduled for deletion.",
                    $metadata: {},
                }),
            );
            smMock
                .on(DescribeSecretCommand)
                .resolves({ ARN: arn, Tags: ownerTags(seedResult.orgSlug, seedResult.applicationName, "scheduled") });
            smMock.on(RestoreSecretCommand).resolves({});
            smMock.on(GetSecretValueCommand).resolves({ SecretString: "{}" });
            smMock.on(UpdateSecretCommand).resolves({});

            const svc = new PreviewkitSecretsService("us-east-1", harness.db);
            const result = await svc.upsert(seedResult.applicationId, "scheduled", items, harness.organizationId);

            expect(result.created).toBe(false);
            expect(smMock.commandCalls(RestoreSecretCommand)).toHaveLength(1);
            const row = await harness.db.previewkitSecret.findUnique({
                where: { applicationId_appName: { applicationId: seedResult.applicationId, appName: "scheduled" } },
            });
            expect(row?.awsSecretArn).toBe(arn);
        });
    },
});
