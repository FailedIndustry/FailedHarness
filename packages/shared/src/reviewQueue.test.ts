import type { ReviewCommentCounts, ReviewPacketChangeSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  indexReviewPackets,
  rankReviewQueue,
  reviewPacketFor,
  reviewStanding,
  type ReviewQueuePacket,
  type ReviewQueuePullRequest,
} from "./reviewQueue.ts";

const HEAD = "a".repeat(40);
const PUSHED = "b".repeat(40);

const pullRequest = (
  overrides: Partial<ReviewQueuePullRequest> & { readonly number: number },
): ReviewQueuePullRequest => ({
  host: "github.com",
  repository: "Owner/Game",
  headBranch: `agent/change-${overrides.number}`,
  baseBranch: "main",
  headSha: HEAD,
  state: "open",
  isDraft: true,
  mergeability: "mergeable",
  ...overrides,
});

const counts = (overrides: Partial<ReviewCommentCounts> = {}): ReviewCommentCounts => ({
  pending: 0,
  open: 0,
  answered: 0,
  resolved: 0,
  unsent: 0,
  ...overrides,
});

const packet = (
  verdict: ReviewQueuePacket["verdict"] = "pass",
  comments: Partial<ReviewCommentCounts> = {},
): ReviewQueuePacket => ({ head: HEAD, verdict, comments: counts(comments) });

describe("where a change stands for its reviewer", () => {
  it.each([
    [
      "unsent comments, even while others wait on the agent",
      packet("pass", { unsent: 2, open: 1 }),
      {},
      "your-move",
    ],
    [
      "answers with nothing still waiting on the agent",
      packet("fail", { answered: 1 }),
      {},
      "your-move",
    ],
    [
      "answers while another comment waits on the agent",
      packet("pass", { answered: 1, open: 1 }),
      {},
      "with-agent",
    ],
    ["a sent, unanswered comment", packet("pass", { open: 1 }), {}, "with-agent"],
    ["a push the packet does not cover", packet("pass"), { headSha: PUSHED }, "with-agent"],
    ["a passing packet for an unknown head", packet("pass"), { headSha: undefined }, "ready"],
    ["a current passing packet", packet("pass"), {}, "ready"],
    ["every comment resolved", packet("pass", { resolved: 3 }), {}, "ready"],
    ["a failing packet", packet("fail"), {}, "not-passing"],
    ["a blocked packet", packet("blocked", { resolved: 1 }), {}, "not-passing"],
    ["no packet", null, {}, "no-packet"],
    [
      "a merged pull request",
      packet("pass", { unsent: 1 }),
      { state: "merged" as const },
      "closed",
    ],
  ] as const)("%s", (_case, stored, overrides, standing) => {
    expect(reviewStanding(pullRequest({ number: 1, ...overrides }), stored).standing).toBe(
      standing,
    );
  });

  it("says behind only against a different head, ignoring case", () => {
    const shouting = pullRequest({ number: 1, headSha: HEAD.toUpperCase() });
    expect(reviewStanding(shouting, packet()).behind).toBe(false);
  });
});

describe("the review queue's order", () => {
  const byNumber = (left: { number: number }, right: { number: number }) =>
    left.number - right.number;

  it("leads with the reviewer's move, then ready drafts above packetless work the host calls ready", () => {
    const rows = [
      pullRequest({ number: 1 }),
      pullRequest({ number: 2, isDraft: false, checksState: "passing" }),
      pullRequest({ number: 3 }),
      pullRequest({ number: 4 }),
      pullRequest({ number: 5 }),
      pullRequest({ number: 6, isDraft: false, checksState: "pending" }),
      pullRequest({ number: 7, mergeability: "conflicting" }),
      pullRequest({ number: 8, state: "closed" }),
      pullRequest({ number: 9 }),
    ];
    const packets = new Map<number, ReviewQueuePacket>([
      [1, packet("fail")],
      [3, packet("pass", { open: 1 })],
      [4, packet("pass")],
      [5, packet("pass", { answered: 1 })],
      [7, packet("pass", { unsent: 1 })],
      [8, packet("pass")],
    ]);
    const ranked = rankReviewQueue(
      rows,
      (row) => reviewStanding(row, packets.get(row.number) ?? null),
      byNumber,
    );
    expect(ranked.map((row) => row.number)).toEqual([5, 4, 2, 3, 1, 6, 9, 8, 7]);
  });

  it("orders ready changes by the host's readiness first", () => {
    const draft = pullRequest({ number: 1 });
    const approved = pullRequest({
      number: 2,
      isDraft: false,
      checksState: "passing",
      reviewDecision: "approved",
    });
    const ranked = rankReviewQueue(
      [draft, approved],
      (row) => reviewStanding(row, packet()),
      byNumber,
    );
    expect(ranked.map((row) => row.number)).toEqual([2, 1]);
  });

  it("puts the bottom of a stack before the changes above it within a standing", () => {
    const top = pullRequest({ number: 1, headBranch: "agent/top", baseBranch: "agent/middle" });
    const middle = pullRequest({ number: 2, headBranch: "agent/middle", baseBranch: "agent/base" });
    const base = pullRequest({ number: 3, headBranch: "agent/base" });
    const elsewhere = pullRequest({
      number: 4,
      repository: "owner/other",
      headBranch: "agent/top-other",
      baseBranch: "agent/base",
    });
    const ranked = rankReviewQueue(
      [top, middle, base, elsewhere],
      (row) => reviewStanding(row, packet()),
      byNumber,
    );
    expect(ranked.map((row) => row.number)).toEqual([3, 2, 1, 4]);
  });
});

describe("joining pull requests to stored packets", () => {
  const change = (overrides: Partial<ReviewPacketChangeSummary>): ReviewPacketChangeSummary => ({
    host: "github.com",
    repository: "owner/game",
    branch: "agent/change",
    pullRequest: null,
    head: HEAD,
    base: PUSHED,
    recordedAt: "2026-11-01T00:00:00.000Z",
    verdict: "pass",
    claims: { seen: 1, notSeen: 0, untested: 0 },
    blockers: 0,
    ...overrides,
  });

  it("matches host and repository in any case, and the branch exactly", () => {
    const index = indexReviewPackets([change({})]);
    const row = { host: "GitHub.com", repository: "Owner/Game", number: 1 };
    expect(reviewPacketFor(index, { ...row, headBranch: "agent/change" })).not.toBeNull();
    expect(reviewPacketFor(index, { ...row, headBranch: "Agent/Change" })).toBeNull();
    expect(
      reviewPacketFor(index, { ...row, repository: "owner/other", headBranch: "agent/change" }),
    ).toBeNull();
  });

  it("keeps a packet that names its pull request off a fork's pull request from the same branch", () => {
    const index = indexReviewPackets([change({ pullRequest: 7 })]);
    const fork = { host: "github.com", repository: "owner/game", headBranch: "agent/change" };
    expect(reviewPacketFor(index, { ...fork, number: 7 })).not.toBeNull();
    expect(reviewPacketFor(index, { ...fork, number: 8 })).toBeNull();
  });

  it("ignores packets for branches no listed pull request has, and packets with no known forge", () => {
    const index = indexReviewPackets([
      change({ branch: "agent/unlisted" }),
      change({ host: null, branch: "agent/change" }),
    ]);
    expect(
      reviewPacketFor(index, {
        host: "github.com",
        repository: "owner/game",
        headBranch: "agent/change",
        number: 1,
      }),
    ).toBeNull();
  });
});
