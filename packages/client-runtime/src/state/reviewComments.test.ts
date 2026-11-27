import { ReviewCommentThread } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { indexReviewComments } from "./reviewComments.ts";

const head = "2".repeat(40);
const media = (digit: string) => `sha256:${digit.repeat(64)}`;
const decode = Schema.decodeUnknownSync(ReviewCommentThread);
const thread = (id: string, anchor: object, extra: object = {}) =>
  decode({
    id: `rc_${id.padStart(16, "0")}`,
    anchor: { packetHead: head, ...anchor },
    state: "open",
    outdated: false,
    entries: [],
    createdAt: "2026-11-27T19:40:00Z",
    updatedAt: "2026-11-27T19:40:00Z",
    resolvedAt: null,
    ...extra,
  });

describe("indexReviewComments", () => {
  it("places a re-cut clip's comment on the clip that holds it now and sets outdated ones apart", () => {
    const claim = thread("1", { kind: "claim", claimId: "smelt" });
    const image = thread("2", { kind: "image-region", media: media("1"), claimId: "smelt" });
    const recut = thread(
      "3",
      { kind: "video-range", media: media("2"), startMs: 0, endMs: 10 },
      { currentClip: { media: media("4"), evidenceId: "recut", startMs: 5, endMs: 15 } },
    );
    const code = thread("4", {
      kind: "code-range",
      path: "src/trade.ts",
      side: "new",
      startLine: 1,
      endLine: 2,
      commit: head,
    });
    const gone = thread("5", { kind: "claim", claimId: "dropped" }, { outdated: true });
    const later = thread("6", { kind: "audio-range", media: media("5") });

    const index = indexReviewComments([claim, image, recut, code, gone, later]);
    expect(index.byClaim.get("smelt")).toEqual([claim, image]);
    expect(index.byMedia.get(media("1"))).toEqual([image]);
    expect(index.byMedia.get(media("4"))).toEqual([recut]);
    expect(index.byMedia.has(media("2"))).toBe(false);
    expect(index.byPath.get("src/trade.ts")).toEqual([code]);
    expect(index.outdated).toEqual([gone]);
    expect(index.unknown).toEqual([later]);
  });
});
