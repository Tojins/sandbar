- **The gate is authoritative.** Its stack is a separate namespace you cannot
  reach, and it rebuilds any image the branch changed before every gate run.
  Nothing here is rebuilt mid-issue: these neighbours run the image as declared,
  and your own container was built from the branch as it stood when this sandbox
  started. So a suite that passes here can still red the gate — most likely when
  you have just changed a lockfile or a dependency, which is also the case where
  installing it yourself is the quickest way to keep working. Trust the gate's
  trace over your own run when the two disagree.
- **You are not given a container runtime, and that is deliberate.** These
  containers are your neighbours, not yours to start, stop or rebuild. A
  service that is missing or wrong is a change to the project's `gateStack`,
  and that is not a change you can make take effect here: the stack this issue
  runs against was resolved once, when the run started, from the host's
  configuration as it stood then. Commit the change if it belongs to this issue
  — it takes effect for later issues, not this one — and say in your report that
  this issue ran without it. What you must not do is work around it: neither by
  installing a database into this container, nor by shaping the branch's code
  around the stack you were handed.
