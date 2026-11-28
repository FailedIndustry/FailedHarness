import { ProjectId, type HarnessDescription } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  harnessViewerUrl,
  offersHarness,
  pickBranchCheckoutThread,
  playDisabledReason,
  playtestDisabledReason,
} from "./harnessPlay.logic";

const description = (overrides: Partial<HarnessDescription> = {}): HarnessDescription => ({
  declared: "tools/harness",
  approved: true,
  blocked: null,
  policyBy: null,
  cachePath: null,
  defaultCachePath: "/state/harness/cache/project",
  ...overrides,
});

describe("offersHarness", () => {
  it("offers play only for a checkout that declares a harness", () => {
    expect(offersHarness(null)).toBe(false);
    expect(offersHarness(description({ declared: null, blocked: "not-declared" }))).toBe(false);
    expect(offersHarness(description())).toBe(true);
    // Unapproved or blocked harnesses still show, disabled or asking.
    expect(offersHarness(description({ approved: false, blocked: "not-approved" }))).toBe(true);
    expect(offersHarness(description({ blocked: "policy", policyBy: "Acme" }))).toBe(true);
  });
});

describe("playDisabledReason", () => {
  it("lets an unapproved harness start, since starting asks for the approval", () => {
    expect(
      playDisabledReason({
        description: description({ approved: false, blocked: "not-approved" }),
        hasCheckout: true,
        canOperate: true,
      }),
    ).toBeNull();
  });

  it("waits for a thread on the branch before a pull request can be played", () => {
    expect(
      playDisabledReason({ description: description(), hasCheckout: false, canOperate: true }),
    ).toBe("Start a thread on this branch to play it.");
  });

  it("names the organization whose policy turns project commands off", () => {
    expect(
      playDisabledReason({
        description: description({ blocked: "policy", policyBy: "Acme" }),
        hasCheckout: true,
        canOperate: true,
      }),
    ).toBe("Acme's policy turns project commands off.");
  });

  it("explains a connection that may not operate", () => {
    expect(
      playDisabledReason({ description: description(), hasCheckout: true, canOperate: false }),
    ).toBe("This connection cannot start harness sessions.");
  });
});

describe("playtestDisabledReason", () => {
  it("needs the thread in Full access, where the agent's harness tools run", () => {
    const base = { description: description(), hasCheckout: true, canOperate: true };
    expect(playtestDisabledReason({ ...base, runtimeMode: "full-access" })).toBeNull();
    expect(playtestDisabledReason({ ...base, runtimeMode: "approval-required" })).toBe(
      "The agent can run the harness only from a thread in Full access. Switch it first.",
    );
  });
});

describe("harnessViewerUrl", () => {
  it("serves the stream from the environment's own origin", () => {
    expect(
      harnessViewerUrl("https://box.example.ts.net:3773/", "/api/harness/stream/s1/token/"),
    ).toBe("https://box.example.ts.net:3773/api/harness/stream/s1/token/");
  });

  it("keeps the path alone without a base URL", () => {
    expect(harnessViewerUrl(null, "/api/harness/stream/s1/token/")).toBe(
      "/api/harness/stream/s1/token/",
    );
  });

  it("keeps a base URL's path prefix, as through a relay", () => {
    expect(
      harnessViewerUrl("https://relay.example.com/env/abc123/", "/api/harness/stream/s1/token/"),
    ).toBe("https://relay.example.com/env/abc123/api/harness/stream/s1/token/");
    expect(
      harnessViewerUrl("https://relay.example.com/env/abc123", "/api/harness/stream/s1/token/"),
    ).toBe("https://relay.example.com/env/abc123/api/harness/stream/s1/token/");
  });
});

describe("pickBranchCheckoutThread", () => {
  const projectId = ProjectId.make("project:game");
  const thread = (
    id: string,
    overrides: Partial<{
      projectId: ProjectId;
      branch: string | null;
      worktreePath: string | null;
      archivedAt: string | null;
      updatedAt: string;
    }> = {},
  ) => ({
    id,
    projectId,
    branch: "feature/door",
    worktreePath: `/worktrees/${id}`,
    archivedAt: null,
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  });

  it("picks the newest live thread on the branch that has its own checkout", () => {
    const picked = pickBranchCheckoutThread(
      [
        thread("old"),
        thread("new", { updatedAt: "2026-11-02T00:00:00.000Z" }),
        thread("archived", { updatedAt: "2026-11-03T00:00:00.000Z", archivedAt: "x" }),
        thread("root", { updatedAt: "2026-11-03T00:00:00.000Z", worktreePath: null }),
        thread("other-branch", { updatedAt: "2026-11-03T00:00:00.000Z", branch: "main" }),
      ],
      { projectId, branch: "feature/door" },
    );
    expect(picked?.id).toBe("new");
  });

  it("finds nothing when no thread checks the branch out", () => {
    expect(pickBranchCheckoutThread([thread("a")], { projectId, branch: "main" })).toBeNull();
  });
});
