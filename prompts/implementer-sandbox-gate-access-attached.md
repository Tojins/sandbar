- **The gate is authoritative.** Its stack is separate from these sandbox
  neighbours and it rebuilds any image the branch changed before every gate run.
  The mounts and environment declared by every container a gate step runs in
  are also attached to your sandbox. When that derived set exposes a container
  runtime, use the image's installed client to run the runtime-backed tests
  yourself. It may also let you inspect the same user's gate resources; do not
  change them — only the gate's own result is a verdict. Nothing here is rebuilt
  mid-issue, so a suite that passes here can still red the gate after a lockfile,
  dependency or image-recipe change. Trust the gate's trace when they disagree.
- **The stack definition is fixed for this issue.** A missing or wrong sibling
  is a change to the project's `gateStack`, but the stack this issue runs against
  was resolved once when the run started. Commit that change if it belongs to
  this issue — it takes effect for later issues, not this one — and say in your
  report that this issue ran without it. Do not work around a bad sibling by
  installing a database into this container or shaping the branch around it.
