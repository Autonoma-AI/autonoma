-- Backfill branch.deployment_id from the most recent snapshot per branch
-- whose deployment is actually owned by that branch. The branch.branch_id =
-- snapshot.branch_id filter avoids violating the UNIQUE constraint on
-- branch.deployment_id (legacy branches.service.createBranch copied main's
-- deploymentId into PR snapshots, so propagating those cross-branch pointers
-- to the branch level would collide with main's entry).
UPDATE branch b
SET deployment_id = sub.deployment_id
FROM (
  SELECT DISTINCT ON (bs.branch_id) bs.branch_id, bs.deployment_id
  FROM branch_snapshot bs
  JOIN branch_deployment bd ON bd.id = bs.deployment_id
  WHERE bs.deployment_id IS NOT NULL
    AND bd.branch_id = bs.branch_id
  ORDER BY bs.branch_id, bs.created_at DESC
) sub
WHERE sub.branch_id = b.id;
