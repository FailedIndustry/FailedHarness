import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { isUnknownUnionMember } from "./baseSchemas.ts";
import { ReviewCommentAnchorInput, ReviewCommentListResult } from "./reviewComment.ts";

const head = "2".repeat(40);
const decodeList = Schema.decodeUnknownSync(ReviewCommentListResult);
const decodeAnchor = Schema.decodeUnknownExit(ReviewCommentAnchorInput);
const thread = (anchor: object) => ({
  id: "rc_0123456789abcdef",
  anchor,
  state: "open",
  outdated: false,
  entries: [
    {
      id: "re_0123456789abcdef",
      author: "person",
      text: "Look here.",
      createdAt: "2026-11-27T19:40:00Z",
      updatedAt: "2026-11-27T19:40:00Z",
      sentAt: "2026-11-27T19:41:00Z",
      sentToThreadId: "thread-1",
    },
  ],
  createdAt: "2026-11-27T19:40:00Z",
  updatedAt: "2026-11-27T19:41:00Z",
  resolvedAt: null,
});

describe("review comments", () => {
  it("decodes a list whose anchor kind this reader does not know, keeping the known ones whole", () => {
    const decoded = decodeList({
      comments: [
        thread({ kind: "audio-range", packetHead: head, media: "x", startMs: 1, endMs: 2 }),
        thread({ kind: "claim", packetHead: head, claimId: "trade-in-world" }),
      ],
      nextCursor: null,
      counts: { pending: 0, open: 2, answered: 0, resolved: 0, unsent: 0 },
      latestHead: head,
    });
    expect(isUnknownUnionMember(decoded.comments[0]!.anchor)).toBe(true);
    expect(decoded.comments[1]!.anchor).toEqual({
      kind: "claim",
      packetHead: head,
      claimId: "trade-in-world",
    });
  });

  it("refuses ranges and regions that end before they start or leave the picture", () => {
    const decode = decodeAnchor;
    const video = { kind: "video-range", packetHead: head, media: `sha256:${"a".repeat(64)}` };
    expect(decode({ ...video, startMs: 10, endMs: 5 })._tag).toBe("Failure");
    expect(
      decode({ ...video, startMs: 0, endMs: 5, region: { x: 0.8, y: 0, width: 0.4, height: 1 } })
        ._tag,
    ).toBe("Failure");
    expect(decode({ ...video, startMs: 0, endMs: 5 })._tag).toBe("Success");
  });
});
