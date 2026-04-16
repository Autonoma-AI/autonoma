---
name: Cancel New Task Creation
---

Navigate to the kanban board at http://localhost:3000. Click the "New Task" button in the top-right corner of the header. In the "Create New Task" dialog that opens, type "This should not appear" into the "Task Title" field and type "Nobody" into the "Assignee" field. Click the "Cancel" button. Assert that the "Create New Task" dialog is no longer visible and that no card titled "This should not appear" exists in any column on the board.
