// Per-PROCESS podman resource scope for the test files that shell out to a real
// podman (#47).
//
// The three podman-touching test files create host-global resources: pods,
// networks, containers and image tags. Podman's namespace is one per host, so
// two processes running the same file concurrently want the same names — and
// `startStack` FORCE-REMOVES a namesake before creating one, on the correct
// assumption that a survivor is a crashed run's debris (#28). One process
// therefore tears down the other's live stack mid-test.
//
// That was invisible only because nothing ran them concurrently: vitest's fork
// pool gives each FILE its own process, and no two files shared a scope. It
// stops being true the moment the gate runner gets a podman socket (#48) —
// three issues gate concurrently at the default plan size, each running the
// full suite, three processes inside one file.
//
// WHAT ACTUALLY COLLIDES. Once the scope is per-process every *scoped* name —
// pod, network, containers, `variantImageTag` refs — is disjoint by
// construction. `stackId` is deliberately NOT tokenised: it is what makes
// leftover debris readable, and the scope already separates it. What needs the
// token are the names the scope does not reach, which is exactly the fixture
// IMAGE TAGS the files write by hand. That is the worse half of the bug and a
// scope fix alone leaves it untouched: `ensure-images-podman.test.ts` does
// `rmi -f` on its fixture tag in `beforeEach` and rebuilds it inside the tests,
// so two concurrent processes destroy and rebuild each other's image
// mid-assertion with no pod involved. So `testImageTag` exists and is the only
// way to name one — a future fixture tag cannot be written without the token.
//
// WHY A UUID, NOT THE PID. A pid is unique only within a pid namespace, and
// #48 puts these tests inside containers: three gate runners, three namespaces,
// vitest forks all landing in the low tens. A naked pid would collide MORE
// reliably under the one future this exists to unblock. The only thing a pid
// buys is reproducibility, and the next paragraph shows that is worth nothing.
// A uuid also needs no plumbing from #48 — no env var, no launcher contract.
// This is the podman-native move rather than an invention: podman itself mints
// a unique name when you do not pass `--name`, and the token supplies that at
// the one layer where sandbar's contract requires the caller to choose.
//
// WHY A FACTORY, NOT A MODULE-LEVEL CONST. A `const SCOPE = ...` would draw its
// uniqueness from vitest's default per-file module isolation — a property of
// the runner's configuration, not of this design. Under `--no-isolate` both
// files would share one scope, at which point file A's cleanup removes file B's
// live containers: #28 rebuilt inside its own fix. A factory is unique per
// CALL, so pool, isolation and pid namespace all stop mattering. The `label` is
// a readability aid for debris; the uuid is what makes it sound.
//
// NOBODY REAPS A CRASHED TEST PROCESS'S DEBRIS AUTOMATICALLY, and that is
// stated rather than engineered around. Any process that can force-remove
// another process's scope is #28 reintroduced — including a vitest
// `globalSetup` sweep, which under #48 would run in three concurrent containers
// and tear down its siblings at startup. The only sound reapers are the process
// itself (`cleanup`, from one file-level `afterAll`) and a human. The trade is
// real and is a regression against a fixed scope, where the NEXT run reaped
// what the last one left: interrupting a vitest run is routine here (see
// CLAUDE.md's #25 note, which is entirely about killing these runs), and a
// SIGKILL or ctrl-C now leaks. Recovery is a human command, and note that
// nothing else will ever mention it — a per-process scope goes through
// `runScope`, so `isScopedResourceName` is true of the debris and
// `findUnattributableResources` deliberately stays silent about it (another
// run's scope may be live and is that run's to reap). With no sandbar and no
// test run in flight:
//
//   podman pod rm -f $(podman pod ls --filter name=^sandbar- -q)
//   podman rmi -f $(podman images --format '{{.Repository}}:{{.Tag}}' \
//     | grep '^localhost/sandbar-test-')
//
// The first is the coarse command `naming.ts` already documents, and it is
// coarse because a test scope is indistinguishable by name from a real run's.
// The second is targeted, which is why `testImageTag` puts `sandbar-test-` in
// the repository component rather than only the token in the tag.
//
// A SEPARATE PODMAN STORAGE GRAPH was considered and rejected on cost, not
// principle. Giving each process its own store (`CONTAINERS_STORAGE_CONF`, or
// `--root`/`--runroot`) makes the hardcoded names unable to collide at all and
// turns cleanup into deleting a directory, with no production change. It is
// rejected because a fresh store has no `mariadb:10.11`: either re-pull per
// process, or wire `additionalimagestores` read-only at the user's real store,
// which is a rough corner rootless. Every build would also run cold, and the
// tests would exercise a podman configuration nothing in production uses.
//
// `.test-util.ts` shares `*.test.ts`'s tsconfig exclusion, for the same reason:
// without it this compiles into `dist/` and ships as importable dead weight.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { cleanupOrphanContainers } from "./containers.js";
import { sweepBranchImages } from "./ensure-images.js";
import { type RunScope, runScope } from "./naming.js";
import { RUNTIME } from "./runtime.js";

const exec = promisify(execFile);

export type PodmanTestScope = {
  // This process's scope. Every pod, network, container and variant image tag
  // built from it is invisible to every other process.
  readonly scope: RunScope;
  // A second scope, distinct from `scope` and equally this process's own. It
  // exists so a test can prove the sweeps are BLIND to another workdir's
  // resources without borrowing a scope that might really be live.
  readonly otherScope: RunScope;
  // Mint a fixture image tag carrying the token. Recorded, so `cleanup` can
  // remove it — no sweep can, because an unscoped tag is not sandbar's to
  // recognise.
  readonly testImageTag: (name: string) => string;
  // Remove everything this process created. Failures are swallowed: this runs
  // in an `afterAll`, and a cleanup that throws replaces a leak with a red
  // suite while leaking anyway.
  readonly cleanup: () => Promise<void>;
};

export function podmanTestScope(label: string): PodmanTestScope {
  // The uuid is the whole guarantee; the label only makes debris readable.
  const token = `/sandbar-test/${label}/${randomUUID()}`;
  const scope = runScope(token);
  const otherScope = runScope(`${token}.sibling`);

  const tags: string[] = [];
  const testImageTag = (name: string): string => {
    // The scope in the tag component is what makes it per-process; the
    // `sandbar-test-` repository prefix is what makes a human's recovery
    // command able to name it. Both are load-bearing — see the header.
    const tag = `localhost/sandbar-test-${label}-${name}:${scope}`;
    tags.push(tag);
    return tag;
  };

  const cleanup = async (): Promise<void> => {
    // The two production sweepers, dogfooded: `cleanupOrphanContainers` takes
    // the pod (and with it the infra container a name sweep cannot see), every
    // container in the scope — its container kind has an empty infix, so
    // bare-`podman run` fixtures named through `stackContainerNameFor` go too —
    // and the network. `sweepBranchImages` takes the `variantImageTag` refs.
    // `otherScope` is swept as well: it is ours, so its variants are debris
    // rather than a sibling's live images.
    await cleanupOrphanContainers(scope).catch(() => {});
    for (const s of [scope, otherScope]) {
      await sweepBranchImages(s).catch(() => {});
    }
    // Neither sweeper reaches an unscoped fixture tag, so those are removed by
    // name from the record `testImageTag` kept.
    for (const tag of tags) {
      await exec(RUNTIME, ["rmi", "-f", tag]).catch(() => {});
    }
  };

  return { scope, otherScope, testImageTag, cleanup };
}
