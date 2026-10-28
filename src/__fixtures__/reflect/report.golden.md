# Sandbar reflect: last 10 runs

- Runs read (2): `run-2026-09-01T10-00-00-000Z`, `run-2026-09-02T08-30-00-000Z`
- Runs skipped (0): none
- Drivers: sandbar 0.49.12, sandbar 0.49.13
- Agents: not run (`--no-agents`)

## Clusters

Typed keys seen in two or more issues.

None.

## Deletion candidates

Rules no tag hit, in groups whose lister ran on at least 20 issues.

None.

## Outliers

Issues whose rounds exceed max(p90, 2 × median) over DONE issues, that declared a spec gap, or that parked NEEDS-INFO or NEEDS-PARTITION.

| issue | outcome | rounds | attempts | spec gaps | reason |
| --- | --- | --- | --- | --- | --- |
| acme/floorplan#43 | NEEDS-PARTITION | 0 | 0 | - | classifier partition-check 31000/600000: the store and its migration are two deliverables |
