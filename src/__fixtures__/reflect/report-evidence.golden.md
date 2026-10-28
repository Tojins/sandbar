# Sandbar reflect: last 10 runs

- Runs read (2): `run-1`, `run-2`
- Runs skipped (1): `run-0` (unsupported event schema 4)
- Drivers: sandbar 0.50.0, sandbar 0.51.0
- Agents: not run (`--no-agents`)

## Clusters

Typed keys seen in two or more issues.

| key | issues | count |
| --- | --- | --- |
| `gate:gate-1:smoke` | 2 | 3 |
| `park:NEEDS-INFO:-` | 2 | 2 |
| `fail:implementer:FAILED` | 2 | 2 |

### `gate:gate-1:smoke`

- acme/app#7 attempt 1: `/srv/app/.sandbar/logs/run-1/issue-7/`
- acme/app#7 attempt 2: `/srv/app/.sandbar/logs/run-1/issue-7/`
- acme/app#9 attempt 1: `/srv/app/.sandbar/logs/run-2/issue-9/`

### `park:NEEDS-INFO:-`

- acme/app#8: `/srv/app/.sandbar/logs/run-1/issue-8/`
- acme/app#9: `/srv/app/.sandbar/logs/run-2/issue-9/`

### `fail:implementer:FAILED`

- acme/app#7 attempt 3: `/srv/app/.sandbar/logs/run-1/issue-7/implementer-3.log`
- acme/app#8 attempt 1: `/srv/app/.sandbar/logs/run-2/issue-8/implementer-1.log`

## Deletion candidates

Rules no tag hit, in groups whose lister ran on at least 20 issues.

| key | rule | lister issues |
| --- | --- | --- |
| `rule:quality:R6` | Non-atomic orchestration. | 31 |

## Outliers

Issues whose rounds exceed max(p90, 2 × median) over DONE issues, that declared a spec gap, or that parked NEEDS-INFO or NEEDS-PARTITION.

| issue | outcome | rounds | attempts | spec gaps | reason |
| --- | --- | --- | --- | --- | --- |
| acme/app#8 | NEEDS-INFO | 2 | 1 | - | Which \| format? SVG or PDF |
| acme/app#9 | DONE | 11 | 4 | 2 | - |
