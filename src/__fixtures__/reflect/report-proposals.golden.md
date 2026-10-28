# Sandbar reflect: last 10 runs

- Runs read (2): `run-1`, `run-2`
- Runs skipped (1): `run-0` (unsupported event schema 4)
- Drivers: sandbar 0.50.0, sandbar 0.51.0
- Agents: over `origin/main` at `0123456789abcdef0123456789abcdef01234567`
- Steps (2):
  - tagger quality 1/1: cache `aaaaaaaaaaaa` tokens=in:1200,out:80
  - synthesizer: cache `bbbbbbbbbbbb` tokens unmeasured

## Proposals: sandbar, deletion

### Drop R6

- Target: `sandbar/prompts/coding-standards.md`
- Evidence: `rule:quality:R6`

Body.

#### `rule:quality:R6`

- Non-atomic orchestration. No tag hit over 31 lister issues.

## Proposals: consumer, prose-edit

### Name the smoke fixture

- Target: `consumer/CLAUDE.md`
- Evidence: `tag:quality:R3`, `fail:implementer:FAILED`

Add the fixture name to the anchor.

#### `tag:quality:R3`

- acme/app#7: `/srv/app/.sandbar/logs/run-1/issue-7/quality-1.log`
- acme/app#8: `/srv/app/.sandbar/logs/run-2/issue-8/quality-2.log`

#### `fail:implementer:FAILED`

- acme/app#7 attempt 3: `/srv/app/.sandbar/logs/run-1/issue-7/implementer-3.log`
- acme/app#8 attempt 1: `/srv/app/.sandbar/logs/run-2/issue-8/implementer-1.log`

## Proposals: consumer, issue-writing

### State the format

- Target: `issue-writing`
- Evidence: `outlier:8`, `outlier:9`

Body.

#### `outlier:8`

- acme/app#8: NEEDS-INFO, 2 rounds

#### `outlier:9`

- acme/app#9: DONE, 11 rounds

## Clusters

Typed keys seen in two or more issues.

| key | issues | count |
| --- | --- | --- |
| `gate:gate-1:smoke` | 2 | 3 |
| `park:NEEDS-INFO:-` | 2 | 2 |
| `fail:implementer:FAILED` | 2 | 2 |
| `tag:quality:R3` | 2 | 2 |

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

### `tag:quality:R3`

- acme/app#7: `/srv/app/.sandbar/logs/run-1/issue-7/quality-1.log`
- acme/app#8: `/srv/app/.sandbar/logs/run-2/issue-8/quality-2.log`

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

## No action

- `park:NEEDS-INFO:-`: the issues were vague, not the prompts

## Not addressed

- `gate:gate-1:smoke`

## Dropped by the driver

- Name the smoke fixture: cites unknown key tag:quality:R9

## Step failures

- tagger correctness 1/1: wrote: HEAD moved
