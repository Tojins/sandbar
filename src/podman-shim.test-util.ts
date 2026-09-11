// A `podman` on PATH that records what the real one would have been handed.
//
// #154's instrument, shared because two suites need the identical reading and a
// second copy is where they would silently diverge: the variables a container
// gets no longer travel in the argv, so an argv assertion alone cannot tell a
// working invocation from one whose env never reached podman at all. The shim
// resolves `--env-file` exactly as podman does — parse the file NOW, while it
// still exists — and records podman's OWN environment for the two names a
// container variable is most likely to collide with, which is the assertion
// that the client was left configured as the driver configured it.
//
// The providers spawn the bare name `podman`, so a shim first on PATH sees
// exactly what the real binary would.
import { readFile, writeFile } from "node:fs/promises";

export type PodmanCall = {
  // The argv, which under #154 names no variable and carries no value.
  readonly args: string[];
  // What the CONTAINER would receive, read out of the env file.
  readonly containerEnv: Record<string, string>;
  // What PODMAN ITSELF was run with, for the names it reads for its own
  // configuration — `HOME` is a rootless client's storage root and
  // `CONTAINER_HOST` is the service URL.
  readonly clientEnv: {
    readonly HOME?: string;
    readonly CONTAINER_HOST?: string;
  };
};

// `respond` is appended verbatim: a suite that drives more than container
// creation has to answer the reads that follow it.
export async function writePodmanShim(opts: {
  readonly path: string;
  readonly logPath: string;
  readonly respond?: readonly string[];
}): Promise<void> {
  await writeFile(
    opts.path,
    [
      `#!${process.execPath}`,
      'const { appendFileSync, readFileSync } = require("node:fs");',
      "const args = process.argv.slice(2);",
      'const at = args.indexOf("--env-file");',
      "const containerEnv = {};",
      "if (at >= 0) {",
      '  for (const line of readFileSync(args[at + 1], "utf8").split("\\n")) {',
      '    if (line === "") continue;',
      '    const eq = line.indexOf("=");',
      "    containerEnv[line.slice(0, eq)] = line.slice(eq + 1);",
      "  }",
      "}",
      `appendFileSync(${JSON.stringify(opts.logPath)}, JSON.stringify({`,
      "  args,",
      "  containerEnv,",
      "  clientEnv: { HOME: process.env.HOME, CONTAINER_HOST: process.env.CONTAINER_HOST },",
      '}) + "\\n");',
      ...(opts.respond ?? []),
    ].join("\n"),
    { mode: 0o755 },
  );
}

export async function readPodmanCalls(
  logPath: string,
): Promise<PodmanCall[]> {
  return (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as PodmanCall);
}
