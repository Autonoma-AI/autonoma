-- Shadow marker for investigation-created test cases. A shadow test case is a throwaway created ONLY to
-- validate a proposed NEW test (run its candidate plan as a shadow generation); it is never assigned to a
-- snapshot and is excluded from every user-facing catalog read, so it never pollutes the customer's test tree.
-- Mirrors test_generation.shadow.
ALTER TABLE "test_case" ADD COLUMN "shadow" BOOLEAN NOT NULL DEFAULT false;
