// File-fed run UI (#132).
//
// One dependency-free HTTP server serves the shipped vanilla page and the
// pure reducer's `/state.json`. A live run and `sandbar ui` use this same
// module. The server never holds scheduler state in memory: every request
// rereads the newest events.jsonl, so post-mortem and in-process views cannot
// disagree. An unreadable historical record is omitted; a request failure is
// an HTTP 500 and can never terminate the run being observed. Binding is
// exclusive and EADDRINUSE is a startup refusal.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EventRecordReadError, readEventsFile } from "./events.js";
import { SandbarError, isErrno } from "./errors.js";
import {
  finishedIssues,
  reduceRunEvents,
  type FinishedIssueState,
  type UiState,
} from "./run-state.js";

const UI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../ui/index.html");
const HISTORY_RUN_LIMIT = 10;

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (isErrno(err, "ESRCH")) return false;
    if (isErrno(err, "EPERM")) return true;
    throw err;
  }
}

async function recordedRunIsAlive(workdir: string, pid: number): Promise<boolean> {
  let recorded: string;
  try {
    recorded = await readFile(join(workdir, "run.pid"), "utf8");
  } catch (err) {
    if (isErrno(err, "ENOENT")) return false;
    throw err;
  }
  return Number(recorded.trim()) === pid && processIsAlive(pid);
}

export async function runDirectories(logsDir: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(logsDir, { withFileTypes: true });
  } catch (err) {
    if (isErrno(err, "ENOENT")) return [];
    throw err;
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("run-"))
    .map((entry) => join(logsDir, entry.name))
    .sort((a, b) => b.localeCompare(a));
}

export async function readUiState(
  logsDir: string,
  options: { readonly now?: Date; readonly liveRunDir?: string } = {},
): Promise<UiState> {
  const dirs = await runDirectories(logsDir);
  const newest = options.liveRunDir ?? dirs[0];
  if (!newest) throw new SandbarError(`No sandbar event runs found under ${logsDir}.`);
  const current = await readEventsFile(join(newest, "events.jsonl"));
  const start = current[0];
  if (!start || start.kind !== "run-start") {
    throw new Error(`Run ${newest} has no run-start event`);
  }
  const history: FinishedIssueState[] = [];
  const historyDirs = dirs
    .filter((dir) => resolve(dir) !== resolve(newest))
    .slice(0, HISTORY_RUN_LIMIT);
  for (const dir of historyDirs) {
    let events;
    try {
      events = await readEventsFile(join(dir, "events.jsonl"));
    } catch (err) {
      // Pre-schema runs have no event file; interrupted older runs can have an
      // incomplete or corrupt one. Both are unreadable history, not a fault in
      // the current run. Other filesystem faults still propagate to this
      // request's 500 response.
      if (isErrno(err, "ENOENT") || err instanceof EventRecordReadError) continue;
      throw err;
    }
    history.push(...finishedIssues(events));
  }
  const pidAlive = options.liveRunDir !== undefined
    ? resolve(options.liveRunDir) === resolve(newest)
    : await recordedRunIsAlive(start.workdir, start.pid);
  return reduceRunEvents(current, {
    now: options.now ?? new Date(),
    pidAlive,
    recentFinished: history,
  });
}

export type UiServer = {
  readonly url: string;
  close(): Promise<void>;
};

export class UiPortInUseError extends SandbarError {
  constructor(port: number, host: string, cause: unknown) {
    super(
      `Sandbar UI port ${port} is already in use on ${host}. ` +
        "Choose a different uiPort for this workdir.",
      { cause },
    );
    this.name = "UiPortInUseError";
  }
}

export type StartUiServerOptions = {
  readonly logsDir: string;
  readonly port: number;
  readonly host?: string;
  readonly liveRunDir?: string;
};

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close((err) => err ? reject(err) : resolveClose());
  });
}

export async function startUiServer(options: StartUiServerOptions): Promise<UiServer> {
  const html = await readFile(UI_PATH);
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET" }).end();
        return;
      }
      if (request.url === "/" || request.url === "/index.html") {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        }).end(html);
        return;
      }
      if (request.url === "/state.json") {
        const state = await readUiState(options.logsDir, {
          ...(options.liveRunDir === undefined ? {} : { liveRunDir: options.liveRunDir }),
        });
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        }).end(JSON.stringify(state));
        return;
      }
      response.writeHead(404).end("Not found\n");
    })().catch((err: unknown) => {
      // The browser is an observer. No malformed record, reducer bug, or other
      // request-scoped failure may become an unhandled server error that kills
      // the live run it is observing.
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" })
        .end(err instanceof Error ? err.message : String(err));
    });
  });
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolveListen, reject) => {
    const onError = (err: Error & { code?: string }): void => {
      server.off("listening", onListening);
      if (err.code === "EADDRINUSE") {
        reject(new UiPortInUseError(options.port, host, err));
      } else {
        reject(err);
      }
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, host);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://${host}:${address.port}/`,
    close: () => closeServer(server),
  };
}
