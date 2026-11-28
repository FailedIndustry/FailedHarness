import type { ReviewCommentThread, ReviewPacket, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyOverlay,
  codeRangeAnchor,
  commentCounts,
  EMPTY_OVERLAY,
  formatClipRange,
  formatClipTime,
  fractionInBox,
  layoutPacketComments,
  markRange,
  moveRangeEnd,
  overlayChange,
  rangeFromTimes,
  regionFromDrag,
  timeAtFraction,
} from "./packetComments.logic";

const HEAD = "b".repeat(40);
const BASE = "a".repeat(40);
const IMAGE = `sha256:${"1".repeat(64)}`;
const CLIP = `sha256:${"2".repeat(64)}`;
const RECUT = `sha256:${"3".repeat(64)}`;

const person = (id: string, sentAt: string | null) => ({
  id,
  author: "person" as const,
  text: id,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  sentAt,
  sentToThreadId: null,
});

const thread = (
  id: string,
  anchor: ReviewCommentThread["anchor"],
  overrides: Partial<ReviewCommentThread> = {},
): ReviewCommentThread => ({
  id,
  anchor,
  state: "pending",
  outdated: false,
  entries: [person(`re_${id}`, null)],
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  resolvedAt: null,
  ...overrides,
});

describe("regions", () => {
  const box = { left: 100, top: 50, width: 400, height: 200 };

  it("keeps a pointer that leaves the picture on its edge", () => {
    expect(fractionInBox(50, 300, box)).toEqual({ x: 0, y: 1 });
    expect(fractionInBox(300, 150, box)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("treats a short drag as a tap on the whole picture", () => {
    expect(regionFromDrag({ x: 0.5, y: 0.5 }, { x: 0.51, y: 0.51 }, box)).toBeNull();
    expect(
      regionFromDrag({ x: 0.2, y: 0 }, { x: 0.8, y: 0 }, { width: 400, height: 0 }),
    ).toBeNull();
  });

  it("orders a drag drawn up and left, and keeps it inside the picture", () => {
    expect(regionFromDrag({ x: 0.75, y: 0.9 }, { x: 0.25, y: 0.4 }, box)).toEqual({
      x: 0.25,
      y: 0.4,
      width: 0.5,
      height: 0.5,
    });
  });

  it("grows a sliver to a size that can be seen and clicked, still inside the picture", () => {
    const region = regionFromDrag({ x: 0.2, y: 0.999 }, { x: 0.6, y: 1 }, box)!;
    expect(region.height * box.height).toBeCloseTo(12);
    expect(region.y + region.height).toBeLessThanOrEqual(1);
    expect(region.width).toBeCloseTo(0.4);
  });
});

describe("clip ranges", () => {
  it("shows clip time to the tenth of a second", () => {
    expect(formatClipTime(0)).toBe("0:00.0");
    expect(formatClipTime(65_449)).toBe("1:05.4");
    expect(formatClipTime(59_960)).toBe("1:00.0");
    expect(formatClipRange({ startMs: 1200, endMs: 1250 })).toBe("0:01.2");
    expect(formatClipRange({ startMs: 1200, endMs: 2900 })).toBe("0:01.2–0:02.9");
  });

  it("orders a strip drag and keeps it inside the clip", () => {
    expect(timeAtFraction(1.4, 4000)).toBe(4000);
    expect(rangeFromTimes(3000, -20, 4000)).toEqual({ startMs: 0, endMs: 3000 });
  });

  it("stops an end dragged past the other one at it", () => {
    const range = { startMs: 1000, endMs: 2000 };
    expect(moveRangeEnd(range, "start", 2500, 4000)).toEqual({ startMs: 2000, endMs: 2000 });
    expect(moveRangeEnd(range, "end", 9000, 4000)).toEqual({ startMs: 1000, endMs: 4000 });
  });

  it("marks a moment first, then a range; marking before the start moves both", () => {
    const start = markRange(null, "start", 1200, 4000);
    expect(start).toEqual({ startMs: 1200, endMs: 1200 });
    expect(markRange(start, "end", 2900, 4000)).toEqual({ startMs: 1200, endMs: 2900 });
    expect(markRange({ startMs: 1200, endMs: 2900 }, "end", 500, 4000)).toEqual({
      startMs: 500,
      endMs: 500,
    });
  });
});

describe("codeRangeAnchor", () => {
  const revision = { base: BASE, head: HEAD };

  it("anchors added and context lines to the head, removed lines to the base", () => {
    expect(
      codeRangeAnchor({
        path: "src/trade.lua",
        position: { kind: "added", newLine: 14 },
        startPosition: { kind: "context", oldLine: 10, newLine: 12, side: "right" },
        revision,
        claimId: "trade",
      }),
    ).toEqual({
      kind: "code-range",
      packetHead: HEAD,
      claimId: "trade",
      path: "src/trade.lua",
      side: "new",
      startLine: 12,
      endLine: 14,
      commit: HEAD,
    });
    expect(
      codeRangeAnchor({ path: "a.lua", position: { kind: "deleted", oldLine: 7 }, revision }),
    ).toMatchObject({ side: "old", startLine: 7, endLine: 7, commit: BASE });
  });

  it("keeps only the last line of a selection that crosses from removed to added lines", () => {
    expect(
      codeRangeAnchor({
        path: "a.lua",
        position: { kind: "added", newLine: 9 },
        startPosition: { kind: "deleted", oldLine: 8 },
        revision,
      }),
    ).toMatchObject({ side: "new", startLine: 9, endLine: 9 });
  });
});

describe("comments on screen", () => {
  const claim = thread("rc_claim", { kind: "claim", packetHead: HEAD, claimId: "bag" });
  const image = thread("rc_image", {
    kind: "image-region",
    packetHead: HEAD,
    claimId: "bag",
    media: IMAGE,
  });
  const recut = thread(
    "rc_clip",
    { kind: "video-range", packetHead: HEAD, media: CLIP, startMs: 0, endMs: 100 },
    {
      state: "answered",
      currentClip: { media: RECUT, evidenceId: "walk", startMs: 10, endMs: 110 },
      entries: [person("re_sent", "2026-11-01T00:00:01Z"), person("re_follow", null)],
    },
  );
  const old = thread(
    "rc_old",
    { kind: "claim", packetHead: HEAD, claimId: "gone" },
    { outdated: true },
  );
  const packet = { claims: [{ id: "bag" }], blockers: [], notes: [] } as unknown as ReviewPacket;

  it("puts each comment under its claim, on its media (a re-cut clip's own), or with the outdated", () => {
    const layout = layoutPacketComments([claim, image, recut, old], packet);
    expect(layout.byClaim.get("bag")?.map((t) => t.id)).toEqual(["rc_claim", "rc_image"]);
    expect(layout.byMedia.get(RECUT)?.map((t) => t.id)).toEqual(["rc_clip"]);
    expect(layout.outsideClaims.map((t) => t.id)).toEqual(["rc_clip"]);
    expect(layout.outdated.map((t) => t.id)).toEqual(["rc_old"]);
  });

  it("counts an unsent follow-up on an answered comment as unsent, not as a new state", () => {
    expect(commentCounts([claim, image, recut])).toEqual({
      pending: 2,
      open: 0,
      answered: 1,
      resolved: 0,
      unsent: 3,
    });
  });

  it("shows this client's answers until the query is newer, and marks a send at once", () => {
    const edited = { ...image, entries: [{ ...person("re_rc_image", null), text: "edited" }] };
    let overlay = overlayChange(EMPTY_OVERLAY, image.id, edited, 200);
    overlay = overlayChange(overlay, claim.id, null, 200);
    const fresh = thread("rc_new", { kind: "claim", packetHead: HEAD, claimId: "bag" });
    overlay = overlayChange(overlay, fresh.id, fresh, 200);

    const before = applyOverlay([claim, image, recut], overlay, 100);
    expect(before.map((t) => t.id)).toEqual(["rc_image", "rc_clip", "rc_new"]);
    expect(before[0]?.entries[0]?.text).toBe("edited");
    expect(applyOverlay([claim, image, recut], overlay, 300).map((t) => t.id)).toEqual([
      "rc_claim",
      "rc_image",
      "rc_clip",
    ]);

    const sent = applyOverlay(
      [image, recut],
      {
        ...EMPTY_OVERLAY,
        sent: { threadId: "thread-1" as ThreadId, at: "2026-11-02T00:00:00Z", atMs: 400 },
      },
      300,
    );
    expect(sent.map((t) => t.state)).toEqual(["open", "open"]);
    expect(commentCounts(sent).unsent).toBe(0);
  });
});
