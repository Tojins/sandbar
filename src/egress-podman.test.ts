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
//
// The authenticated listener (#257) gets the same treatment: a sibling given
// the handle's env through an env file reaches a `secretAllow` host by
// `CONNECT`, while the agent beside it is refused that host by DNS, by SNI,
// and by `CONNECT` without the secret.

import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, it } from "vitest";

import { resolveGateStack } from "./config.js";
import {
  EGRESS_BASE_IMAGE,
  type EgressHandle,
  currentEgressImageTag,
  egressReport,
  ensureEgressImage,
  ownerEgress,
  startEgress,
} from "./egress.js";
import type { EventInput } from "./events.js";
import { type Stack, startStack } from "./gate-stack.js";
import {
  type EgressPolicy,
  PROXY_CONNECT_PORT,
  internalNetworkCreateArgs,
  proxyIpInspectArgs,
} from "./egress-policy.js";
import type { ImageBuildRecord } from "./ensure-images.js";
import {
  egressProxyNameFor,
  networkNameFor,
  podNameFor,
  sandboxNetworkNameFor,
  stackContainerNameFor,
} from "./naming.js";
import { podmanTestsEnabled } from "./podman-test-availability.test-util.js";
import {
  podmanTestScope,
  podmanTestStackId,
  runFixtureContainer,
} from "./podman-test-scope.test-util.js";
import { podmanExecOutput } from "./podman-exec.test-util.js";
import { RUNTIME, withRuntimeEnv } from "./runtime.js";

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
import { get as httpGet, request as httpRequest } from "node:http";
import { get as httpsGet } from "node:https";
import { connect } from "node:net";
import { connect as tlsConnect } from "node:tls";
const [probe, target, port, servername] = process.argv.slice(2);
const fail = (err) => { console.log(\`ERROR \${err.code ?? err.message}\`); process.exit(0); };
const body = (res) => { let s = ""; res.on("data", (c) => s += c); res.on("end", () => console.log(\`\${res.statusCode} \${s}\`)); };
const ca = readFileSync("/fixture/cert.pem");
if (probe === "get") (target.startsWith("https:") ? httpsGet(target, { ca, timeout: 10000 }, body) : httpGet(target, { timeout: 10000 }, body)).on("error", fail);
if (probe === "resolve") lookup(target).then((a) => console.log(a.address), fail);
if (probe === "connect") connect({ host: target, port: Number(port), timeout: 5000 })
  .on("connect", () => { console.log("connected"); process.exit(0); }).on("error", fail).on("timeout", () => fail({ code: "TIMEOUT" }));
if (probe === "tls") tlsConnect({ host: target, port: Number(port), servername, rejectUnauthorized: false, timeout: 10000 })
  .on("secureConnect", () => { console.log("secure"); process.exit(0); }).on("error", fail).on("close", () => fail({ code: "CLOSED" }));
// GET an https URL through a CONNECT to the proxy URL in \`port\`, or "env" for HTTPS_PROXY.
if (probe === "tunnel") {
  const proxy = new URL(port === "env" ? process.env.HTTPS_PROXY : port);
  const dest = new URL(target);
  const headers = proxy.username === "" ? {} : {
    "Proxy-Authorization": \`Basic \${Buffer.from(\`\${proxy.username}:\${proxy.password}\`).toString("base64")}\`,
  };
  httpRequest({ host: proxy.hostname, port: proxy.port, method: "CONNECT", path: \`\${dest.hostname}:443\`, headers, timeout: 10000 })
    .on("connect", (res, socket) => {
      if (res.statusCode !== 200) { console.log(\`PROXY \${res.statusCode}\`); process.exit(0); }
      httpsGet(target, { ca, headers: { Host: dest.hostname, Connection: "close" }, createConnection: () => tlsConnect({ socket, servername: dest.hostname, ca }) }, body).on("error", fail);
    }).on("error", fail).end();
}
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
    "-addext", "subjectAltName=DNS:allowed.test,DNS:blocked.test,DNS:internal.test,DNS:secret.test",
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
  secretEntries: [],
};

const WITH_SECRET: EgressPolicy = {
  ...ENFORCE,
  secretEntries: [{ host: "secret.test", ports: [443], private: true }],
};

// The fixture names, mapped to the upstream in a running proxy's /etc/hosts.
const mapFixtureHosts = async (proxyName: string): Promise<void> => {
  const hosts = ["allowed.test", "blocked.test", "internal.test", "secret.test"]
    .map((name) => `${upstreamIp} ${name}`).join("\n");
  await exec(RUNTIME, ["exec", proxyName, "sh", "-c", `echo '${hosts}' >> /etc/hosts`]);
};

// A proxy on its own internal network, its /etc/hosts mapping the fixture
// names to the upstream.
async function proxyFor(
  token: string,
  policy: EgressPolicy,
  authenticated = false,
): Promise<EgressHandle> {
  const handle = await startEgress({
    scope: SCOPE,
    owner: `sbx-${token}`,
    networkName: sandboxNetworkNameFor(SCOPE, token),
    createNetwork: true,
    authenticated,
    image,
    policy,
    logDir: join(fixtureDir, "egress"),
  });
  await mapFixtureHosts(egressProxyNameFor(SCOPE, `sbx-${token}`));
  return handle;
}

// A one-container gate stack (#223) over the fixture directory, whose one step
// probes through the stack's proxy and then fails, so the run is red.
const gateStackBehind = (
  stackId: string,
  events: EventInput[],
  standalone: { readonly reuseToken?: string; readonly keepAlive?: boolean } = {},
): Promise<Stack> => startStack({
  stackId,
  scope: SCOPE,
  worktreePath: fixtureDir,
  hideWorktreeGit: false,
  allowDirtyWorktree: true,
  spec: resolveGateStack({
    containers: [{
      name: "app", image: EGRESS_BASE_IMAGE, lifecycle: "issue", hold: true, mountWorktree: "/fixture",
    }],
    steps: [{
      name: "probe",
      in: "app",
      command: ["sh", "-c", "node /fixture/client.mjs resolve blocked.test; exit 1"],
    }],
  }),
  egress: ownerEgress(
    { scope: SCOPE, image, policy: ENFORCE, logDir: join(fixtureDir, "egress") },
    egressReport((event) => {
      events.push(event);
    }, { stack: "gate" }),
  ),
  ...standalone,
});

const podDns = async (pod: string): Promise<string> =>
  (await exec(RUNTIME, ["pod", "inspect", "--format", "{{json .InfraConfig.DNSServer}}", pod])).stdout.trim();

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
    "puts a gate stack behind its own proxy, names a red run's refusals and tears down all three",
    async ({ expect, task }) => {
      const stackId = podmanTestStackId("egress-gate", task.id);
      const events: EventInput[] = [];
      const stack = await gateStackBehind(stackId, events);
      const proxyName = egressProxyNameFor(SCOPE, stackId);
      await mapFixtureHosts(proxyName);
      const proxyIp = (await exec(RUNTIME, proxyIpInspectArgs(proxyName, networkNameFor(SCOPE, stackId)))).stdout.trim();
      expect(await podDns(podNameFor(SCOPE, stackId))).toBe(JSON.stringify([proxyIp]));
      const app = stackContainerNameFor(SCOPE, stackId, "app");
      expect(await probe(app, "get", "https://allowed.test/")).toBe("200 upstream https allowed.test");
      expect(await probe(app, "connect", "1.1.1.1", "443")).toMatch(/^ERROR (ENETUNREACH|EHOSTUNREACH)$/);

      const red = await stack.runGate();
      expect(red.ok).toBe(false);
      expect(red.containerLogs).toMatch(/^\negress refused during this run: blocked\.test\n/);
      // A refusal an earlier run sighted first is still named in this one's trace.
      expect((await stack.runGate()).containerLogs).toMatch(/^\negress refused during this run: blocked\.test\n/);
      expect(events.filter((e) => e.kind === "egress-refused")).toEqual([
        { kind: "egress-refused", stack: "gate", host: "blocked.test", port: null, via: "dns", enforced: true },
      ]);

      await stack.stop();
      expect(events.at(-1)).toMatchObject({
        kind: "egress", stack: "gate", mode: "enforce", allowed: { "allowed.test:443": 1 },
      });
      expect(await exists("container", proxyName)).toBe(false);
      expect(await exists("network", networkNameFor(SCOPE, stackId))).toBe(false);
    },
    300_000,
  );

  it.concurrent(
    "gives a kept stack's adopted pod a proxy at the address its resolv.conf names",
    async ({ expect, task }) => {
      const stackId = podmanTestStackId("egress-keep", task.id);
      const events: EventInput[] = [];
      const standalone = { reuseToken: `token-${stackId}`, keepAlive: true };
      const first = await gateStackBehind(stackId, events, standalone);
      const pod = podNameFor(SCOPE, stackId);
      const resolver = await podDns(pod);
      await first.stop();
      expect(await exists("container", egressProxyNameFor(SCOPE, stackId))).toBe(true);

      const second = await gateStackBehind(stackId, events, standalone);
      expect(second.reused).toEqual(["app"]);
      const proxyName = egressProxyNameFor(SCOPE, stackId);
      const proxyIp = (await exec(RUNTIME, proxyIpInspectArgs(proxyName, networkNameFor(SCOPE, stackId)))).stdout.trim();
      expect(JSON.stringify([proxyIp])).toBe(resolver);
      await mapFixtureHosts(proxyName);
      expect(await probe(stackContainerNameFor(SCOPE, stackId, "app"), "get", "https://allowed.test/"))
        .toBe("200 upstream https allowed.test");

      await exec(RUNTIME, ["pod", "rm", "-f", "-t", "0", pod]);
      await exec(RUNTIME, ["network", "rm", "-f", networkNameFor(SCOPE, stackId)]);
    },
    300_000,
  );

  it.concurrent("names the image the reconciler keeps live", async ({ expect }) => {
    expect(await currentEgressImageTag(SCOPE)).toBe(await ensureEgressImage(SCOPE));
  });

  it.concurrent(
    "reports a dead proxy, and stop is idempotent",
    async ({ expect, task }) => {
      const token = podmanTestStackId("egress-alive", task.id);
      const proxy = await proxyFor(token, ENFORCE);
      await expect(proxy.assertAlive()).resolves.toBeUndefined();
      await exec(RUNTIME, ["rm", "-f", "-t", "0", egressProxyNameFor(SCOPE, `sbx-${token}`)]);
      await expect(proxy.assertAlive()).rejects.toThrow(/died \(gone\)/);
      const first = proxy.stop();
      const second = proxy.stop();
      expect(second).toBe(first);
      expect(await first).toBe(await second);
      expect(await exists("network", sandboxNetworkNameFor(SCOPE, token))).toBe(false);
    },
    300_000,
  );

  it.concurrent(
    "leaves a network it did not create in place",
    async ({ expect, task }) => {
      const token = podmanTestStackId("egress-own-net", task.id);
      const network = sandboxNetworkNameFor(SCOPE, token);
      await exec(RUNTIME, internalNetworkCreateArgs(network));
      const proxy = await startEgress({
        scope: SCOPE,
        owner: `sbx-${token}`,
        networkName: network,
        createNetwork: false,
        authenticated: false,
        image,
        policy: ENFORCE,
        logDir: join(fixtureDir, "egress"),
      });
      await proxy.stop();
      expect(await exists("container", egressProxyNameFor(SCOPE, `sbx-${token}`))).toBe(false);
      expect(await exists("network", network)).toBe(true);
      await exec(RUNTIME, ["network", "rm", "-f", network]);
    },
    300_000,
  );

  it.concurrent(
    "lets only a secretEnv sibling reach a secretAllow host, through an authenticated CONNECT",
    async ({ expect, task }) => {
      const token = podmanTestStackId("egress-secret", task.id);
      const proxy = await proxyFor(token, WITH_SECRET, true);
      const connect = proxy.connect!;
      const policyPath = join(fixtureDir, "egress", `sbx-${token}.policy.json`);
      expect((await stat(policyPath)).mode & 0o777).toBe(0o600);
      const agent = stackContainerNameFor(SCOPE, token, "agent");
      const sibling = stackContainerNameFor(SCOPE, token, "sibling");
      await runFixtureContainer([
        "--name", agent, "--userns=keep-id", "--user", "1000:1000",
        "--network", sandboxNetworkNameFor(SCOPE, token), ...proxy.dnsArgs,
        "-v", `${fixtureDir}:/fixture:ro,z`,
        "--entrypoint", "sleep", EGRESS_BASE_IMAGE, "infinity",
      ]);
      await withRuntimeEnv({
        argv: [
          "run", "-d", "--image-volume=ignore", "--name", sibling, "--network", `container:${agent}`,
          "-v", `${fixtureDir}:/fixture:ro,z`,
          "--entrypoint", "sleep", EGRESS_BASE_IMAGE, "infinity",
        ],
        env: connect.env,
      }, (argv) => exec(RUNTIME, argv));
      const tunnel = async (client: string, url: string, via: string): Promise<string> =>
        (await podmanExecOutput(client, ["node", "/fixture/client.mjs", "tunnel", url, via])).trim();
      const listener = `${proxy.ip}:${PROXY_CONNECT_PORT}`;

      expect(await tunnel(sibling, "https://secret.test/", "env")).toBe("200 upstream https secret.test");
      expect(await tunnel(sibling, "https://allowed.test/", "env")).toBe("PROXY 403");
      expect(await tunnel(agent, "https://secret.test/", `http://sandbar:wrong@${listener}`)).toBe("PROXY 407");
      expect(await tunnel(agent, "https://secret.test/", `http://${listener}`)).toBe("PROXY 407");
      expect(await probe(agent, "get", "https://secret.test/")).toBe("ERROR ENOTFOUND");
      expect(await probe(agent, "tls", proxy.ip, "443", "secret.test")).toMatch(/^ERROR /);

      expect((await proxy.drain()).firstRefusals).toEqual(expect.arrayContaining([
        { host: "secret.test", port: null, via: "dns", enforced: true },
        { host: "secret.test", port: 443, via: "tls", enforced: true },
        { host: "allowed.test", port: 443, via: "connect", enforced: true },
        { host: "secret.test", port: 443, via: "connect", enforced: true },
      ]));

      await exec(RUNTIME, ["rm", "-f", "-t", "0", sibling, agent]);
      const summary = await proxy.stop();
      expect(summary.allowed["secret.test:443"]).toBe(1);
      expect(summary.refused["secret.test:443"]).toBe(3);
      await expect(stat(policyPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
    300_000,
  );

  // Starts an authenticated proxy under `policy`, an agent, and a sibling holding the handle's env.
  const withSecretSibling = async (name: string, taskId: string, policy: EgressPolicy) => {
    const token = podmanTestStackId(name, taskId);
    const proxy = await proxyFor(token, policy, true);
    const agent = stackContainerNameFor(SCOPE, token, "agent");
    const sibling = stackContainerNameFor(SCOPE, token, "sibling");
    await runFixtureContainer([
      "--name", agent, "--userns=keep-id", "--user", "1000:1000",
      "--network", sandboxNetworkNameFor(SCOPE, token), ...proxy.dnsArgs,
      "-v", `${fixtureDir}:/fixture:ro,z`,
      "--entrypoint", "sleep", EGRESS_BASE_IMAGE, "infinity",
    ]);
    await withRuntimeEnv({
      argv: [
        "run", "-d", "--image-volume=ignore", "--name", sibling, "--network", `container:${agent}`,
        "-v", `${fixtureDir}:/fixture:ro,z`,
        "--entrypoint", "sleep", EGRESS_BASE_IMAGE, "infinity",
      ],
      env: proxy.connect!.env,
    }, (argv) => exec(RUNTIME, argv));
    const tunnel = async (client: string, url: string, via: string): Promise<string> =>
      (await podmanExecOutput(client, ["node", "/fixture/client.mjs", "tunnel", url, via])).trim();
    return { proxy, agent, sibling, tunnel, listener: `${proxy.ip}:${PROXY_CONNECT_PORT}` };
  };

  it.concurrent(
    "enforces the authenticated listener in report mode while the transparent path only reports",
    async ({ expect, task }) => {
      const { proxy, agent, sibling, tunnel, listener } =
        await withSecretSibling("egress-secret-report", task.id, { ...WITH_SECRET, mode: "report" });

      expect(await tunnel(sibling, "https://secret.test/", "env")).toBe("200 upstream https secret.test");
      expect(await tunnel(sibling, "https://blocked.test/", "env")).toBe("PROXY 403");
      expect(await tunnel(agent, "https://secret.test/", `http://sandbar:wrong@${listener}`)).toBe("PROXY 407");
      expect(await probe(agent, "get", "https://secret.test/")).toBe("200 upstream https secret.test");

      expect((await proxy.drain()).firstRefusals).toEqual(expect.arrayContaining([
        { host: "blocked.test", port: 443, via: "connect", enforced: true },
        { host: "secret.test", port: 443, via: "connect", enforced: true },
        { host: "secret.test", port: null, via: "dns", enforced: false },
        { host: "secret.test", port: 443, via: "tls", enforced: false },
      ]));

      await exec(RUNTIME, ["rm", "-f", "-t", "0", sibling, agent]);
      await proxy.stop();
    },
    300_000,
  );

  it.concurrent(
    "refuses a CONNECT to a secretAllow host that resolves only to a private address",
    async ({ expect, task }) => {
      const { proxy, agent, sibling, tunnel } = await withSecretSibling(
        "egress-secret-private",
        task.id,
        { ...ENFORCE, secretEntries: [{ host: "secret.test", ports: [443], private: false }] },
      );

      expect(await tunnel(sibling, "https://secret.test/", "env")).toBe("PROXY 403");
      expect((await proxy.drain()).firstRefusals).toEqual(expect.arrayContaining([
        { host: "secret.test", port: 443, via: "connect", enforced: true },
      ]));

      await exec(RUNTIME, ["rm", "-f", "-t", "0", sibling, agent]);
      await proxy.stop();
    },
    300_000,
  );

  it.concurrent(
    "refuses a secretAllow host to an owner without the authenticated listener",
    async ({ expect, task }) => {
      const token = podmanTestStackId("egress-unauth", task.id);
      const proxy = await proxyFor(token, WITH_SECRET);
      expect(proxy.connect).toBeNull();
      const agent = stackContainerNameFor(SCOPE, token, "agent");
      await runFixtureContainer([
        "--name", agent, "--userns=keep-id", "--user", "1000:1000",
        "--network", sandboxNetworkNameFor(SCOPE, token), ...proxy.dnsArgs,
        "-v", `${fixtureDir}:/fixture:ro,z`,
        "--entrypoint", "sleep", EGRESS_BASE_IMAGE, "infinity",
      ]);

      expect(await probe(agent, "resolve", "secret.test")).toBe("ERROR ENOTFOUND");
      expect(await probe(agent, "tls", proxy.ip, "443", "secret.test")).toMatch(/^ERROR /);
      expect(await probe(agent, "connect", proxy.ip, String(PROXY_CONNECT_PORT))).toBe("ERROR ECONNREFUSED");
      expect((await proxy.drain()).firstRefusals).toEqual(expect.arrayContaining([
        { host: "secret.test", port: null, via: "dns", enforced: true },
        { host: "secret.test", port: 443, via: "tls", enforced: true },
      ]));

      await exec(RUNTIME, ["rm", "-f", "-t", "0", agent]);
      await proxy.stop();
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
