import {
  isUnknownUnionMember,
  type PullRequestReviewPosition,
  type ReviewCommentAnchorInput,
  type ReviewCommentCounts,
  type ReviewCommentThread,
  type ReviewCommentThreadCandidate,
  type ReviewPacket,
  type ReviewRegion,
  type ThreadId,
} from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import { indexReviewComments } from "./state/reviewComments.ts";

export interface Fraction {
  readonly x: number;
  readonly y: number;
}

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** A drag shorter than this, in screen pixels, is a tap: it comments on the whole picture. */
export const REGION_TAP_PX = 6;
/** The smallest side a drawn region keeps, in screen pixels, so it stays visible and clickable. */
const REGION_MIN_PX = 12;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/** Where a pointer is on `box`, as fractions of its size, kept inside it. */
export function fractionInBox(clientX: number, clientY: number, box: Box): Fraction {
  return {
    x: box.width > 0 ? clamp((clientX - box.left) / box.width, 0, 1) : 0,
    y: box.height > 0 ? clamp((clientY - box.top) / box.height, 0, 1) : 0,
  };
}

function span(from: number, to: number, size: number, minPx: number) {
  const min = size > 0 ? Math.min(1, minPx / size) : 0;
  let start = Math.min(from, to);
  let length = Math.abs(to - from);
  if (length < min) {
    start -= (min - length) / 2;
    length = min;
  }
  start = clamp(start, 0, 1 - length);
  const roundedStart = round4(start);
  return { start: roundedStart, length: Math.min(round4(length), round4(1 - roundedStart)) };
}

/** The region a drag from `start` to `end` drew on a `box`-sized picture; null for a tap. */
export function regionFromDrag(
  start: Fraction,
  end: Fraction,
  box: Pick<Box, "width" | "height">,
): ReviewRegion | null {
  // A picture not laid out yet has no size to draw on; the comment is on all of it.
  if (box.width <= 0 || box.height <= 0) return null;
  const dx = Math.abs(end.x - start.x) * box.width;
  const dy = Math.abs(end.y - start.y) * box.height;
  if (Math.max(dx, dy) < REGION_TAP_PX) return null;
  const x = span(start.x, end.x, box.width, REGION_MIN_PX);
  const y = span(start.y, end.y, box.height, REGION_MIN_PX);
  return { x: x.start, y: y.start, width: x.length, height: y.length };
}

/** CSS percentages that place `region` over its picture. */
export function regionPercentages(region: ReviewRegion) {
  const percent = (value: number) => `${value * 100}%`;
  return {
    left: percent(region.x),
    top: percent(region.y),
    width: percent(region.width),
    height: percent(region.height),
  };
}

export interface ClipRange {
  readonly startMs: number;
  readonly endMs: number;
}

/** A clip time as `m:ss.s`, the precision a person can see in a frame. */
export function formatClipTime(ms: number): string {
  const tenths = Math.max(0, Math.round(ms / 100));
  const minutes = Math.floor(tenths / 600);
  const seconds = (tenths % 600) / 10;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

export function formatClipRange(range: ClipRange): string {
  return range.endMs - range.startMs < 100
    ? formatClipTime(range.startMs)
    : `${formatClipTime(range.startMs)}–${formatClipTime(range.endMs)}`;
}

/** The clip time at `fraction` of a strip `lengthMs` long. */
export function timeAtFraction(fraction: number, lengthMs: number): number {
  return Math.round(clamp(fraction, 0, 1) * Math.max(0, lengthMs));
}

export function rangeFromTimes(aMs: number, bMs: number, lengthMs: number): ClipRange {
  const a = clamp(Math.round(aMs), 0, lengthMs);
  const b = clamp(Math.round(bMs), 0, lengthMs);
  return { startMs: Math.min(a, b), endMs: Math.max(a, b) };
}

/** Moves one end of `range` to `ms`; an end dragged past the other stops at it. */
export function moveRangeEnd(
  range: ClipRange,
  end: "start" | "end",
  ms: number,
  lengthMs: number,
): ClipRange {
  const at = clamp(Math.round(ms), 0, lengthMs);
  return end === "start"
    ? { startMs: Math.min(at, range.endMs), endMs: range.endMs }
    : { startMs: range.startMs, endMs: Math.max(at, range.startMs) };
}

/** "Mark start" and "Mark end" at the playhead; marking one end past the other moves both. */
export function markRange(
  range: ClipRange | null,
  end: "start" | "end",
  ms: number,
  lengthMs: number,
): ClipRange {
  const at = clamp(Math.round(ms), 0, lengthMs);
  if (range === null) return { startMs: at, endMs: at };
  return end === "start"
    ? { startMs: at, endMs: Math.max(at, range.endMs) }
    : { startMs: Math.min(at, range.startMs), endMs: at };
}

export function rangePercentages(range: ClipRange, lengthMs: number) {
  if (lengthMs <= 0) return { left: "0%", width: "0%" };
  const start = clamp(range.startMs / lengthMs, 0, 1);
  const end = clamp(range.endMs / lengthMs, start, 1);
  return { left: `${start * 100}%`, width: `${(end - start) * 100}%` };
}

export function isInRange(ms: number, range: ClipRange): boolean {
  return ms >= range.startMs && ms <= Math.max(range.endMs, range.startMs + 100);
}

type CodeRangeAnchor = Extract<ReviewCommentAnchorInput, { readonly kind: "code-range" }>;

function positionSide(position: PullRequestReviewPosition): "old" | "new" {
  switch (position.kind) {
    case "added":
      return "new";
    case "deleted":
      return "old";
    case "context":
      return position.side === "left" ? "old" : "new";
  }
}

function positionLine(position: PullRequestReviewPosition, side: "old" | "new"): number {
  switch (position.kind) {
    case "added":
      return position.newLine;
    case "deleted":
      return position.oldLine;
    case "context":
      return side === "old" ? position.oldLine : position.newLine;
  }
}

/**
 * A `code-range` anchor from the diff's line selection. The side is the one the selection ended
 * on, and the commit is the packet's head for it or its base for removed lines; a selection
 * that crosses sides keeps only the line it ended on.
 */
export function codeRangeAnchor(input: {
  readonly path: string;
  readonly position: PullRequestReviewPosition;
  readonly startPosition?: PullRequestReviewPosition | undefined;
  readonly revision: { readonly base: string; readonly head: string };
  readonly claimId?: string | undefined;
}): CodeRangeAnchor {
  const side = positionSide(input.position);
  const end = positionLine(input.position, side);
  const start =
    input.startPosition !== undefined && positionSide(input.startPosition) === side
      ? positionLine(input.startPosition, side)
      : end;
  return {
    kind: "code-range",
    packetHead: input.revision.head,
    ...(input.claimId === undefined ? {} : { claimId: input.claimId }),
    path: input.path,
    side,
    startLine: Math.min(start, end),
    endLine: Math.max(start, end),
    commit: side === "new" ? input.revision.head : input.revision.base,
  };
}

/** Comments a person can still change: their entries no send has delivered yet. */
export function unsentEntryIds(thread: ReviewCommentThread): ReadonlySet<string> {
  return new Set(
    thread.entries.flatMap((entry) =>
      entry.author === "person" && entry.sentAt === null ? [entry.id] : [],
    ),
  );
}

/** What one send delivers: every unsent person entry of a comment nobody resolved. */
function countUnsent(threads: ReadonlyArray<ReviewCommentThread>): number {
  let count = 0;
  for (const thread of threads) {
    if (thread.state !== "resolved") count += unsentEntryIds(thread).size;
  }
  return count;
}

export function commentCounts(threads: ReadonlyArray<ReviewCommentThread>): ReviewCommentCounts {
  const counts = { pending: 0, open: 0, answered: 0, resolved: 0, unsent: countUnsent(threads) };
  for (const thread of threads) counts[thread.state] += 1;
  return counts;
}

/**
 * What the server answered to this client's own commands, shown until the comments query
 * catches up. `at` and the query's `updatedAt` are both this client's clock.
 */
export interface CommentOverlay {
  readonly changed: ReadonlyMap<
    string,
    { readonly thread: ReviewCommentThread | null; readonly at: number }
  >;
  readonly sent: { readonly threadId: ThreadId; readonly at: string; readonly atMs: number } | null;
}

export const EMPTY_OVERLAY: CommentOverlay = { changed: new Map(), sent: null };

export function overlayChange(
  overlay: CommentOverlay,
  id: string,
  thread: ReviewCommentThread | null,
  at: number,
): CommentOverlay {
  const changed = new Map(overlay.changed);
  changed.set(id, { thread, at });
  return { ...overlay, changed };
}

function markSent(
  thread: ReviewCommentThread,
  threadId: ThreadId,
  at: string,
): ReviewCommentThread {
  if (thread.state === "resolved" || unsentEntryIds(thread).size === 0) return thread;
  return {
    ...thread,
    state: "open",
    entries: thread.entries.map((entry) =>
      entry.author === "person" && entry.sentAt === null
        ? { ...entry, sentAt: at, sentToThreadId: entry.sentToThreadId ?? threadId }
        : entry,
    ),
  };
}

/** The comments to draw: the query's, with this client's newer answers laid over them. */
export function applyOverlay(
  threads: ReadonlyArray<ReviewCommentThread>,
  overlay: CommentOverlay,
  updatedAt: number,
): ReadonlyArray<ReviewCommentThread> {
  const newer = [...overlay.changed].filter(([, change]) => change.at > updatedAt);
  const sent = overlay.sent !== null && overlay.sent.atMs > updatedAt ? overlay.sent : null;
  if (newer.length === 0 && sent === null) return threads;
  const byId = new Map(newer);
  const merged: Array<ReviewCommentThread> = [];
  for (const thread of threads) {
    const change = byId.get(thread.id);
    byId.delete(thread.id);
    const current = change === undefined ? thread : change.thread;
    if (current !== null) merged.push(current);
  }
  for (const [, change] of byId) if (change.thread !== null) merged.push(change.thread);
  return sent === null ? merged : merged.map((thread) => markSent(thread, sent.threadId, sent.at));
}

export interface PacketCommentLayout {
  readonly byClaim: ReadonlyMap<string, ReadonlyArray<ReviewCommentThread>>;
  readonly byMedia: ReadonlyMap<string, ReadonlyArray<ReviewCommentThread>>;
  readonly byPath: ReadonlyMap<string, ReadonlyArray<ReviewCommentThread>>;
  /** Comments on media outside any claim, such as a blocker's screenshot. */
  readonly outsideClaims: ReadonlyArray<ReviewCommentThread>;
  readonly outdated: ReadonlyArray<ReviewCommentThread>;
  readonly unknown: ReadonlyArray<ReviewCommentThread>;
}

/** Where each comment shows on the packet being drawn. */
export function layoutPacketComments(
  threads: ReadonlyArray<ReviewCommentThread>,
  packet: ReviewPacket,
): PacketCommentLayout {
  const index = indexReviewComments(threads);
  const claims = new Set(packet.claims.map((claim) => claim.id));
  const outsideClaims = threads.filter((thread) => {
    const anchor = thread.anchor;
    if (isUnknownUnionMember(anchor) || thread.outdated) return false;
    return anchor.claimId === undefined || !claims.has(anchor.claimId);
  });
  return {
    byClaim: index.byClaim,
    byMedia: index.byMedia,
    byPath: index.byPath,
    outsideClaims,
    outdated: index.outdated,
    unknown: index.unknown,
  };
}

/** Comments written under `claimId`, or outside every claim for null (a finding's media). */
export function threadsUnder(
  threads: ReadonlyArray<ReviewCommentThread>,
  claimId: string | null,
): ReadonlyArray<ReviewCommentThread> {
  return threads.filter((thread) => {
    const anchor = thread.anchor;
    return !isUnknownUnionMember(anchor) && (anchor.claimId ?? null) === claimId;
  });
}

/** Each comment's number on its picture or strip, in the order they were written. */
export function markerNumbers(
  threads: ReadonlyArray<ReviewCommentThread>,
): ReadonlyMap<string, number> {
  return new Map(threads.map((thread, index) => [thread.id, index + 1]));
}

/** The send goes to the person's pick while it still owns the change, else to the server's first. */
export function chooseSendTarget(
  candidates: ReadonlyArray<ReviewCommentThreadCandidate>,
  picked: string | null,
): ReviewCommentThreadCandidate | null {
  return candidates.find((candidate) => candidate.threadId === picked) ?? candidates[0] ?? null;
}

const shortSha = (sha: string) => sha.slice(0, 7);

/** Where a comment points, in words, for a comment whose anchor left the latest packet. */
export function describeAnchor(
  thread: ReviewCommentThread,
  resolve: MFunctionType = mFallback,
): string {
  const anchor = thread.anchor;
  if (isUnknownUnionMember(anchor)) {
    return resolve(msg("A kind of comment this app cannot show yet"));
  }
  switch (anchor.kind) {
    case "claim":
      return resolve(msg("The claim itself"));
    case "image-region":
      return anchor.region === undefined
        ? resolve(msg("A screenshot"))
        : resolve(msg("An area of a screenshot"));
    case "video-range":
      return resolve(msg("{range} of a clip", { range: formatClipRange(anchor) }));
    case "code-range":
      return anchor.startLine === anchor.endLine
        ? resolve(
            msg(
              "{path}, line {line} of the {side, select, old {old} other {new}} file at {commit}",
              {
                path: anchor.path,
                line: anchor.startLine,
                side: anchor.side,
                commit: shortSha(anchor.commit),
              },
            ),
          )
        : resolve(
            msg(
              "{path}, lines {start}-{end} of the {side, select, old {old} other {new}} file at {commit}",
              {
                path: anchor.path,
                start: anchor.startLine,
                end: anchor.endLine,
                side: anchor.side,
                commit: shortSha(anchor.commit),
              },
            ),
          );
  }
}

/** The title of the claim a comment was written under, or its id when no packet here has it. */
export function anchorClaimTitle(thread: ReviewCommentThread, packet: ReviewPacket): string | null {
  const anchor = thread.anchor;
  if (isUnknownUnionMember(anchor) || anchor.claimId === undefined) return null;
  return packet.claims.find((claim) => claim.id === anchor.claimId)?.title ?? anchor.claimId;
}
