// File-fed run UI (#132).
//
// One dependency-free HTTP server serves the shipped vanilla page and the
// pure reducer's `/state.json`. The page fetches `state.json` relatively so
// this same asset works at `/` for a live run or `sandbar ui`, and behind
// Caddy's stripped `/<project>/` prefix for a deployed reader. The server
// never holds scheduler state in memory: every request
// rereads the newest events.jsonl, so post-mortem and in-process views cannot
// disagree. An unreadable historical record is omitted; a request failure is
// an HTTP 500 and can never terminate the run being observed — but it is not
// silent either: the page renders the failure, and `onFailure` hands the host
// each NEW failure message once (a live run records it as a complaint; the
// page polls every two seconds, so per-request would flood the record). That
// observer callback is best-effort and cannot reject into an HTTP or server
// event callback. The same seam takes a server error after listen, which would
// otherwise be an unhandled 'error' and the internal-failure halt the first
// sentence rules out. Binding is exclusive and EADDRINUSE is a startup refusal.
//
// Both production callers omit `host`: the production bind contract is
// loopback only, and the page deliberately has no authentication. A server
// exposes it through a same-box reverse proxy, never by moving this bind
// onto a public interface — and that proxy is itself on a private interface,
// since an unauthenticated projection of the record is an operator surface
// (#155; deploy/ansible/README.md owns the box's side). There, the
// standalone `sandbar ui` is the always-on reader: unlike run()'s in-process
// host, it survives a daemon crash and can render that crashed state (#138).

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
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
        "Choose a different port.",
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
  // Called once per distinct failure message, for a failed `/state.json`
  // request or a server error after listen. Best-effort: its rejection cannot
  // escape this observer boundary.
  readonly onFailure?: (err: unknown) => void | Promise<void>;
  // Dependency seam used to exercise post-listen server failures with a real
  // Server; production always uses node:http's createServer.
  readonly serverFactory?: (
    listener: (request: IncomingMessage, response: ServerResponse) => void,
  ) => Server;
};

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close((err) => err ? reject(err) : resolveClose());
  });
}

export async function startUiServer(options: StartUiServerOptions): Promise<UiServer> {
  const html = await readFile(UI_PATH);
  let lastFailure: string | null = null;
  const reportFailure = async (err: unknown): Promise<void> => {
    const message = err instanceof Error ? err.message : String(err);
    if (message === lastFailure) return;
    lastFailure = message;
    // Reporting an observer failure is itself best-effort. In particular, a
    // live run may be unable to append the complaint because events.jsonl is
    // the file whose read just failed; that must not become an unhandled
    // rejection which stops the scheduler.
    await Promise.allSettled([
      Promise.resolve().then(() => options.onFailure?.(err)),
    ]);
  };
  const server = (options.serverFactory ?? createServer)((request, response) => {
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
        lastFailure = null;
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        }).end(JSON.stringify(state));
        return;
      }
      response.writeHead(404).end("Not found\n");
    })().catch(async (err: unknown) => {
      // The browser is an observer. No malformed record, reducer bug, or other
      // request-scoped failure may become an unhandled server error that kills
      // the live run it is observing. The page shows the message; the host
      // hears it once through `onFailure`.
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" })
        .end(err instanceof Error ? err.message : String(err));
      await reportFailure(err);
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
      server.on("error", (err) => void reportFailure(err));
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
