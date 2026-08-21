## Your sandbox stack

The application's own services are running **beside you**, in this sandbox's
network namespace. They are the same containers the gate brings up, declared
once in the project's `gateStack` — so this is the application, not an
approximation of it. Reach them on `127.0.0.1`; there is no other host to name.

{{containers}}

Use them. Run the suite, hit the endpoint, watch the failure before you fix it
and watch it pass afterwards — a test you have never seen fail is not evidence.

Some things to know before you spend time on them:

- **The gate is authoritative.** Its stack is a separate namespace you cannot
  reach, and it rebuilds any image the branch changed while yours runs the image
  as declared. So a suite that passes here can still red the gate — most likely
  when you have just changed a lockfile or a dependency. Trust the gate's trace
  over your own run when the two disagree.
- **Nothing restarts a sibling.** A service that reads its configuration at boot
  keeps the configuration it booted with, however you edit the file. Mounted
  code that is read per request is fine; a config change is not, and there is no
  command here that will make it be.
- **This list is what came up when your sandbox was created**, not a live
  readout. A service that has died since — killed for memory, crashed on
  something you changed — still appears above as running. If one stops
  answering, its log says why, and nothing here will bring it back: work around
  it or say so in your next report rather than assuming the address is wrong.
- **These containers share your worktree.** Anything they write lands in the
  tree the gate is a verdict about, so a service writing outside gitignored
  paths shows up as uncommitted work and costs you attempts. If that happens,
  fix where it writes rather than deleting the files each time.
- **You are not given a container runtime, and that is deliberate.** These
  containers are your neighbours, not yours to start, stop or rebuild. If a
  service is missing or wrong, that is a change to the project's `gateStack`,
  which is ordinary code you can edit — not something to work around by
  installing a database into this container.
