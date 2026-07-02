import { describe, expect, it } from "vitest";
import { openModelSession } from "../../src";
import { diagnoseScenarioFailure } from "../../src";
import type { ScenarioRepairRoute, ScenarioFailureInput } from "../../src";

/**
 * A routing evalset for the scenario-failure diagnoser, built entirely from REAL prod failures (the error
 * strings, recipe `create` graphs with their _alias/_ref/template-var nesting, and the pinned test plans were
 * pulled from the DB and investigation reports). Only client-identifying proper nouns are genericized - the
 * technical shape of each failure is verbatim-real.
 *
 * It checks two things:
 *  1. The diagnoser prefers the lowest-risk repair route: a wrong expectation -> fix_test, a missing record the
 *     factory already supports -> recipe_only, a factory that will not honor the requested data -> recipe_and_sdk.
 *  2. It does NOT over-repair. The `unknown` cases are the negative class: a down/slow preview, and - the
 *     dangerous ones - a genuine client bug and a broken test-harness handoff where the app DID load and looked
 *     wrong. A naive router would "fix the test" or "seed more data" and silently bury a real regression; the
 *     diagnoser must keep its hands off (route unknown) on all of those.
 *
 * Also doubles as the sizing instrument. Hits the live OpenAI API, so it only runs with RUN_EVALS=1:
 *   RUN_EVALS=1 pnpm --filter @autonoma/investigation exec vitest run test/scenario-repair/diagnose.eval.test.ts
 */
const RUN = process.env.RUN_EVALS === "1" && process.env.OPENAI_API_KEY != null && process.env.OPENAI_API_KEY !== "";

interface Case {
    name: string;
    /** True for the adversarial negatives: a real failure the diagnoser must NOT try to repair (-> unknown). */
    mustNotRepair: boolean;
    input: ScenarioFailureInput;
    expected: ScenarioRepairRoute;
}

const CASES: Case[] = [
    {
        // REAL: the test types `inv_001`, but that string was only the recipe's internal _alias - the seeded
        // invoice exists as invoiceNumber "INV-2024-001", and the factory assigns random ids. The seed is
        // defensible; the test hard-coded a non-existent id. Test-first: adapt the test, don't touch the factory.
        name: "test hard-coded a non-seeded id -> fix_test",
        mustNotRepair: false,
        input: {
            testPlan:
                'Setup: Start on the workflow page at /workflow.\n\nSteps:\n1. click: the "Build graph" button to populate the knowledge graph\n2. assert: text "Graph populated:" is visible in the header\n3. type: "inv_001" into the "Invoice ID" input field\n4. click: the "Run" button to trigger the agent analysis\n5. assert: text "Decision ready for invoice inv_001" is visible in the decision panel',
            recipeCreateGraph:
                '{"Invoice":[{"_alias":"inv_001","workspaceId":{"_ref":"main_workspace"},"invoiceNumber":"INV-2024-001","supplierName":"Acme Supplies","status":"to-review","source":"email","totalAmount":1250,"currency":"EUR","providerContactId":{"_ref":"contact_acme"}},{"_alias":"inv_002","workspaceId":{"_ref":"main_workspace"},"invoiceNumber":"INV-2024-002","supplierName":"Beta Parts","status":"pre-validated","source":"email","totalAmount":3400.5,"currency":"EUR"}]}',
            failureDetail:
                "The app loaded, the graph populated, the test typed `inv_001` and clicked Run; the assistant repeatedly reported that invoice `inv_001` was not found.",
            runObservation:
                "A first invoice is seeded (invoiceNumber INV-2024-001), but the factory assigns random document ids, so `inv_001` - the recipe alias - is not a real invoice id the app can look up.",
        },
        expected: "fix_test",
    },
    {
        // REAL: the test searches for a project "Annual Facility Upkeep" that was never seeded, but the seeded
        // projects already let it exercise the same search/filter behavior - so the lowest-risk fix is to point
        // the test at a project that exists, NOT to add a record to shared seed data. Test-first: fix_test.
        name: "test searches for a substitutable missing record -> fix_test",
        mustNotRepair: false,
        input: {
            testPlan:
                'Setup: Navigate to the Sales Calendar by clicking "Schedule" then "Sales Calendar".\n\nSteps:\n1. assert: text "Downtown Office Fit-out" is visible in the sidebar list\n2. click: the "Find a project" search input\n3. type: "Annual" into the "Find a project" input\n4. assert: text "Annual Facility Upkeep" is visible in the sidebar\n5. assert: text "Downtown Office Fit-out" is not visible in the sidebar',
            recipeCreateGraph:
                '{"Project":[{"_alias":"p1","tenant_id":{"_ref":"t1"},"account_id":{"_ref":"a1"},"site_id":{"_ref":"s1"},"name":"Downtown Office Fit-out","project_state_id":7,"user_customized_id":"P-1001","salesperson_id":{"_ref":"admin"}},{"_alias":"p2","tenant_id":{"_ref":"t1"},"account_id":{"_ref":"a2"},"site_id":{"_ref":"s2"},"name":"Warehouse Repaint","project_state_id":12,"user_customized_id":"P-1002","salesperson_id":{"_ref":"admin"}}]}',
            failureDetail:
                'The Sales Calendar loaded and showed the seeded projects; typing "Annual" matched nothing and the sidebar showed "Nothing to schedule".',
            runObservation:
                'No project named "Annual Facility Upkeep" was seeded. Other projects (Downtown Office Fit-out, Warehouse Repaint) were seeded successfully - the search/filter behavior can be verified against any of them.',
        },
        expected: "fix_test",
    },
    {
        // REAL: every Analytics report renders an empty state ("No actuals recorded") because the recipe seeds
        // Projects/Estimates/Invoices/Costs but no Actual/production/pricing records - and those report bodies
        // need them to render anything. You cannot rewrite the test around this (its whole point is that the
        // reports render data), and the same factory seeds the sibling record types, so it is a pure data gap.
        name: "report dashboards empty until required records are seeded -> recipe_only",
        mustNotRepair: false,
        input: {
            testPlan:
                'Setup: Navigate to the Analytics page.\n\nIntent: verify each report renders real aggregated rows and totals, not an empty state.\n\nSteps\n1. click: the dashboard selector dropdown\n2. click: the "Daily Actuals" option\n3. assert: at least one data row with a "Units" value and an "Hours" value is visible in the Daily Actuals table\n4. assert: text "Total" with a non-zero dollar figure is visible below the table\n5. click: the dashboard selector dropdown\n6. click: the "Pricing Report" option\n7. assert: at least one "Accepted" pricing row is visible in the pricing table',
            recipeCreateGraph:
                '{"Project":[{"_alias":"p1","tenant_id":{"_ref":"t1"},"name":"Downtown Office Fit-out","project_state_id":7,"user_customized_id":"P-1001"}],"Estimate":[{"_alias":"e1","tenant_id":{"_ref":"t1"},"project_id":{"_ref":"p1"},"is_accepted":true}],"Invoice":[{"_alias":"i1","tenant_id":{"_ref":"t1"},"project_id":{"_ref":"p1"},"invoice_no":"INV-2001"}],"Cost":[{"tenant_id":{"_ref":"t1"},"project_id":{"_ref":"p1"},"amount_cents":320000}]}',
            failureDetail:
                'Analytics loaded and the Admin/Sales dashboards rendered, but the Daily Actuals and Pricing reports showed empty states ("No actuals recorded") - there are no rows or totals to assert, and the test cannot pass without the underlying records existing.',
            runObservation:
                "The recipe seeds Projects, Estimates, Invoices, and Costs (all created successfully via the same factory), but zero Actual and zero pricing records - the exact record types these report tables aggregate. The factory that produced the sibling records is not erroring; the recipe simply never requested these.",
        },
        expected: "recipe_only",
    },
    {
        // REAL (provisioning failure): the recipe asks for a model the client factory has no handler for at all,
        // so no recipe-only tweak can fix it - the factory must register the model first.
        name: "factory has no handler for a requested model -> recipe_and_sdk",
        mustNotRepair: false,
        input: {
            testPlan:
                'Setup\nUsing scenario: standard. Sign in as admin.\n\nSteps\n1. click: "Integrations" in the side panel\n2. click: the row with the name "Acme Connect" to open its settings\n3. assert: heading "Configuration" is visible in the main panel',
            recipeCreateGraph:
                '{"users":[{"_alias":"avery","email":"admin-{{testRunId}}@autonoma-test.local","first_name":"Avery","last_name":"Admin","stytch_organization_id":"org-{{testRunId}}","job_title":"Manager"}],"external_connectors":[{"_alias":"conn1","name":"Acme Connect","kind":"webhook"}]}',
            failureDetail:
                'scenario up failed: SDK returned HTTP 400: Invalid request body: no factory registered for model "external_connectors". Register one with `defineFactory(...)` and add it to HandlerConfig.factories.',
        },
        expected: "recipe_and_sdk",
    },
    {
        // REAL (post-seed): the create graph ALREADY asks for INV-2001 with the "Site Work Phase 1" line item,
        // but the app never shows them - the factory hard-codes item names and does not seed the tenant
        // `invoices.partial_invoice_enabled` setting. The recipe input is correct; the factory does not honor it.
        name: "factory does not honor the requested data -> recipe_and_sdk",
        mustNotRepair: false,
        input: {
            testPlan:
                'Setup: Navigate to the Invoices list.\n\nSteps\n1. click: the "three vertical dots icon" for "INV-2001" in the table\n2. click: "Edit"\n3. click: the "Partial Invoice" button\n4. type: "4000" into the "Amount" input for "Site Work Phase 1" in the "Partial Invoice" modal\n5. assert: text "Invoice updated" is visible in the toast notification',
            recipeCreateGraph:
                '{"Tenant":[{"_alias":"t1","name":"Acme Field Services","settings":{"features":["scheduling"]}}],"Invoice":[{"_alias":"i1","tenant_id":{"_ref":"t1"},"project_id":{"_ref":"p1"},"invoice_no":"INV-2001","paid_status_override":"UNPAID"}],"InvoiceItem":[{"tenant_id":{"_ref":"t1"},"invoice_id":{"_ref":"i1"},"description":"Site Work Phase 1","total_price_cents":500000,"ordinal":1}]}',
            failureDetail:
                'The INV-2001 edit page loaded, but the "Partial Invoice" button was not visible and the "Site Work Phase 1" line item was not present.',
            runObservation:
                "The factory hard-codes invoice item names (all seed as a generic label) and does not seed the tenant `invoices.partial_invoice_enabled` setting, so the button and the specific line item the recipe asks for never appear.",
        },
        expected: "recipe_and_sdk",
    },
    {
        // REAL (negative): the preview deployment served an HTML error page instead of SDK JSON - the app never
        // came up. Not a data problem; nothing in the recipe or test can fix an unreachable preview.
        name: "negative: preview served HTML (app never loaded) -> unknown",
        mustNotRepair: true,
        input: {
            testPlan:
                'Setup\nThe user starts on /home. Click the "Go to dashboard" button on the "Full Stack Web Dev" course card, then "View syllabus".\n\nSteps\n1. assert: text "Certificate requirements" is visible in the sidebar\n2. click: the "Module 2: JavaScript Basics" module header',
            recipeCreateGraph:
                '{"User":[{"role":"STUDENT","email":"{{student_email}}","_alias":"student","status":"ACTIVE","clerkId":"clerk_test_student_{{testRunId}}","lastName":"Learner","firstName":"Alice"}],"Cohort":[{"name":"Web Dev Cohort - Testing","isB2B":false,"_alias":"cohort","country":"US","language":"en","modality":"ONLINE"}]}',
            failureDetail:
                "scenario up failed: SDK returned HTTP 404: Error parsing response: Unexpected token '<', \"<html> <h\"... is not valid JSON",
        },
        expected: "unknown",
    },
    {
        // REAL (negative): the client's /api/autonoma endpoint never responded - the seed request timed out. An
        // unreachable/slow endpoint is an environment problem, not something the recipe or test can repair.
        name: "negative: SDK seed request timed out -> unknown",
        mustNotRepair: true,
        input: {
            testPlan:
                "Setup\nUsing scenario: standard. Open the collection view whose name ends in {{testRunId}}.\n\nSteps\n1. Click to open the document on one of the rows.\n2. Assert the document editor is visible.",
            recipeCreateGraph:
                '{"FeedSource":[{"_alias":"gs-1","name":"Regional Data Feed {{testRunId}}","type":"custom","items":[{"_alias":"item-1","itemName":"Item One {{testRunId}}","type":"record"}]}],"Organization":[{"_alias":"org1","name":"Acme Org {{testRunId}}"}]}',
            failureDetail:
                "scenario up failed: SDK call timed out after 90s - ensure your endpoint is reachable and responds quickly.",
        },
        expected: "unknown",
    },
    {
        // REAL (negative, ADVERSARIAL): the app loaded and the data was correct - the user placed a map marker,
        // saw "Marker 1", clicked Save, and the marker was GONE after refresh. This is a genuine app regression
        // (the PR dropped element normalization in the save path). The diagnoser must NOT "fix" it by editing the
        // test or seeding data - that would silently bury a real client bug. Correct route: unknown (hands off).
        name: "negative: real client bug on a data-backed flow -> unknown",
        mustNotRepair: true,
        input: {
            testPlan:
                'Setup: From the global search, open the project "Annual Facility Upkeep".\n\nSteps\n1. click: the "Map" button in the project detail header\n2. click: the "map pin icon" to activate the Marker tool\n3. click: on the map to place a marker\n4. assert: text "Marker 1" is visible in the sidebar\n5. click: the "Save" button\n6. refresh: the page\n7. assert: text "Marker 1" is still visible in the sidebar',
            recipeCreateGraph:
                '{"Project":[{"_alias":"p1","tenant_id":{"_ref":"t1"},"account_id":{"_ref":"a1"},"site_id":{"_ref":"s1"},"name":"Annual Facility Upkeep","project_state_id":7,"user_customized_id":"P-1001","salesperson_id":{"_ref":"admin"}}],"Site":[{"_alias":"s1","tenant_id":{"_ref":"t1"},"account_id":{"_ref":"a1"},"name":"Downtown Plaza"}]}',
            failureDetail:
                'The project and map opened, the marker was placed and shown as "Marker 1", but after clicking Save no success toast appeared, and the marker was gone after refreshing and reopening the map.',
            runObservation:
                "The seeded project and site were present and correct; the marker existed in the UI until Save. The save path silently dropped the new element - a code defect, not a data or test issue.",
        },
        expected: "unknown",
    },
    {
        // REAL (negative, ADVERSARIAL): the run never reached the feature - the test harness typed an auth token
        // string into the login email field, so sign-in failed browser validation. A broken provisioned-session
        // handoff is an engine/harness problem. The seeded user + crew are correct; editing the test or recipe
        // would not help. Correct route: unknown (hands off).
        name: "negative: broken harness auth handoff -> unknown",
        mustNotRepair: true,
        input: {
            testPlan:
                'Setup: Navigate to the Schedule page.\n\nSteps\n1. click: the "Plus" icon in the calendar header\n2. type: "Maintenance" into the "Title" input\n3. click: the "Crews" dropdown\n4. click: the "Field Crew A" option\n5. click: the "Save" button',
            recipeCreateGraph:
                '{"User":[{"_alias":"admin","email":"demo-admin@autonoma.test","name":"Alex Admin","tenant_id":{"_ref":"t1"},"role_id":1}],"Crew":[{"tenant_id":{"_ref":"t1"},"name":"Field Crew A"},{"tenant_id":{"_ref":"t1"},"name":"Finishing Crew"}]}',
            failureDetail:
                "The run never reached the app at all: scenario up provisioned a valid authenticated session, but the browser harness failed to apply it and fell back to a manual login, typing a session-token string into the login email field, so browser validation rejected it for missing an '@'. No feature was ever exercised.",
            runObservation:
                "The seeded admin user and the 'Field Crew A' option are both present and correct - the failure is entirely in the harness/session handoff before the app, not in any seeded data or test step.",
        },
        expected: "unknown",
    },
];

describe.skipIf(!RUN)("eval: scenario-failure diagnosis routing (gpt-5.5)", () => {
    for (const testCase of CASES) {
        const tag = testCase.mustNotRepair ? "[neg]" : "[pos]";
        it(`routes: ${tag} ${testCase.name}`, async () => {
            const model = openModelSession({ openaiApiKey: process.env.OPENAI_API_KEY ?? "" }).getModel({
                model: "classifier",
                tag: "eval-scenario-diagnose",
            });
            const diagnosis = await diagnoseScenarioFailure(testCase.input, { model });
            // eslint-disable-next-line no-console
            console.log(
                `\n[eval] ${tag} ${testCase.name}: ${diagnosis.route} (${diagnosis.confidence})\n  ${diagnosis.reasoning}\n`,
            );
            expect(diagnosis.route).toBe(testCase.expected);
            if (diagnosis.route === "fix_test") expect(diagnosis.testFix).toBeDefined();
            if (diagnosis.route === "recipe_and_sdk") {
                expect(diagnosis.recipeChange).toBeDefined();
                expect(diagnosis.factoryIssue).toBeDefined();
            }
        });
    }
});
