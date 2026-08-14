import { describe, expect, test } from "vitest";
import { findTokenisedDisplayFields } from "../../src/agents/03-scenario-recipe/scenario-table";

/** The columns flagged by the gate, for terse assertions on which cells it caught. */
const columnsOf = (content: string) => findTokenisedDisplayFields(content).map((f) => f.column);

/**
 * The failure this guards against, taken from a real run: a DNS zone whose Domain is a
 * displayed, unique value. The scenario tokenised the domain for uniqueness; step 5, unable
 * to emit the token, invented the literal "acme-internal" - a zone that never existed at run
 * time, so the test failed against the customer's product for a bug that was ours.
 */
const withDomainRow = (domain: string) => `
## DNS Configuration

| Zone ID | Account ID | Domain |
| :--- | :--- | :--- |
| zone-net-{{testRunShortId}} | acc-{{testRunShortId}} | ${domain} |
`;

/** A single-column table whose header we vary, with a run-unique token in the one cell. */
const singleColumn = (header: string) => `
| ${header} |
| :--- |
| val-{{testRunShortId}} |
`;

describe("findTokenisedDisplayFields", () => {
    test("accepts tokens confined to id columns while the displayed value stays token-free", () => {
        // Uniqueness rides on the account id; the (account, domain) pair is unique per run
        // without the domain itself carrying a token.
        expect(findTokenisedDisplayFields(withDomainRow("acme.internal"))).toEqual([]);
    });

    test("rejects a run-unique token in a displayed column, naming the column and value", () => {
        const fields = findTokenisedDisplayFields(withDomainRow("acme-{{testRunShortId}}.internal"));

        expect(fields).toHaveLength(1);
        expect(fields[0]?.column).toBe("Domain");
        expect(fields[0]?.value).toBe("acme-{{testRunShortId}}.internal");
        expect(fields[0]?.message).toContain("Domain");
        expect(fields[0]?.message).toContain("acme-{{testRunShortId}}.internal");
    });

    test("accepts a token in an email column - a test never names it on screen", () => {
        const content = `
| User ID | Email | Name |
| :--- | :--- | :--- |
| usr-{{testRunShortId}} | admin+{{testRunId}}@acme.test | Jane Doe |
`;

        expect(findTokenisedDisplayFields(content)).toEqual([]);
    });

    test("rejects a token in a Name column", () => {
        const content = `
| Project ID | Name |
| :--- | :--- |
| proj-{{testRunShortId}} | Project {{testRunShortId}} |
`;

        expect(columnsOf(content)).toEqual(["Name"]);
    });

    test("leaves an unknown (non-built-in) token to the concreteness check, not this one", () => {
        // {{ownerName}} is not a run-identity token; validateScenarioIsConcrete owns that error.
        const content = `
| Name |
| :--- |
| {{ownerName}} |
`;

        expect(findTokenisedDisplayFields(content)).toEqual([]);
    });

    test("ignores tokens outside tables and frontmatter", () => {
        const content = `---
scenario_count: 1
scenarios:
  - name: standard
---

Prose mentioning acc-{{testRunShortId}} is not a displayed table cell.
`;

        expect(findTokenisedDisplayFields(content)).toEqual([]);
    });

    test("flags every offending display cell across multiple tables", () => {
        const content = `
| Zone ID | Domain |
| :--- | :--- |
| zone-{{testRunShortId}} | acme-{{testRunShortId}}.internal |

| Group ID | Title |
| :--- | :--- |
| grp-{{testRunShortId}} | Team {{testRunShortId}} |
`;

        expect(columnsOf(content)).toEqual(["Domain", "Title"]);
    });

    /**
     * The heuristic's real risk is OVER-rejection: wrongly flagging a legitimate id/reference
     * column whose header is not an obvious "...ID". These pin the CURRENT behaviour so a future
     * tweak to IDENTIFIER_COLUMN_PATTERNS can't silently start bouncing valid scenarios. The two
     * REJECTED cases ("Key", "Token") are deliberate: both can equally be user-facing labels
     * (a Key/Value settings row, a token shown on screen), so accepting them would reopen the bug.
     */
    describe("identifier-column headers that are not an obvious `...ID`", () => {
        test.each([
            ["Slug ID", true], // "ID" word beats the "Slug" display word
            ["Owner Ref", true], // "Ref" -> reference
            ["PK", true], // primary-key abbreviation
            ["FK", true], // foreign-key abbreviation
            ["Key", false], // ambiguous: could be a displayed "Key" / "Value" row
            ["Token", false], // ambiguous: a token can itself be shown on screen
        ])("%s -> accepted=%s", (header, accepted) => {
            const fields = findTokenisedDisplayFields(singleColumn(header));

            if (accepted) {
                expect(fields).toEqual([]);
                return;
            }
            expect(columnsOf(singleColumn(header))).toEqual([header]);
        });
    });

    /**
     * Mirrors the real NetBird scenario: groups and peers define tokenised ids under
     * identifier columns, then a policy table references those ids under plain-word
     * headers ("Source Groups", "Peer"). The referenced value equals a defined id, so a
     * test selects the row by its display Name and never types the id - these accept.
     */
    describe("foreign-key references judged by value, not header", () => {
        const netbird = (referencingTable: string) => `
| Group ID | Name |
| :--- | :--- |
| group-all-{{testRunShortId}} | All |
| group-servers-{{testRunShortId}} | Servers |
| group-devs-{{testRunShortId}} | Developers |

| Peer ID | Name |
| :--- | :--- |
| peer-srv-1-{{testRunShortId}} | production-db-1 |

${referencingTable}
`;

        test("a policy row referencing a group id under Source Groups is accepted", () => {
            const content = netbird(`
| Policy ID | Source Groups | Destination Groups |
| :--- | :--- | :--- |
| pol-1-{{testRunShortId}} | group-all-{{testRunShortId}} | group-servers-{{testRunShortId}} |
`);

            expect(findTokenisedDisplayFields(content)).toEqual([]);
        });

        test("a comma-separated multi-group reference cell is accepted", () => {
            const content = netbird(`
| Policy ID | Source Groups |
| :--- | :--- |
| pol-1-{{testRunShortId}} | group-devs-{{testRunShortId}}, group-servers-{{testRunShortId}} |
`);

            expect(findTokenisedDisplayFields(content)).toEqual([]);
        });

        test("a peer reference under Peer is accepted", () => {
            const content = netbird(`
| Route ID | Peer |
| :--- | :--- |
| route-1-{{testRunShortId}} | peer-srv-1-{{testRunShortId}} |
`);

            expect(findTokenisedDisplayFields(content)).toEqual([]);
        });

        test("a list whose element matches no known id is still rejected", () => {
            const content = netbird(`
| Policy ID | Source Groups |
| :--- | :--- |
| pol-1-{{testRunShortId}} | group-all-{{testRunShortId}}, group-ghost-{{testRunShortId}} |
`);

            expect(columnsOf(content)).toEqual(["Source Groups"]);
        });
    });

    /**
     * Reference detection must not swallow genuine display literals. A name/domain/host
     * that equals no defined id stays rejected - even though the scenario has id columns.
     */
    describe("display literals still reject when no id matches", () => {
        const withIds = (displayTable: string) => `
| Account ID | Zone ID |
| :--- | :--- |
| acc-{{testRunShortId}} | zone-net-{{testRunShortId}} |

${displayTable}
`;

        test("an account display name is rejected", () => {
            const content = withIds(`
| Account ID | Name |
| :--- | :--- |
| acc-{{testRunShortId}} | Acme Corp {{testRunShortId}} |
`);

            expect(columnsOf(content)).toEqual(["Name"]);
        });

        test("a DNS zone domain is rejected (the Zone ID is a separate value)", () => {
            const content = withIds(`
| Zone ID | Domain |
| :--- | :--- |
| zone-net-{{testRunShortId}} | acme-{{testRunShortId}}.internal |
`);

            expect(columnsOf(content)).toEqual(["Domain"]);
        });

        test("a globally-unique-looking public hostname is rejected", () => {
            // tunnel-<id>.netbird.cloud is not a known id; if it is globally unique this
            // rejection is correct but unsatisfiable without run-time token resolution.
            const content = withIds(`
| Peer ID | Name |
| :--- | :--- |
| peer-1-{{testRunShortId}} | tunnel-{{testRunShortId}}.netbird.cloud |
`);

            expect(columnsOf(content)).toEqual(["Name"]);
        });
    });
});
