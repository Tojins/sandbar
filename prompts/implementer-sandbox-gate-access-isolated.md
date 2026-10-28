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
  service that is missing or wrong is a change to the project's gate stack,
  and that is not a change you can make take effect here: these neighbours
  were resolved once, when this sandbox started. Commit the change if it
  belongs to this issue — this sandbox does not pick it up — and say in your
  report that you worked without it. What you must not do is work around it:
  neither by installing a database into this container, nor by shaping the
  branch's code around the stack you were handed.
