import type {
  PullRequestChecksState,
  PullRequestMergeability,
  PullRequestReviewDecision,
  PullRequestState,
  ReviewPacketChangeSummary,
} from "@t3tools/contracts";

/** What the queue reads of a pull request. A list row carries all of it. */
export interface ReviewQueuePullRequest {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly headBranch: string;
  readonly baseBranch: string;
  /** Unknown heads never make a packet behind. */
  readonly headSha?: string | undefined;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly mergeability: PullRequestMergeability;
  readonly checksState?: PullRequestChecksState | undefined;
  readonly reviewDecision?: PullRequestReviewDecision | undefined;
}

export type ReviewQueuePacket = Pick<ReviewPacketChangeSummary, "head" | "verdict" | "comments">;

export type ReviewStandingKind =
  /** Comments written and not sent, or the agent answered and nothing waits on it. */
  | "your-move"
  /** A current, passing packet with no comment waiting on anyone. */
  | "ready"
  /** Comments sent and unanswered, or a push the packet does not cover yet. */
  | "with-agent"
  /** A current packet whose verdict is fail or blocked. */
  | "not-passing"
  | "no-packet"
  /** Closed or merged; out of the queue. */
  | "closed";

export interface ReviewStanding {
  readonly standing: ReviewStandingKind;
  /** Comments and follow-ups written and not sent. */
  readonly unsent: number;
  /** Sent and not answered yet. */
  readonly open: number;
  /** Answered by the agent and not resolved. */
  readonly answered: number;
  readonly resolved: number;
  /** The pull request's head moved past the packet's. */
  readonly behind: boolean;
  readonly verdict: ReviewPacketChangeSummary["verdict"] | null;
}

/** Where a change stands for its reviewer, from its pull request and its latest packet. */
export function reviewStanding(
  pullRequest: ReviewQueuePullRequest,
  packet: ReviewQueuePacket | null,
): ReviewStanding {
  const comments = packet?.comments;
  const facts = {
    unsent: comments?.unsent ?? 0,
    open: comments?.open ?? 0,
    answered: comments?.answered ?? 0,
    resolved: comments?.resolved ?? 0,
    behind:
      packet !== null &&
      pullRequest.headSha !== undefined &&
      pullRequest.headSha.toLowerCase() !== packet.head.toLowerCase(),
    verdict: packet?.verdict ?? null,
  };
  const standing: ReviewStandingKind =
    pullRequest.state !== "open"
      ? "closed"
      : packet === null
        ? "no-packet"
        : facts.unsent > 0 || (facts.answered > 0 && facts.open === 0)
          ? "your-move"
          : facts.open > 0 || facts.behind
            ? "with-agent"
            : facts.verdict === "pass"
              ? "ready"
              : "not-passing";
  return { standing, ...facts };
}

/** The host's own readiness, best first: what the Merge readiness sort ranks by without packets. */
function mergeReadinessTier(pullRequest: ReviewQueuePullRequest): number {
  if (pullRequest.mergeability === "conflicting") return 4;
  if (pullRequest.state !== "open") return 3;
  if (pullRequest.isDraft) return 2;
  if (pullRequest.checksState === "passing" && pullRequest.reviewDecision === "approved") return 0;
  if (pullRequest.checksState === "passing") return 1;
  return 2;
}

type PacketChange = Pick<
  ReviewPacketChangeSummary,
  "host" | "repository" | "branch" | "pullRequest"
>;

const changeKey = (host: string, repository: string, branch: string) =>
  `${host.toLowerCase()}\n${repository.toLowerCase()}\n${branch}`;

export type ReviewPacketIndex<Packet> = ReadonlyMap<string, Packet>;

/** One environment's stored changes by forge, repository and branch. A change with no known forge matches nothing. */
export function indexReviewPackets<Packet extends PacketChange>(
  changes: ReadonlyArray<Packet>,
): ReviewPacketIndex<Packet> {
  return new Map(
    changes.flatMap((change) =>
      change.host === null
        ? []
        : [[changeKey(change.host, change.repository, change.branch), change] as const],
    ),
  );
}

/** The packet stored for this pull request's branch, unless it names a different pull request. */
export function reviewPacketFor<Packet extends PacketChange>(
  index: ReviewPacketIndex<Packet> | undefined,
  pullRequest: Pick<ReviewQueuePullRequest, "host" | "repository" | "headBranch" | "number">,
): Packet | null {
  const packet = index?.get(
    changeKey(pullRequest.host, pullRequest.repository, pullRequest.headBranch),
  );
  return packet !== undefined &&
    (packet.pullRequest === null || packet.pullRequest === pullRequest.number)
    ? packet
    : null;
}

const STANDING_BUCKET = { "your-move": 0, ready: 1, "with-agent": 3, "not-passing": 4 } as const;
const PACKET_BUCKETS = new Set<number>(Object.values(STANDING_BUCKET));

/**
 * Lower goes first. Packet standings that need the reviewer lead; a pull request without a packet
 * that the host calls ready comes next, ahead of changes waiting on their agent; conflicting and
 * closed ones sink as the readiness tiers sink them.
 */
function queueBucket(pullRequest: ReviewQueuePullRequest, standing: ReviewStanding): number {
  const tier = mergeReadinessTier(pullRequest);
  if (tier === 4) return 7;
  if (tier === 3 || standing.standing === "closed") return 6;
  if (standing.standing === "no-packet") return tier < 2 ? 2 : 5;
  return STANDING_BUCKET[standing.standing];
}

/**
 * The review queue's order. Ready-to-review and packetless pull requests order by readiness tier
 * first, the other standings by `tieBreak` alone. Inside a packet standing a pull request follows
 * the listed one its base branch names, since it cannot go in before it.
 */
export function rankReviewQueue<Entry extends ReviewQueuePullRequest>(
  entries: ReadonlyArray<Entry>,
  standingOf: (entry: Entry) => ReviewStanding,
  tieBreak: (left: Entry, right: Entry) => number,
): ReadonlyArray<Entry> {
  const ranked = [...entries]
    .map((entry) => {
      const bucket = queueBucket(entry, standingOf(entry));
      return {
        entry,
        bucket,
        tier: bucket === 1 || bucket === 2 ? mergeReadinessTier(entry) : 0,
      };
    })
    .sort(
      (left, right) =>
        left.bucket - right.bucket || left.tier - right.tier || tieBreak(left.entry, right.entry),
    );
  const out: Entry[] = [];
  for (let start = 0; start < ranked.length;) {
    const bucket = ranked[start]!.bucket;
    let end = start;
    while (end < ranked.length && ranked[end]!.bucket === bucket) end += 1;
    const run = ranked.slice(start, end).map((item) => item.entry);
    out.push(...(PACKET_BUCKETS.has(bucket) ? baseFirst(run) : run));
    start = end;
  }
  return out;
}

function baseFirst<Entry extends ReviewQueuePullRequest>(run: ReadonlyArray<Entry>): Entry[] {
  const byHead = new Map(
    run.map((entry) => [changeKey(entry.host, entry.repository, entry.headBranch), entry] as const),
  );
  const out: Entry[] = [];
  const placed = new Set<Entry>();
  const place = (entry: Entry, path: Set<Entry>) => {
    if (placed.has(entry) || path.has(entry)) return;
    path.add(entry);
    const base = byHead.get(changeKey(entry.host, entry.repository, entry.baseBranch));
    if (base !== undefined) place(base, path);
    placed.add(entry);
    out.push(entry);
  };
  for (const entry of run) place(entry, new Set());
  return out;
}

/** What the Merge readiness sort reads of a listed pull request beyond the queue's own fields. */
export interface ReviewQueueListEntry extends ReviewQueuePullRequest {
  readonly additions: number;
  readonly deletions: number;
  readonly updatedAt: string;
}

const sortableTime = (iso: string) => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

/** Most recently updated first; unparseable times last. */
export function compareByRecency(left: ReviewQueueListEntry, right: ReviewQueueListEntry): number {
  const leftUpdated = sortableTime(left.updatedAt);
  const rightUpdated = sortableTime(right.updatedAt);
  const measured = Number(leftUpdated === null) - Number(rightUpdated === null);
  if (measured !== 0) return measured;
  if (leftUpdated === null || rightUpdated === null) return 0;
  return rightUpdated - leftUpdated;
}

export const hasLineCounts = (entry: ReviewQueueListEntry) => entry.additions + entry.deletions > 0;

/** Measured sizes first, smaller first, then the most recently updated. */
const smallestMeasuredFirst =
  <Entry extends ReviewQueueListEntry>(hasMeasuredSize: (entry: Entry) => boolean) =>
  (left: Entry, right: Entry) => {
    const measured = Number(hasMeasuredSize(right)) - Number(hasMeasuredSize(left));
    const sized = left.additions + left.deletions - (right.additions + right.deletions);
    return measured || sized || compareByRecency(left, right);
  };

/**
 * The Merge readiness order: the host's readiness tiers until some listed pull request has a
 * packet, then the review queue. The pull request list and `read_review_queue` both sort with it.
 */
export function rankByMergeReadiness<Entry extends ReviewQueueListEntry>(
  entries: ReadonlyArray<Entry>,
  packetOf: (entry: Entry) => ReviewQueuePacket | null,
  hasMeasuredSize: (entry: Entry) => boolean = hasLineCounts,
): ReadonlyArray<Entry> {
  const tieBreak = smallestMeasuredFirst(hasMeasuredSize);
  if (!entries.some((entry) => packetOf(entry) !== null)) {
    return [...entries].sort(
      (left, right) =>
        mergeReadinessTier(left) - mergeReadinessTier(right) || tieBreak(left, right),
    );
  }
  return rankReviewQueue(entries, (entry) => reviewStanding(entry, packetOf(entry)), tieBreak);
}

/** Client-side only: the host knows nothing of review packets. */
export type ReviewQueueFilter = "needs-me";

const internedStandings = new Map<string, ReviewStanding>();

/**
 * What a list row says about its packet: nothing without one or once closed. Equal standings are
 * one object, so memoized rows skip re-rendering when the review signal changes another row.
 */
export function reviewRowStanding(
  pullRequest: ReviewQueuePullRequest,
  packet: ReviewQueuePacket | null,
): ReviewStanding | undefined {
  if (packet === null) return undefined;
  const standing = reviewStanding(pullRequest, packet);
  if (standing.standing === "closed") return undefined;
  const key = JSON.stringify(standing);
  const held = internedStandings.get(key);
  if (held !== undefined) return held;
  internedStandings.set(key, standing);
  return standing;
}

/** "Needs me" keeps the changes waiting on the reviewer: their move, or ready to review. */
export function matchesReviewQueueFilter(
  standing: ReviewStanding | undefined,
  filter: ReviewQueueFilter | undefined,
): boolean {
  return (
    filter === undefined || standing?.standing === "your-move" || standing?.standing === "ready"
  );
}
