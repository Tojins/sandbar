## Previous gate-1 failure (last 200 lines)

```
{{trace}}
```

Fix the failures. Gate-1 stands the project's gate stack up and runs its steps
in order against your commits, stopping at the first red one. The step's name is
in the trace above; a failure that names a container rather than a step means
that container did not come up, and its log tail is included.
