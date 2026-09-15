import { describe, expect, it } from "vitest";

import { classifyPushError } from "./push-result.js";

describe("classifyPushError", () => {
  it.each(["non-fast-forward", "fetch first", "stale info"])(
    "classifies a client-side %s rejection as a race",
    (reason) => {
      expect(classifyPushError({
        stderr: ` ! [rejected]        HEAD -> main (${reason})\nerror: failed to push some refs`,
      })).toEqual({ kind: "race" });
    },
  );

  it("keeps remote-ref refusal lines verbatim and does not call them a race", () => {
    const chunk =
      "! [remote rejected] HEAD -> sandbar/chunk-11-c (refusing to allow a Personal Access Token to create or update workflow `.github/workflows/deploy.yml` without `workflow` scope)";
    const member =
      "! [remote rejected] sandbar/issue-11-c -> sandbar/member-11 (refusing to allow a Personal Access Token to create or update workflow `.github/workflows/deploy.yml` without `workflow` scope)";

    expect(classifyPushError({
      stderr: `remote: refusing update\n ${chunk}\n ${member}\nerror: failed to push some refs`,
    })).toEqual({ kind: "refused", reasons: [chunk, member] });
  });

  it("classifies a remote hook refusal as refused", () => {
    expect(classifyPushError({
      stderr:
        " ! [remote rejected] HEAD -> topic (pre-receive hook declined)\nerror: failed to push some refs",
    })).toEqual({
      kind: "refused",
      reasons: [
        "! [remote rejected] HEAD -> topic (pre-receive hook declined)",
      ],
    });
  });

  it("leaves failures without ref-status lines fatal", () => {
    expect(classifyPushError({ stderr: "ssh: connect to host: timed out" }))
      .toEqual({ kind: "fatal", reason: "ssh: connect to host: timed out" });
  });
});
