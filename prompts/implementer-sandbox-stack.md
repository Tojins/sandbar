## Your sandbox stack

The application's own services are running **beside you**, in this sandbox's
network namespace. They are the same containers the gate brings up, declared
once in the project's `gateStack` — so this is the application, not an
approximation of it. Reach them on `127.0.0.1`; there is no other host to name.
Which port each one listens on is not something sandbar knows — the project's
own documentation and its `gateStack` entry are where that is written down.

{{containers}}

Use them. Run the suite, hit the endpoint, watch the failure before you fix it
and watch it pass afterwards — a test you have never seen fail is not evidence.

Some things to know before you spend time on them:

{{gateAccess}}

- **Nothing restarts a sibling.** A service that reads its configuration at boot
  keeps the configuration it booted with, however you edit the file. Mounted
  code that is read per request is fine; a config change is not, and there is no
  command here that will make it be.
- **This list is what came up when your sandbox was created**, not a live
  readout. A service that has died since — killed for memory, crashed on
  something you changed — still appears above as running. If one stops
  answering, its log says why, and nothing here will bring it back: work around
  it or say so in your next report rather than assuming you have the wrong
  address.
- **These containers share your worktree.** Anything they write lands in the
  tree the gate is a verdict about, so a service writing outside gitignored
  paths shows up as uncommitted work and costs you attempts. If that happens,
  fix where it writes rather than deleting the files each time.
- **The gate's `issue`-lifecycle containers outlive your attempts.** They are
  created once for the issue and reused by every gate run on this branch, so
  state an earlier attempt's code left inside one — an applied migration, a
  stamped fixture, a warm cache — is still there for the next attempt, and from
  here you can neither see it nor reset it. If a gate step reds because that
  state is stale, report it: the fix is the project resetting it in a step that
  runs every gate run, never the branch's own code edited until the stale state
  accepts it.
