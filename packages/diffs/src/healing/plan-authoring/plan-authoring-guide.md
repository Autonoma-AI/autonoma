# Plan Authoring Guide

This section teaches you how to write the *body* of a test plan whenever you create or modify one. Plans are persisted as a single prompt string (`TestPlan.prompt`); they are NOT wrapped in YAML frontmatter at runtime. Test name, scenario assignment, and flow live on adjacent records, so do not include them in the plan body.

## Plan body shape

Every plan body has four sections, in order, written in plain text:

1. **Setup** — One paragraph stating where the user starts (the page reached through the app's normal navigation). The user is ALWAYS already authenticated; never include a login step or "log in as ...". Describe the click path to reach the starting page only when the page is not the app root.
2. **Steps** — A numbered list of user actions, one action per line, using the verbs below. Each step is concrete and reproducible.
3. **Verification** — Steps that navigate to the source of truth (the list, the detail view, the settings page, etc.) and assert the mutation's effect. UI acknowledgments like toasts do not count as verification.
4. **Expected Result** — One sentence describing what must be true when the test passes.

Every plan MUST perform a real mutation (create, edit, delete, toggle, configure) and assert the outcome. Render-only / open-and-close plans test nothing and must be folded into a flow that actually does something.

## Allowed step verbs

Use only these verbs in numbered steps. Any other verb is invalid.

- `click:` — click a button, link, tab, row, or visible element
- `type:` — type text into an input or textarea
- `scroll:` — scroll to an element or position
- `assert:` — verify something visually visible on screen (text, heading, button, label, image)
- `hover:` — hover over an element to reveal hover-only UI
- `drag:` — drag an element from one position to another
- `read:` — read text from an element into a named variable (see Memory variables)
- `refresh:` — refresh the page

Reserved (do NOT put in plans): `navigate:` is the execution agent's last-resort tool, not a plan instruction. Drive every page transition through clickable UI.

## Banned verbs (never write these)

- `wait:` — invalid. The execution agent handles waiting automatically.
- `verify:` — invalid. Use `assert:` instead.
- `select:` — invalid. Use `click:` to open a dropdown then `click:` to pick an option.
- `check:` — invalid. Use `click:` to toggle a checkbox, `assert:` to verify state.
- `navigate:` — invalid in plans. Navigation must come through visible UI clicks.
- Parenthetical meta-notes (`(Internal: ...)`, `(Note: ...)`) — invalid. Steps are user actions, not commentary.

## Visual-only constraints

The execution agent sees the screen the way a human does. It CANNOT access:

- URLs or the browser address bar — never write "assert: URL contains /foo"
- Network requests or API calls — never write "assert: API call X was made"
- HTML structure, DOM elements, or element attributes — never reference `div`, `span`, `input`, `button` as element types
- CSS selectors, `data-testid`, `data-cy`, `aria-label`, `[role=...]`, `#id`, `.class-name`
- Console logs, cookies, localStorage, or any non-visual state

Describe what the user *sees*: button text, label text, placeholder text, heading text, visible icons, tab names. For icon-only buttons, describe what the icon depicts ("trash can icon button", "three vertical dots icon"), never the component name (`MoreVertical`, `IconTrash`).

## Untestable behaviors

Some behaviors produce no outcome the visual agent can observe. A plan built on one cannot pass honestly, so never author it; if a flow reduces to one of these, drop it.

- **External-service connections.** Anything that depends on a live connection to a third-party service is untestable: test organizations are provisioned fresh through the SDK and are never connected to any external service. This covers email and SMS providers, payment processors, CRM syncs, OAuth-linked integrations, and webhooks. There is no testable in-app half. Both the trigger (for example "Send invite") and any acknowledgment or status it would produce ("Invitation sent", a "Connected to Stripe" badge) depend on the connection that never exists.
- **Exported or downloaded file contents.** The agent has no filesystem access and can never open a file the app produces, so never assert the contents of a downloaded or exported file: its rows, values, formatting, or name. An export is testable only when it also leaves persistent in-app state that survives a refresh, such as a row in an exports or history list. If the only result is the file itself, the export is not testable, so do not author a plan around it.

## Assertion location context

Every `assert:` step must say *where* on the page the element appears. Bare "text X is visible" is never enough.

- GOOD: `assert: text "Run preview" is visible in the side panel`
- GOOD: `assert: heading "Settings" is visible at the top of the page`
- GOOD: `assert: text "Archived" is visible in the deal's status column`
- BAD: `assert: text "Status" is visible` (where? column header? form label? sidebar?)

## Never assert toasts

Toasts auto-dismiss, and the agent cannot reliably time an assertion against one before it disappears. Never assert on toast text, nor on a toast appearing or disappearing, whether as a step or as verification. Assert the persistent source of truth the action produced instead (the new row in the list, the updated field in the detail view). This is why a toast never counts as verification.

## Resolving i18n text before asserting

When a component renders text through an i18n function (`t('key')`, `useTranslations`, `$t()`, `i18n.t()`, or similar), the plan must assert the **actual rendered string**, not the key name. Before writing any assertion on that text, read the locale file (e.g. `messages/en.json`, `locales/en.json`, `i18n/en.ts`) to resolve the key to its value.

- GOOD (after reading `messages/en.json` and finding `"oktaSignInTitle": "Sign in with SSO"`):
  `assert: text "Sign in with SSO" is visible in the card header`
- BAD (key name used as text, or guessed without reading the file):
  `assert: text "oktaSignInTitle" is visible`
  `assert: text "Sign in with your email" is visible`

If the codebase has multiple locale files, read the English one (`en.json`, `en.ts`, etc.). Never guess what a translation key renders to.

## Functional assertions

Every plan must have a functional assertion — one that proves the feature did something, not just that UI appeared. The last assertion should describe the OUTCOME of the action, not the UI state on the way to it.

- BAD (open-and-close cycle, tests nothing):
  1. `click: the "Import component" button`
  2. `assert: "Import component" is visible in the modal header`
  3. `click: the "Close" button in the modal`
  4. `assert: "Import component" is no longer visible`
- GOOD (completes the action):
  1. `click: the "Import component" button`
  2. `click: "Login Component" in the component list`
  3. `click: the "Import" button`
  4. `assert: "Login Component" is visible in the step list`

After every mutation, navigate to the source of truth and assert the effect:

- After CREATE → verify the item appears in the list / table
- After EDIT → verify the changed field in the detail or list view
- After DELETE → verify absence in the list, refresh, verify still absent
- After TOGGLE → refresh, verify the toggle retained its new state

## State-transition awareness

Before writing a step that interacts with a stateful element (toggle, checkbox, dropdown), the writer must know its initial state. State the expected transition explicitly:

- GOOD: `click: the "Recording" toggle to switch it from ON to OFF`
- BAD: `click: the "Recording" toggle` (ambiguous — what does "click" do here?)

If the source code reveals a non-obvious default, describe it in Setup or assert it before interacting.

When a plan updates an existing visible value (an edit or a toggle), assert the **prior** value before the change and the **new** value after it. Asserting both ends is what proves the action changed something: without the before-assertion a test can pass even when nothing happened, because the "new" value already matched the seeded data. Assert the prior value wherever it is already visible on the path to the change (the pre-filled field, the detail row). This does not apply to creates (no prior value) or deletes (covered by verifying absence after a refresh).

- GOOD: `assert: text "Free" is visible in the plan column`, then change the plan, then `assert: text "Pro" is visible in the plan column`
- BAD: change the plan, then `assert: text "Pro" is visible in the plan column` with no prior assertion that it read "Free"

## Scenario data referencing

When the plan runs under a scenario, the database is seeded with that scenario's fixture data before execution. The exact entity names, counts, and field values are known ahead of time — assertions should reference those exact values.

- GOOD (scenario seeds a deal named "Acme Q3 Renewal"): `assert: text "Acme Q3 Renewal" is visible in the deals table`
- BAD: `assert: a deal is visible in the table`
- BAD: `assert: a deal "or similar" is visible`

Use `{{token}}` placeholders only for values that genuinely vary between runs (auto-generated ids, timestamps the platform produces). Never write `{variableName}`, `e.g.`, `Dynamic:`, or "or".

## Memory variables

Mid-test values extracted with `read:` can be referenced later as `{{variableName}}`:

- `read: the order ID shown on the confirmation page into "orderId"`
- `click: the row containing "{{orderId}}" in the orders table`
- `assert: text "{{orderId}}" is visible in the order detail header`

Always prefer extract-and-reference over hardcoding any value the test just produced.

## Execution agent capabilities at a glance

The plan body is consumed by an AI execution agent that drives a browser visually. The agent:

- Sees a screenshot at each step and narrates what it sees before acting.
- Decides element targeting from a natural-language description — give it the visible text or visual landmark.
- Stores variables extracted with `read:` and substitutes `{{token}}` references at runtime.
- Stops itself when it detects a loop. Plans should not retry the same step; let the agent do that.
- Falls back to URL navigation only as a last resort; plans should reach every page through clickable UI.

Plans that fight these capabilities (asking for DOM access, asserting URLs, hardcoding dynamic values, omitting location context) will fail in execution.
