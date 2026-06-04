---
description: "A rename button was added to TODOs"
skip: false
modified:
    exact:
        - 001-delete-task-from-column-md
        - 002-move-task-via-dropdown-md
        - 002-delete-last-task-shows-empty-state-md
        - 001-full-task-lifecycle-md
removed:
    maxCount: 0
newTests:
    minCount: 1
reportedBugs:
    maxCount: 0
acceptsCandidate:
    - cmpx18cnw000c0nx04pmgcglp
---

This PR removed the three-dots menu, which will break any test that interacts
with anything inside it. This includes the deletion functionality, so any tests
that cover that should be marked as affected.

Also, it adds "rename" functionality, which should be covered by a new test.
