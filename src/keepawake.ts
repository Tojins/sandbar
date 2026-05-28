// WSL2 keepawake.
//
// Linux on its own does not need this — the host OS controls power. On WSL2
// the *Windows* host puts the machine to sleep, suspending WSL with it. We
// spawn a powershell.exe child that calls SetThreadExecutionState with
// ES_CONTINUOUS | ES_SYSTEM_REQUIRED for as long as it is alive. Killing
// the child clears the flag.

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";

function isWsl2(): boolean {
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

// PowerShell parses 0x80000001 as Int32 (= -2147483647), and
// SetThreadExecutionState's uint32 parameter rejects the negative value with a
// non-terminating MethodException — the script then sleeps forever without
// ever setting the flag. Use decimals so PowerShell widens to Int64 before the
// API call, and force terminating errors so any future signature mismatch is
// noisy.
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop';
$sig = '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);';
$api = Add-Type -MemberDefinition $sig -Name 'PSAPICall' -Namespace 'WinAPI' -PassThru;
$ES_CONTINUOUS = 2147483648;
$ES_SYSTEM_REQUIRED = 1;
[void]$api::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED);
while ($true) { Start-Sleep -Seconds 60 }
`;

let child: ChildProcess | null = null;

export function startKeepawake(): void {
  if (!isWsl2()) return;
  if (child) return;
  try {
    child = spawn("powershell.exe", ["-NoProfile", "-Command", PS_SCRIPT], {
      stdio: "ignore",
      detached: false,
    });
    child.on("error", () => {
      child = null;
    });
  } catch {
    child = null;
  }
}

export function stopKeepawake(): void {
  if (!child) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
  child = null;
}
