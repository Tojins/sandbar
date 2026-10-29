[step: {{name}}] Gate step `{{command}}` exited {{exitCode}} on this head. It
is a mechanical check, not a reviewer's reading: gate-1 runs it again and goes
red while it still reports these lines (last {{tailLines}}):

```
{{output}}
```
