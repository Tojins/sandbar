// The egress proxy against real podman (#202), hermetic: the only upstream is
// a fixture container on podman's bridge, which the proxy reaches by names
// mapped in its own /etc/hosts. What is asserted is what podman makes of the
// topology — an internal network that routes nowhere, a DNS server that is the
// proxy, siblings and pod members that inherit both — and what the proxy then
// logs, read back through the handle's drain.
//
// The fixture's certificate comes from the host's `openssl`, which the gate
// image carries as a dependency of `ca-certificates`. A client verifies it, so
// an https answer proves the TLS bytes were spliced through unchanged.

import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, it } from "vitest";

import { EGRESS_BASE_IMAGE, type EgressHandle, ensureEgressImage, startEgress } from "./egress.js";
import { type EgressPolicy, proxyIpInspectArgs } from "./egress-policy.js";
import type { ImageBuildRecord } from "./ensure-images.js";
import {
  egressProxyNameFor,
  sandboxNetworkNameFor,
  stackContainerNameFor,
} from "./naming.js";
import { podmanTestsEnabled } from "./podman-test-availability.test-util.js";
import {
  podmanTestScope,
  podmanTestStackId,
  runFixtureContainer,
} from "./podman-test-scope.test-util.js";
import { RUNTIME } from "./runtime.js";

const exec = promisify(execFile);

const available = podmanTestsEnabled({
  what: "egress proxy podman tests",
  image: EGRESS_BASE_IMAGE,
});

const { scope: SCOPE, cleanup } = podmanTestScope("egress");

const UPSTREAM_JS = `
import { readFileSync } from "node:fs";
import { createServer as http } from "node:http";
import { createServer as https } from "node:https";
const reply = (scheme) => (req, res) => res.end(\`upstream \${scheme} \${req.headers.host}\`);
https({ key: readFileSync("/fixture/key.pem"), cert: readFileSync("/fixture/cert.pem") }, reply("https")).listen(443);
http(reply("http")).listen(80);
`;

// One probe per invocation; prints its outcome, or ERROR and the errno.
const CLIENT_JS = `
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { connect } from "node:net";
import { connect as tlsConnect } from "node:tls";
const [probe, target, port] = process.argv.slice(2);
const fail = (err) => { console.log(\`ERROR \${err.code ?? err.message}\`); process.exit(0); };
const body = (res) => { let s = ""; res.on("data", (c) => s += c); res.on("end", () => console.log(\`\${res.statusCode} \${s}\`)); };
const ca = readFileSync("/fixture/cert.pem");
if (probe === "get") (target.startsWith("https:") ? httpsGet(target, { ca, timeout: 10000 }, body) : httpGet(target, { timeout: 10000 }, body)).on("error", fail);
if (probe === "resolve") lookup(target).then((a) => console.log(a.address), fail);
if (probe === "connect") connect({ host: target, port: Number(port), timeout: 5000 })
  .on("connect", () => { console.log("connected"); process.exit(0); }).on("error", fail).on("timeout", () => fail({ code: "TIMEOUT" }));
if (probe === "tls") tlsConnect({ host: target, port: Number(port), rejectUnauthorized: false, timeout: 10000 })
  .on("secureConnect", () => { console.log("secure"); process.exit(0); }).on("error", fail).on("close", () => fail({ code: "CLOSED" }));
`;

let fixtureDir: string;
let image: string;
let upstreamIp: string;
const upstreamName = stackContainerNameFor(SCOPE, "egress", "upstream");

beforeAll(async () => {
  if (!available) return;
  fixtureDir = await mkdtemp(join(tmpdir(), "sandbar-egress-fixture-"));
  await exec("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
    "-nodes", "-days", "1", "-subj", "/CN=allowed.test",
    "-addext", "subjectAltName=DNS:allowed.test,DNS:blocked.test,DNS:internal.test",
    "-keyout", join(fixtureDir, "key.pem"), "-out", join(fixtureDir, "cert.pem"),
  ]);
  await chmod(join(fixtureDir, "key.pem"), 0o644);
  await writeFile(join(fixtureDir, "upstream.mjs"), UPSTREAM_JS);
  await writeFile(join(fixtureDir, "client.mjs"), CLIENT_JS);
  image = await ensureEgressImage(SCOPE);
  await runFixtureContainer([
    "--name", upstreamName, "--network", "podman",
    "-v", `${fixtureDir}:/fixture:ro,z`,
    EGRESS_BASE_IMAGE, "node", "/fixture/upstream.mjs",
  ]);
  upstreamIp = (await exec(RUNTIME, proxyIpInspectArgs(upstreamName, "podman"))).stdout.trim();
}, 600_000);

afterAll(async () => {
  if (!available) return;
  await cleanup();
  await rm(fixtureDir, { recursive: true, force: true });
}, 120_000);

const ENFORCE: EgressPolicy = {
  mode: "enforce",
  entries: [
    { host: "allowed.test", ports: [443, 80], private: true },
    // Allowed, but its only address is the fixture's private one.
    { host: "internal.test", ports: [443], private: false },
  ],
};

// A proxy on its own internal network, its /etc/hosts mapping the fixture
// names to the upstream.
async function proxyFor(token: string, policy: EgressPolicy): Promise<EgressHandle> {
  const handle = await startEgress({
    scope: SCOPE,
    owner: `sbx-${token}`,
    networkName: sandboxNetworkNameFor(SCOPE, token),
    createNetwork: true,
    image,
    policy,
    logDir: join(fixtureDir, "egress"),
  });
  const hosts = ["allowed.test", "blocked.test", "internal.test"]
    .map((name) => `${upstreamIp} ${name}`).join("\n");
  await exec(RUNTIME, [
    "exec", egressProxyNameFor(SCOPE, `sbx-${token}`), "sh", "-c", `echo '${hosts}' >> /etc/hosts`,
  ]);
  return handle;
}

const probe = async (container: string, ...args: string[]): Promise<string> =>
  (await exec(RUNTIME, ["exec", container, "node", "/fixture/client.mjs", ...args])).stdout.trim();

const exists = async (kind: "container" | "network", name: string): Promise<boolean> =>
  exec(RUNTIME, [kind, "exists", name]).then(() => true, (err: { code?: unknown }) => {
    if (err.code === 1) return false;
    throw err;
  });

describe.runIf(available)("egress proxy against real podman", () => {
  it.concurrent("reuses the proxy image while its inputs are unchanged", async ({ expect }) => {
    const records: ImageBuildRecord[] = [];
    expect(await ensureEgressImage(SCOPE, (record) => {
      records.push(record);
    })).toBe(image);
    expect(records).toEqual([
      expect.objectContaining({ tag: image, built: false, reason: "egress-current" }),
    ]);
  });

  it.concurrent(
    "lets an agent and its sibling reach only allowlisted hosts, and records every refusal",
    async ({ expect, task }) => {
      const token = podmanTestStackId("egress", task.id);
      const proxy = await proxyFor(token, ENFORCE);
      const agent = stackContainerNameFor(SCOPE, token, "agent");
      const sibling = stackContainerNameFor(SCOPE, token, "sibling");
      await runFixtureContainer([
        "--name", agent, "--userns=keep-id", "--user", "1000:1000",
        "--network", sandboxNetworkNameFor(SCOPE, token), ...proxy.dnsArgs,
        "-v", `${fixtureDir}:/fixture:ro,z`,
        "--entrypoint", "sleep", EGRESS_BASE_IMAGE, "infinity",
      ]);
      await runFixtureContainer([
        "--name", sibling, "--network", `container:${agent}`,
        "-v", `${fixtureDir}:/fixture:ro,z`,
        "--entrypoint", "sleep", EGRESS_BASE_IMAGE, "infinity",
      ]);

      for (const client of [agent, sibling]) {
        expect(await probe(client, "get", "https://allowed.test/")).toBe("200 upstream https allowed.test");
        expect(await probe(client, "get", "http://allowed.test/")).toBe("200 upstream http allowed.test");
        expect(await probe(client, "resolve", "blocked.test")).toBe("ERROR ENOTFOUND");
        expect(await probe(client, "connect", "1.1.1.1", "443")).toMatch(/^ERROR (ENETUNREACH|EHOSTUNREACH)$/);
      }
      expect(await probe(agent, "tls", proxy.ip, "443")).toMatch(/^ERROR /);
      expect(await probe(agent, "get", "https://internal.test/")).toMatch(/^ERROR /);

      const { firstRefusals } = await proxy.drain();
      expect(firstRefusals).toEqual(expect.arrayContaining([
        { host: "blocked.test", port: null, via: "dns", enforced: true },
        { host: null, port: 443, via: "opaque", enforced: true },
        { host: "internal.test", port: 443, via: "private", enforced: true },
      ]));

      await exec(RUNTIME, ["rm", "-f", "-t", "0", sibling, agent]);
      const summary = await proxy.stop();
      expect(summary.mode).toBe("enforce");
      expect(summary.allowed).toEqual({ "allowed.test:443": 2, "allowed.test:80": 2 });
      expect(summary.refused["blocked.test"]).toBeGreaterThanOrEqual(2);
      expect(summary.firstRefusals).toEqual([]);
      expect(await exists("container", egressProxyNameFor(SCOPE, `sbx-${token}`))).toBe(false);
      expect(await exists("network", sandboxNetworkNameFor(SCOPE, token))).toBe(false);
    },
    300_000,
  );

  it.concurrent(
    "holds for a pod created on the internal network with the proxy as its DNS",
    async ({ expect, task }) => {
      const token = podmanTestStackId("egress-pod", task.id);
      const proxy = await proxyFor(token, ENFORCE);
      const pod = stackContainerNameFor(SCOPE, token, "pod");
      const member = stackContainerNameFor(SCOPE, token, "member");
      await exec(RUNTIME, [
        "pod", "create", "--name", pod, "--network", sandboxNetworkNameFor(SCOPE, token),
        ...proxy.dnsArgs,
      ]);
      await runFixtureContainer([
        "--name", member, "--pod", pod, "-v", `${fixtureDir}:/fixture:ro,z`,
        "--entrypoint", "sleep", EGRESS_BASE_IMAGE, "infinity",
      ]);

      expect(await probe(member, "get", "https://allowed.test/")).toBe("200 upstream https allowed.test");
      expect(await probe(member, "get", "http://allowed.test/")).toBe("200 upstream http allowed.test");
      expect(await probe(member, "resolve", "blocked.test")).toBe("ERROR ENOTFOUND");
      expect(await probe(member, "connect", "1.1.1.1", "443")).toMatch(/^ERROR (ENETUNREACH|EHOSTUNREACH)$/);
      expect((await proxy.drain()).firstRefusals).toContainEqual(
        { host: "blocked.test", port: null, via: "dns", enforced: true },
      );

      await exec(RUNTIME, ["pod", "rm", "-f", "-t", "0", pod]);
      await proxy.stop();
      expect(await exists("network", sandboxNetworkNameFor(SCOPE, token))).toBe(false);
    },
    300_000,
  );

  it.concurrent(
    "forwards what the list would refuse in report mode, and records it as not enforced",
    async ({ expect, task }) => {
      const token = podmanTestStackId("egress-report", task.id);
      const proxy = await proxyFor(token, { ...ENFORCE, mode: "report" });
      const agent = stackContainerNameFor(SCOPE, token, "agent");
      await runFixtureContainer([
        "--name", agent, "--userns=keep-id", "--user", "1000:1000",
        "--network", sandboxNetworkNameFor(SCOPE, token), ...proxy.dnsArgs,
        "-v", `${fixtureDir}:/fixture:ro,z`,
        "--entrypoint", "sleep", EGRESS_BASE_IMAGE, "infinity",
      ]);

      expect(await probe(agent, "get", "https://blocked.test/")).toBe("200 upstream https blocked.test");
      expect(await probe(agent, "get", "http://blocked.test/")).toBe("200 upstream http blocked.test");
      expect((await proxy.drain()).firstRefusals).toEqual(expect.arrayContaining([
        { host: "blocked.test", port: null, via: "dns", enforced: false },
        { host: "blocked.test", port: 443, via: "tls", enforced: false },
        { host: "blocked.test", port: 80, via: "http", enforced: false },
      ]));

      await exec(RUNTIME, ["rm", "-f", "-t", "0", agent]);
      const summary = await proxy.stop();
      expect(summary.mode).toBe("report");
      expect(summary.allowed).toEqual({});
    },
    300_000,
  );
});
