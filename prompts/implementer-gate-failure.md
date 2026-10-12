## Previous gate-1 failure (last 200 lines)

```
{{trace}}
```

Fix the failures. Gate-1 stands the project's gate stack up and runs its steps
in order against the branch, stopping at the first red one. The step's name is
in the trace above; a failure that names a container rather than a step means
that container did not come up, and its log tail is included.

The gate ran on the head the quality pass left. A failing test the quality pass
added reports a correctness defect in the implementation: make that test pass,
do not delete or weaken it. Change or delete it only if it contradicts the
issue, and then name the test and the reason in that commit's message.
