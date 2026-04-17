import { toSlug } from "@autonoma/utils";
import { PrismaPg } from "@prisma/adapter-pg";
import {
    ApplicationArchitecture,
    GenerationStatus,
    PrismaClient,
    SnapshotStatus,
    TriggerSource,
} from "./generated/prisma/client";

const connectionString = process.env.DATABASE_URL;
if (connectionString == null) {
    throw new Error("DATABASE_URL environment variable is required");
}

const adapter = new PrismaPg({ connectionString });
const db = new PrismaClient({ adapter });

interface MockOrg {
    name: string;
    slug: string;
    domain: string;
    status: "pending" | "approved" | "rejected";
    memberCount: number;
}

const DEFAULT_WEB_DEPLOYMENT_FILE =
    "s3://autonoma-assets/uploads/default-files/cmmaq609e0032seug0dy32tjh/default-file.pdf";

const MOCK_ORGS: MockOrg[] = [
    { name: "Autonoma", slug: "autonoma", domain: "autonoma.app", status: "approved", memberCount: 3 },
    { name: "Acme Corp", slug: "acme-corp", domain: "acme.com", status: "approved", memberCount: 3 },
    { name: "Globex", slug: "globex", domain: "globex.io", status: "approved", memberCount: 2 },
    { name: "Initech", slug: "initech", domain: "initech.com", status: "pending", memberCount: 1 },
    { name: "Hooli", slug: "hooli", domain: "hooli.xyz", status: "pending", memberCount: 4 },
    { name: "Pied Piper", slug: "pied-piper", domain: "piedpiper.com", status: "approved", memberCount: 2 },
    { name: "Stark Industries", slug: "stark-industries", domain: "stark.io", status: "pending", memberCount: 1 },
    { name: "Wayne Enterprises", slug: "wayne-enterprises", domain: "wayne.co", status: "rejected", memberCount: 1 },
    { name: "Cyberdyne", slug: "cyberdyne", domain: "cyberdyne.tech", status: "approved", memberCount: 3 },
];

function generateMockMembers(orgSlug: string, domain: string, count: number) {
    const firstNames = ["Alice", "Bob", "Charlie", "Diana", "Eve", "Frank", "Grace", "Hank", "Ivy", "Jack"];
    const lastNames = [
        "Smith",
        "Johnson",
        "Williams",
        "Brown",
        "Jones",
        "Garcia",
        "Miller",
        "Davis",
        "Wilson",
        "Moore",
    ];

    return Array.from({ length: count }, (_, i) => {
        const first = firstNames[i % firstNames.length] ?? firstNames[0] ?? "Alice";
        const last = lastNames[(i + orgSlug.length) % lastNames.length] ?? lastNames[0] ?? "Smith";
        return {
            name: `${first} ${last}`,
            email: `${first?.toLowerCase()}.${last?.toLowerCase()}@${domain}`,
        };
    });
}

async function ensureMainWebBranch(params: {
    applicationId: string;
    organizationId: string;
    url: string;
    branchId?: string;
    deploymentId?: string;
    snapshotId?: string;
}) {
    const existing = await db.branch.findFirst({
        where: { applicationId: params.applicationId, name: "main" },
    });

    const branch =
        existing ??
        (await db.branch.create({
            data: {
                ...(params.branchId != null ? { id: params.branchId } : {}),
                name: "main",
                applicationId: params.applicationId,
                organizationId: params.organizationId,
            },
        }));

    const deploymentId =
        branch.deploymentId ??
        (
            await db.branchDeployment.create({
                data: {
                    ...(params.deploymentId != null ? { id: params.deploymentId } : {}),
                    branchId: branch.id,
                    organizationId: params.organizationId,
                },
            })
        ).id;

    await db.webDeployment.upsert({
        where: { deploymentId },
        update: { url: params.url },
        create: {
            deploymentId,
            url: params.url,
            file: DEFAULT_WEB_DEPLOYMENT_FILE,
            organizationId: params.organizationId,
        },
    });

    const activeSnapshotId =
        branch.activeSnapshotId ??
        (
            await db.branchSnapshot.create({
                data: {
                    ...(params.snapshotId != null ? { id: params.snapshotId } : {}),
                    branchId: branch.id,
                    source: TriggerSource.MANUAL,
                    status: SnapshotStatus.active,
                },
            })
        ).id;

    await db.branch.update({
        where: { id: branch.id },
        data: {
            deploymentId,
            activeSnapshotId,
        },
    });

    await db.application.update({
        where: { id: params.applicationId },
        data: { mainBranchId: branch.id },
    });

    return { branchId: branch.id, deploymentId, snapshotId: activeSnapshotId };
}

async function seed() {
    console.log("Seeding mock organizations and members...\n");

    for (const mock of MOCK_ORGS) {
        const org = await db.organization.upsert({
            where: { slug: mock.slug },
            update: { status: mock.status },
            create: {
                name: mock.name,
                slug: mock.slug,
                domain: mock.domain,
                status: mock.status,
            },
        });

        console.log(`  ✓ Org: ${org.name} (${mock.status})`);

        const members = generateMockMembers(mock.slug, mock.domain, mock.memberCount);
        for (const member of members) {
            const user = await db.user.upsert({
                where: { email: member.email },
                update: {},
                create: {
                    name: member.name,
                    email: member.email,
                    emailVerified: false,
                },
            });

            await db.member.upsert({
                where: {
                    userId_organizationId: {
                        userId: user.id,
                        organizationId: org.id,
                    },
                },
                update: {},
                create: {
                    userId: user.id,
                    organizationId: org.id,
                    role: "member",
                },
            });

            console.log(`    • ${member.name} <${member.email}>`);
        }
    }

    console.log("\nSeeding mock applications, test plans, and generations...\n");

    const existingGeneration = await db.testGeneration.findFirst({
        where: { organization: { slug: "autonoma" } },
    });

    const autonoma = await db.organization.findUnique({ where: { slug: "autonoma" } });
    if (autonoma == null) {
        throw new Error("Expected Autonoma org to exist");
    }

    const portalApp = await db.application.upsert({
        where: {
            name_organizationId: { name: "Autonoma Portal", organizationId: autonoma.id },
        },
        update: {},
        create: {
            name: "Autonoma Portal",
            slug: "autonoma-portal",
            organizationId: autonoma.id,
            architecture: ApplicationArchitecture.WEB,
        },
    });

    const dashboardApp = await db.application.upsert({
        where: {
            name_organizationId: { name: "Autonoma Dashboard", organizationId: autonoma.id },
        },
        update: {},
        create: {
            name: "Autonoma Dashboard",
            slug: "autonoma-dashboard",
            organizationId: autonoma.id,
            architecture: ApplicationArchitecture.WEB,
        },
    });

    const portalBranch = await ensureMainWebBranch({
        applicationId: portalApp.id,
        organizationId: autonoma.id,
        url: "https://portal.autonoma.app",
    });

    const dashboardBranch = await ensureMainWebBranch({
        applicationId: dashboardApp.id,
        organizationId: autonoma.id,
        url: "https://dashboard.autonoma.app",
    });

    const appSnapshotMap = new Map<string, string>([
        [portalApp.id, portalBranch.snapshotId],
        [dashboardApp.id, dashboardBranch.snapshotId],
    ]);

    if (existingGeneration == null) {
        const mockGenerations: Array<{
            app: typeof portalApp;
            planName: string;
            plan: string;
            status: (typeof GenerationStatus)[keyof typeof GenerationStatus];
            reasoning?: string;
            steps: Array<{ interaction: string; params: object; output: object }>;
        }> = [
            {
                app: portalApp,
                planName: "Login flow",
                plan: "Verify that users can log in with valid credentials and are redirected to the dashboard.",
                status: GenerationStatus.success,
                reasoning: "All steps completed successfully. The login flow works as expected.",
                steps: [
                    {
                        interaction: "navigate",
                        params: { url: "https://portal.autonoma.app/login" },
                        output: { outcome: "success" },
                    },
                    {
                        interaction: "type",
                        params: { description: "email input field", text: "alice@autonoma.app" },
                        output: { outcome: "success" },
                    },
                    {
                        interaction: "type",
                        params: { description: "password field", text: "••••••••" },
                        output: { outcome: "success" },
                    },
                    {
                        interaction: "click",
                        params: { description: "Sign In button" },
                        output: { outcome: "success", point: { x: 420, y: 310 } },
                    },
                    {
                        interaction: "assert",
                        params: { instruction: "dashboard is visible" },
                        output: { metCondition: true, reason: "Dashboard header is displayed" },
                    },
                ],
            },
            {
                app: portalApp,
                planName: "Checkout flow",
                plan: "Add item to cart, proceed to checkout, and complete purchase.",
                status: GenerationStatus.success,
                reasoning: "Checkout flow validated successfully.",
                steps: [
                    {
                        interaction: "click",
                        params: { description: "Add to cart button" },
                        output: { outcome: "success", point: { x: 380, y: 450 } },
                    },
                    {
                        interaction: "click",
                        params: { description: "View cart icon" },
                        output: { outcome: "success", point: { x: 1200, y: 80 } },
                    },
                    {
                        interaction: "click",
                        params: { description: "Checkout button" },
                        output: { outcome: "success", point: { x: 600, y: 520 } },
                    },
                    {
                        interaction: "assert",
                        params: { instruction: "payment form is visible" },
                        output: { metCondition: true, reason: "Payment form displayed" },
                    },
                ],
            },
            {
                app: portalApp,
                planName: "Password reset",
                plan: "Test the forgot password flow and email verification.",
                status: GenerationStatus.running,
                steps: [
                    {
                        interaction: "click",
                        params: { description: "Forgot password link" },
                        output: { outcome: "success", point: { x: 520, y: 280 } },
                    },
                    {
                        interaction: "type",
                        params: { description: "email input", text: "user@autonoma.app" },
                        output: { outcome: "success" },
                    },
                ],
            },
            {
                app: dashboardApp,
                planName: "Dashboard widgets",
                plan: "Verify all dashboard widgets load and display correct data.",
                status: GenerationStatus.success,
                reasoning: "All widgets rendered correctly.",
                steps: [
                    {
                        interaction: "navigate",
                        params: { url: "https://dashboard.autonoma.app" },
                        output: { outcome: "success" },
                    },
                    {
                        interaction: "assert",
                        params: { instruction: "revenue chart is visible" },
                        output: { metCondition: true, reason: "Chart rendered" },
                    },
                    {
                        interaction: "scroll",
                        params: { direction: "down" },
                        output: { outcome: "success" },
                    },
                    {
                        interaction: "assert",
                        params: { instruction: "activity feed is visible" },
                        output: { metCondition: true, reason: "Activity feed loaded" },
                    },
                ],
            },
            {
                app: dashboardApp,
                planName: "Settings page",
                plan: "Navigate to settings and verify profile section loads.",
                status: GenerationStatus.failed,
                reasoning: "Element 'Profile tab' was not found within timeout.",
                steps: [
                    {
                        interaction: "click",
                        params: { description: "Settings menu" },
                        output: { outcome: "success", point: { x: 80, y: 200 } },
                    },
                    {
                        interaction: "click",
                        params: { description: "Profile tab" },
                        output: { outcome: "error", reason: "Element not found" },
                    },
                ],
            },
            {
                app: portalApp,
                planName: "File upload",
                plan: "Upload a file and verify it appears in the file list.",
                status: GenerationStatus.pending,
                steps: [],
            },
            {
                app: portalApp,
                planName: "Search functionality",
                plan: "Search for a term and assert results are displayed.",
                status: GenerationStatus.success,
                reasoning: "Search returned expected results.",
                steps: [
                    {
                        interaction: "click",
                        params: { description: "search input" },
                        output: { outcome: "success", point: { x: 400, y: 60 } },
                    },
                    {
                        interaction: "type",
                        params: { description: "search input", text: "compression" },
                        output: { outcome: "success" },
                    },
                    {
                        interaction: "assert",
                        params: { instruction: "search results are displayed" },
                        output: { metCondition: true, reason: "Results list visible" },
                    },
                ],
            },
        ];

        for (const mock of mockGenerations) {
            const testCase = await db.testCase.create({
                data: {
                    name: mock.planName,
                    slug: toSlug(mock.planName),
                    applicationId: mock.app.id,
                    organizationId: autonoma.id,
                },
            });

            const testPlan = await db.testPlan.create({
                data: {
                    prompt: mock.plan,
                    testCaseId: testCase.id,
                    organizationId: autonoma.id,
                },
            });

            const stepInputList = await db.stepInputList.create({
                data: { planId: testPlan.id, organizationId: autonoma.id },
            });

            const stepOutputList = await db.stepOutputList.create({
                data: { organizationId: autonoma.id },
            });

            const snapshotId = appSnapshotMap.get(mock.app.id);
            if (snapshotId == null) throw new Error(`No snapshot for app ${mock.app.id}`);

            await db.testGeneration.create({
                data: {
                    testPlanId: testPlan.id,
                    snapshotId,
                    organizationId: autonoma.id,
                    status: mock.status,
                    reasoning: mock.reasoning,
                    conversation: [],
                    stepsId: stepInputList.id,
                    outputsId: stepOutputList.id,
                },
            });

            for (const [i, step] of mock.steps.entries()) {
                const stepInput = await db.stepInput.create({
                    data: {
                        listId: stepInputList.id,
                        organizationId: autonoma.id,
                        order: i,
                        interaction: step.interaction,
                        params: step.params,
                    },
                });

                await db.stepOutput.create({
                    data: {
                        listId: stepOutputList.id,
                        organizationId: autonoma.id,
                        order: i,
                        output: step.output,
                        stepInputId: stepInput.id,
                    },
                });
            }

            console.log(`  ✓ Generation: ${mock.planName} (${mock.status}) — ${mock.app.name}`);
        }
    } else {
        console.log("  (Mock generations already exist, skipping duplicate generation seed)");
    }

    // ── Main seed: Demo App, Agree, folders, tests, runs ────────────────────────

    const SCREENSHOT_URL =
        "https://i.natgeofe.com/n/548467d8-c5f1-4551-9f58-6817a8d2c45e/NationalGeographic_2572187_16x9.jpg?w=1200";

    const org = await db.organization.upsert({
        where: { slug: "autonoma" },
        update: {},
        create: {
            name: "Autonoma",
            slug: "autonoma",
        },
    });

    console.log(`Organization "${org.name}" ready (${org.id})`);

    const users = await db.user.findMany({
        where: { email: { endsWith: "@autonoma.app" } },
    });

    for (const user of users) {
        await db.user.update({
            where: { id: user.id },
            data: { role: "admin" },
        });
        await db.member.upsert({
            where: {
                userId_organizationId: { userId: user.id, organizationId: org.id },
            },
            update: { role: "owner" },
            create: {
                userId: user.id,
                organizationId: org.id,
                role: "owner",
            },
        });
        console.log(`  Added ${user.email} as owner (role: admin)`);
    }

    // ── Applications ──────────────────────────────────────────────────

    const app = await db.application.upsert({
        where: {
            name_organizationId: { name: "Demo App", organizationId: org.id },
        },
        update: {},
        create: {
            name: "Demo App",
            slug: "demo-app",
            organizationId: org.id,
            architecture: ApplicationArchitecture.WEB,
        },
    });

    console.log(`Application "${app.name}" ready (${app.id})`);

    const demoBranch = await ensureMainWebBranch({
        applicationId: app.id,
        organizationId: org.id,
        url: "https://demo.autonoma.app",
    });

    // ── Application: Agree ──────────────────────────────────────────
    const agreeApp = await db.application.upsert({
        where: {
            name_organizationId: { name: "Agree", organizationId: org.id },
        },
        update: {},
        create: {
            name: "Agree",
            slug: "agree",
            organizationId: org.id,
            architecture: ApplicationArchitecture.WEB,
        },
    });

    console.log(`Application "${agreeApp.name}" ready (${agreeApp.id})`);

    await ensureMainWebBranch({
        applicationId: agreeApp.id,
        organizationId: org.id,
        url: "https://agree.autonoma.app",
    });

    // ── Folders for Demo App ──────────────────────────────────────────

    const authFolder = await db.folder.upsert({
        where: { id: "seed-folder-auth" },
        update: {},
        create: {
            id: "seed-folder-auth",
            name: "Authentication",
            description: "Tests covering user login, registration, and session management",
            applicationId: app.id,
            organizationId: org.id,
        },
    });

    const catalogFolder = await db.folder.upsert({
        where: { id: "seed-folder-catalog" },
        update: {},
        create: {
            id: "seed-folder-catalog",
            name: "Product Catalog",
            description: "Tests covering product discovery, search, and filtering",
            applicationId: app.id,
            organizationId: org.id,
        },
    });

    const cartFolder = await db.folder.upsert({
        where: { id: "seed-folder-cart" },
        update: {},
        create: {
            id: "seed-folder-cart",
            name: "Shopping Cart",
            description: "Tests covering cart management and checkout flows",
            applicationId: app.id,
            organizationId: org.id,
        },
    });

    console.log("  Folders seeded");

    // ── Folders for Agree ─────────────────────────────────────────────

    await db.folder.upsert({
        where: { id: "seed-folder-agree-contracts" },
        update: {},
        create: {
            id: "seed-folder-agree-contracts",
            name: "Contracts",
            description: "Tests covering contract creation, signing, and management",
            applicationId: agreeApp.id,
            organizationId: org.id,
        },
    });

    await db.folder.upsert({
        where: { id: "seed-folder-agree-auth" },
        update: {},
        create: {
            id: "seed-folder-agree-auth",
            name: "Authentication",
            description: "Tests covering login and onboarding flows",
            applicationId: agreeApp.id,
            organizationId: org.id,
        },
    });

    console.log("  Agree folders seeded");

    // ── TestCases + TestPlans + TestGenerations ────────────────────

    const tc1 = await db.testCase.upsert({
        where: { id: "seed-tc-login" },
        update: { folderId: authFolder.id },
        create: {
            id: "seed-tc-login",
            name: "Login Flow",
            slug: "login-flow",
            description: "Verify user can log in with valid credentials",
            applicationId: app.id,
            organizationId: org.id,
            folderId: authFolder.id,
        },
    });

    const plan1 = await db.testPlan.upsert({
        where: { id: "seed-plan-login" },
        update: {},
        create: {
            id: "seed-plan-login",
            prompt: "Log in with valid credentials and verify access to the dashboard",
            testCaseId: tc1.id,
            organizationId: org.id,
        },
    });

    const stepList1 = await db.stepInputList.upsert({
        where: { id: "seed-sil-login" },
        update: {},
        create: {
            id: "seed-sil-login",
            planId: plan1.id,
            organizationId: org.id,
        },
    });

    await db.testGeneration.upsert({
        where: { id: "seed-gen-login" },
        update: {},
        create: {
            id: "seed-gen-login",
            testPlanId: plan1.id,
            snapshotId: demoBranch.snapshotId,
            organizationId: org.id,
            stepsId: stepList1.id,
        },
    });

    const tc2 = await db.testCase.upsert({
        where: { id: "seed-tc-search" },
        update: { folderId: catalogFolder.id },
        create: {
            id: "seed-tc-search",
            name: "Search Products",
            slug: "search-products",
            description: "Search for a product and verify results",
            applicationId: app.id,
            organizationId: org.id,
            folderId: catalogFolder.id,
        },
    });

    const plan2 = await db.testPlan.upsert({
        where: { id: "seed-plan-search" },
        update: {},
        create: {
            id: "seed-plan-search",
            prompt: "Search for a product by name and verify the results page shows matching items",
            testCaseId: tc2.id,
            organizationId: org.id,
        },
    });

    const stepList2 = await db.stepInputList.upsert({
        where: { id: "seed-sil-search" },
        update: {},
        create: {
            id: "seed-sil-search",
            planId: plan2.id,
            organizationId: org.id,
        },
    });

    await db.testGeneration.upsert({
        where: { id: "seed-gen-search" },
        update: {},
        create: {
            id: "seed-gen-search",
            testPlanId: plan2.id,
            snapshotId: demoBranch.snapshotId,
            organizationId: org.id,
            stepsId: stepList2.id,
        },
    });

    const tc3 = await db.testCase.upsert({
        where: { id: "seed-tc-cart" },
        update: { folderId: cartFolder.id },
        create: {
            id: "seed-tc-cart",
            name: "Add to Cart",
            slug: "add-to-cart",
            description: "Add item to cart and verify cart contents",
            applicationId: app.id,
            organizationId: org.id,
            folderId: cartFolder.id,
        },
    });

    const plan3 = await db.testPlan.upsert({
        where: { id: "seed-plan-cart" },
        update: {},
        create: {
            id: "seed-plan-cart",
            prompt: "Add a product to the shopping cart and verify the cart contents",
            testCaseId: tc3.id,
            organizationId: org.id,
        },
    });

    const stepList3 = await db.stepInputList.upsert({
        where: { id: "seed-sil-cart" },
        update: {},
        create: {
            id: "seed-sil-cart",
            planId: plan3.id,
            organizationId: org.id,
        },
    });

    await db.testGeneration.upsert({
        where: { id: "seed-gen-cart" },
        update: {},
        create: {
            id: "seed-gen-cart",
            testPlanId: plan3.id,
            snapshotId: demoBranch.snapshotId,
            organizationId: org.id,
            stepsId: stepList3.id,
        },
    });

    console.log("  TestCases + TestPlans + TestGenerations seeded");

    // ── Steps for Test 1: Login Flow ──────────────────────────────────

    const test1StepDefs = [
        { id: "seed-si-1a", order: 1, interaction: "navigate", params: { url: "https://demo.autonoma.app/login" } },
        {
            id: "seed-si-1b",
            order: 2,
            interaction: "type",
            params: { description: "email input field", text: "user@example.com" },
        },
        {
            id: "seed-si-1c",
            order: 3,
            interaction: "type",
            params: { description: "password input field", text: "password123" },
        },
        { id: "seed-si-1d", order: 4, interaction: "click", params: { description: "Sign In button" } },
        {
            id: "seed-si-1e",
            order: 5,
            interaction: "assert",
            params: { instruction: "Verify the dashboard is displayed" },
        },
    ];

    for (const step of test1StepDefs) {
        await db.stepInput.upsert({
            where: { id: step.id },
            update: { params: step.params, interaction: step.interaction },
            create: { ...step, listId: stepList1.id, organizationId: org.id },
        });
    }

    // ── Steps for Test 2: Search Products ─────────────────────────────

    const test2StepDefs = [
        { id: "seed-si-2a", order: 1, interaction: "navigate", params: { url: "https://demo.autonoma.app/products" } },
        { id: "seed-si-2b", order: 2, interaction: "click", params: { description: "search bar" } },
        {
            id: "seed-si-2c",
            order: 3,
            interaction: "type",
            params: { description: "search input", text: "wireless headphones" },
        },
        {
            id: "seed-si-2d",
            order: 4,
            interaction: "assert",
            params: { instruction: "Verify search results contain at least 3 items" },
        },
        { id: "seed-si-2e", order: 5, interaction: "click", params: { description: "first search result" } },
        {
            id: "seed-si-2f",
            order: 6,
            interaction: "assert",
            params: { instruction: "Verify the product detail page is displayed" },
        },
    ];

    for (const step of test2StepDefs) {
        await db.stepInput.upsert({
            where: { id: step.id },
            update: { params: step.params, interaction: step.interaction },
            create: { ...step, listId: stepList2.id, organizationId: org.id },
        });
    }

    // ── Steps for Test 3: Add to Cart ─────────────────────────────────

    const test3StepDefs = [
        {
            id: "seed-si-3a",
            order: 1,
            interaction: "navigate",
            params: { url: "https://demo.autonoma.app/products/wireless-headphones" },
        },
        { id: "seed-si-3b", order: 2, interaction: "click", params: { description: "Add to Cart button" } },
        {
            id: "seed-si-3c",
            order: 3,
            interaction: "assert",
            params: { instruction: "Verify cart badge shows 1 item" },
        },
        {
            id: "seed-si-3d",
            order: 4,
            interaction: "click",
            params: { description: "cart icon in the navigation bar" },
        },
        {
            id: "seed-si-3e",
            order: 5,
            interaction: "assert",
            params: { instruction: "Verify the item appears in the cart" },
        },
    ];

    for (const step of test3StepDefs) {
        await db.stepInput.upsert({
            where: { id: step.id },
            update: { params: step.params, interaction: step.interaction },
            create: { ...step, listId: stepList3.id, organizationId: org.id },
        });
    }

    console.log("  Steps seeded");

    // ── Branch + Snapshot + Assignments ─────────────────────────────
    const mainBranch = await db.branch.upsert({
        where: { id: "seed-branch-main" },
        update: {},
        create: {
            id: "seed-branch-main",
            name: "main",
            applicationId: app.id,
            organizationId: org.id,
        },
    });

    const mainDeployment = await db.branchDeployment.upsert({
        where: { id: "seed-deployment-main" },
        update: {},
        create: {
            id: "seed-deployment-main",
            branchId: mainBranch.id,
            organizationId: org.id,
            webDeployment: {
                create: {
                    url: "https://demo.autonoma.app",
                    file: "s3://autonoma-assets/uploads/default-files/cmmaq609e0032seug0dy32tjh/default-file.png",
                    organizationId: org.id,
                },
            },
        },
    });

    const mainSnapshot = await db.branchSnapshot.upsert({
        where: { id: "seed-snapshot-main" },
        update: {},
        create: {
            id: "seed-snapshot-main",
            branchId: mainBranch.id,
            source: TriggerSource.MANUAL,
            status: SnapshotStatus.active,
        },
    });

    await db.branch.update({
        where: { id: mainBranch.id },
        data: {
            activeSnapshotId: mainSnapshot.id,
            deploymentId: mainDeployment.id,
        },
    });

    await db.application.update({
        where: { id: app.id },
        data: { mainBranchId: mainBranch.id },
    });

    const assignment1 = await db.testCaseAssignment.upsert({
        where: { id: "seed-assign-1" },
        update: {},
        create: {
            id: "seed-assign-1",
            snapshotId: mainSnapshot.id,
            testCaseId: tc1.id,
            planId: plan1.id,
            stepsId: stepList1.id,
        },
    });

    const assignment2 = await db.testCaseAssignment.upsert({
        where: { id: "seed-assign-2" },
        update: {},
        create: {
            id: "seed-assign-2",
            snapshotId: mainSnapshot.id,
            testCaseId: tc2.id,
            planId: plan2.id,
            stepsId: stepList2.id,
        },
    });

    const assignment3 = await db.testCaseAssignment.upsert({
        where: { id: "seed-assign-3" },
        update: {},
        create: {
            id: "seed-assign-3",
            snapshotId: mainSnapshot.id,
            testCaseId: tc3.id,
            planId: plan3.id,
            stepsId: stepList3.id,
        },
    });

    console.log("  Branch + Snapshot + Assignments seeded");

    // ── Runs ─────────────────────────────────────────────────────────
    const now = new Date();

    // Run 1: Login - completed
    const run1Start = new Date(now.getTime() - 45 * 60_000);
    const run1End = new Date(run1Start.getTime() + 32_000);

    await db.run.upsert({
        where: { id: "seed-run-1" },
        update: {},
        create: {
            id: "seed-run-1",
            organizationId: org.id,
            assignmentId: assignment1.id,
            startedAt: run1Start,
            completedAt: run1End,
        },
    });

    const sol1 = await db.stepOutputList.upsert({
        where: { id: "seed-sol-1" },
        update: {},
        create: {
            id: "seed-sol-1",
            organizationId: org.id,
            runId: "seed-run-1",
        },
    });

    for (const step of test1StepDefs) {
        await db.stepOutput.upsert({
            where: { listId_order: { listId: sol1.id, order: step.order } },
            update: {},
            create: {
                listId: sol1.id,
                organizationId: org.id,
                order: step.order,
                output: { message: "Step completed successfully", reasoning: "Element found and action performed" },
                stepInputId: step.id,
                screenshotBefore: SCREENSHOT_URL,
                screenshotAfter: SCREENSHOT_URL,
            },
        });
    }
    console.log("  Run 1 (Login — completed) seeded");

    // Run 2: Search — completed
    const run2Start = new Date(now.getTime() - 30 * 60_000);
    const run2End = new Date(run2Start.getTime() + 28_000);

    await db.run.upsert({
        where: { id: "seed-run-2" },
        update: {},
        create: {
            id: "seed-run-2",
            organizationId: org.id,
            assignmentId: assignment2.id,
            startedAt: run2Start,
            completedAt: run2End,
        },
    });

    const sol2 = await db.stepOutputList.upsert({
        where: { id: "seed-sol-2" },
        update: {},
        create: {
            id: "seed-sol-2",
            organizationId: org.id,
            runId: "seed-run-2",
        },
    });

    for (const step of test2StepDefs) {
        const isFailed = step.order === 4;
        const isSkipped = step.order > 4;
        await db.stepOutput.upsert({
            where: { listId_order: { listId: sol2.id, order: step.order } },
            update: {},
            create: {
                listId: sol2.id,
                organizationId: org.id,
                order: step.order,
                output: {
                    message: isFailed
                        ? "Expected at least 3 results but found 0"
                        : isSkipped
                          ? null
                          : "Step completed successfully",
                    reasoning: isFailed
                        ? "Search returned empty results — possible backend issue"
                        : isSkipped
                          ? null
                          : "Element located and action performed",
                },
                stepInputId: step.id,
                screenshotBefore: step.order <= 4 ? SCREENSHOT_URL : null,
                screenshotAfter: step.order <= 3 ? SCREENSHOT_URL : null,
            },
        });
    }
    console.log("  Run 2 (Search — completed) seeded");

    // Run 3: Cart — in progress
    const run3Start = new Date(now.getTime() - 2 * 60_000);

    await db.run.upsert({
        where: { id: "seed-run-3" },
        update: {},
        create: {
            id: "seed-run-3",
            organizationId: org.id,
            assignmentId: assignment3.id,
            startedAt: run3Start,
            completedAt: null,
        },
    });

    const sol3 = await db.stepOutputList.upsert({
        where: { id: "seed-sol-3" },
        update: {},
        create: {
            id: "seed-sol-3",
            organizationId: org.id,
            runId: "seed-run-3",
        },
    });

    for (const step of test3StepDefs.filter((s) => s.order <= 2)) {
        await db.stepOutput.upsert({
            where: { listId_order: { listId: sol3.id, order: step.order } },
            update: {},
            create: {
                listId: sol3.id,
                organizationId: org.id,
                order: step.order,
                output: { message: "Step completed successfully", reasoning: "Element located and action performed" },
                stepInputId: step.id,
                screenshotBefore: SCREENSHOT_URL,
                screenshotAfter: SCREENSHOT_URL,
            },
        });
    }
    console.log("  Run 3 (Cart — running) seeded");

    // Run 4: Login — completed (older)
    const run4Start = new Date(now.getTime() - 3 * 3600_000);
    const run4End = new Date(run4Start.getTime() + 29_000);

    await db.run.upsert({
        where: { id: "seed-run-4" },
        update: {},
        create: {
            id: "seed-run-4",
            organizationId: org.id,
            assignmentId: assignment1.id,
            startedAt: run4Start,
            completedAt: run4End,
        },
    });

    const sol4 = await db.stepOutputList.upsert({
        where: { id: "seed-sol-4" },
        update: {},
        create: {
            id: "seed-sol-4",
            organizationId: org.id,
            runId: "seed-run-4",
        },
    });

    for (const step of test1StepDefs) {
        await db.stepOutput.upsert({
            where: { listId_order: { listId: sol4.id, order: step.order } },
            update: {},
            create: {
                listId: sol4.id,
                organizationId: org.id,
                order: step.order,
                output: { message: "Step completed successfully", reasoning: "Element found and action performed" },
                stepInputId: step.id,
                screenshotBefore: SCREENSHOT_URL,
                screenshotAfter: SCREENSHOT_URL,
            },
        });
    }
    console.log("  Run 4 (Login — completed, older) seeded");

    // Run 5: Search — pending
    await db.run.upsert({
        where: { id: "seed-run-5" },
        update: {},
        create: {
            id: "seed-run-5",
            organizationId: org.id,
            assignmentId: assignment2.id,
            startedAt: null,
            completedAt: null,
        },
    });
    console.log("  Run 5 (Search — pending) seeded");

    await db.billingPromoCode.upsert({
        where: { code: "0BUGS" },
        update: {
            description: "0BUGS launch promo: +100,000 credits, limited to 50 uses.",
            grantCredits: 100_000,
            maxRedemptions: 50,
            redeemedCount: 0,
            startsAt: new Date(),
            endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            isActive: true,
        },
        create: {
            code: "0BUGS",
            description: "0BUGS launch promo: +100,000 credits, limited to 50 uses.",
            grantCredits: 100_000,
            maxRedemptions: 50,
            redeemedCount: 0,
            startsAt: new Date(),
            endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            isActive: true,
        },
    });
    console.log("  Promo code 0BUGS seeded");

    console.log("Seed complete");
}

seed()
    .catch((error: unknown) => {
        console.error("Seed failed:", error);
        process.exit(1);
    })
    .finally(() => void db.$disconnect());
