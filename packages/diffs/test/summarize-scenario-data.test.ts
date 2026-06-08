import { describe, expect, it } from "vitest";
import type { ScenarioData } from "../src/scenario-data";
import { summarizeScenarioData } from "../src/scenario-data";

describe("summarizeScenarioData", () => {
    it("inlines per-type count, aliases, and prioritized identifying fields", () => {
        const data: ScenarioData = {
            scenarioName: "Org with two users",
            entities: {
                User: [
                    { _alias: "owner", id: "u1", email: "owner@example.test", name: "Pat Owner", role: "admin" },
                    { _alias: "member", id: "u2", email: "member@example.test", name: "Sam Member", role: "member" },
                ],
            },
        };

        const summary = summarizeScenarioData(data);

        expect(summary).toContain("Org with two users");
        expect(summary).toContain("### User - 2 records");
        // `name` and `email` outrank `id`/`role` in the priority list.
        expect(summary).toContain("Identifying fields: `name`, `email`");
        expect(summary).toContain("`owner` - name: Pat Owner, email: owner@example.test");
        expect(summary).toContain("`member` - name: Sam Member, email: member@example.test");
    });

    it("sorts entity types alphabetically", () => {
        const data: ScenarioData = {
            scenarioName: "Mixed",
            entities: {
                Project: [{ _alias: "p", title: "Apollo" }],
                Account: [{ _alias: "a", name: "Acme" }],
            },
        };

        const summary = summarizeScenarioData(data);

        expect(summary.indexOf("### Account")).toBeLessThan(summary.indexOf("### Project"));
    });

    it("bounds the preview and points at the disclosure tool when a type has many records", () => {
        const records = Array.from({ length: 25 }, (_unused, index) => ({
            _alias: `item-${index}`,
            name: `Item ${index}`,
        }));
        const data: ScenarioData = { scenarioName: "Big", entities: { Item: records } };

        const summary = summarizeScenarioData(data);

        expect(summary).toContain("### Item - 25 records");
        expect(summary).toContain("`item-0` - name: Item 0");
        expect(summary).toContain("`item-19` - name: Item 19");
        // 20-record cap: the 21st record is not inlined.
        expect(summary).not.toContain("`item-20`");
        expect(summary).toContain('...and 5 more. Call `read_scenario_entities("Item")`');
    });

    it("caps the number of entity types and names the overflow", () => {
        const entities = Object.fromEntries(
            Array.from({ length: 35 }, (_unused, index) => [
                `Type${String(index).padStart(2, "0")}`,
                [{ _alias: `a${index}`, name: `n${index}` }],
            ]),
        );
        const data: ScenarioData = { scenarioName: "Many types", entities };

        const summary = summarizeScenarioData(data);

        expect(summary).toContain("### Type00");
        expect(summary).toContain("### Type29");
        // 30-type cap: Type30 is rolled into the overflow note, not its own section.
        expect(summary).not.toContain("### Type30 -");
        expect(summary).toContain("...and 5 more entity types: Type30, Type31, Type32, Type33, Type34");
    });

    it("falls back to an index handle when a record has no alias and ignores ref/object fields", () => {
        const data: ScenarioData = {
            scenarioName: "No aliases",
            entities: {
                Post: [{ title: "Hello", authorId: { _ref: "owner" }, tags: ["a", "b"] }],
            },
        };

        const summary = summarizeScenarioData(data);

        expect(summary).toContain("Identifying fields: `title`");
        expect(summary).toContain("`#0` - title: Hello");
        // `authorId` (a ref) and `tags` (an array) are not scalar identifying fields.
        expect(summary).not.toContain("authorId");
        expect(summary).not.toContain("tags");
    });
});
