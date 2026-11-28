import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ReviewClaimsFile, ReviewPacket, findDanglingMediaReferences } from "./reviewPacket.ts";

const hex = (char: string, length: number) => char.repeat(length);
const shot = `sha256:${hex("a", 64)}`;
const clip = `sha256:${hex("b", 64)}`;
const fullRecording = `sha256:${hex("c", 64)}`;

const manifest = () => ({
  schema: 1,
  change: {
    repository: "GlutWorks/GlutWorks",
    branch: "immersion-3-stations",
    base: "immersion-2-interaction",
    pullRequest: 18,
  },
  revision: { base: hex("1", 40), head: hex("2", 40), recordedAt: "2026-11-27T19:40:00Z" },
  status: {
    verdict: "pass",
    checks: { passed: 130, newFailures: 0 },
    playtest: { by: "agent", model: "gpt-6.1-terra" },
  },
  claims: [
    {
      id: "trade-in-world",
      title: "Trade in world",
      statement: "Trading happens beside the vendor.",
      result: "seen",
      evidence: [
        {
          id: "trade-clip",
          kind: "clip",
          media: clip,
          recording: fullRecording,
          startMs: 61200,
          endMs: 68900,
        },
        { id: "trade-shot", kind: "image", media: shot },
        { id: "smelt-check", kind: "check", name: "ores can be smelted", passed: true },
      ],
      paths: ["ixhl2rp/plugins/vendorpanel/"],
    },
  ],
  blockers: [],
  notes: [],
  media: [
    { id: shot, file: `media/${hex("a", 64)}.jpg`, type: "image/jpeg", bytes: 184320 },
    {
      id: clip,
      file: `media/${hex("b", 64)}.mp4`,
      type: "video/mp4",
      bytes: 9437184,
      durationMs: 7700,
    },
  ],
});

const decode = Schema.decodeUnknownSync(ReviewPacket);
const decodeClaims = Schema.decodeUnknownSync(ReviewClaimsFile);

describe("ReviewPacket", () => {
  it("decodes a complete manifest", () => {
    const packet = decode(manifest());
    expect(packet.claims[0]?.evidence.map((item) => item.kind)).toEqual(["clip", "image", "check"]);
  });

  it("drops an unknown evidence kind and ignores unknown keys, keeping known evidence", () => {
    const input = manifest();
    input.claims[0]!.evidence.splice(1, 0, { id: "x", kind: "audio", media: shot } as never);
    const decoded = decode({ ...input, futureField: true });
    expect(decoded.claims[0]?.evidence.map((item) => item.id)).toEqual([
      "trade-clip",
      "trade-shot",
      "smelt-check",
    ]);
    expect("futureField" in decoded).toBe(false);
  });

  it("rejects a bad media id and a missing required field", () => {
    const badMedia = manifest();
    badMedia.media[0]!.id = "sha256:ABC";
    expect(() => decode(badMedia)).toThrow();
    const { revision: _revision, ...missing } = manifest();
    expect(() => decode(missing)).toThrow();
  });

  it("treats a clip that ends before it starts as unreadable evidence", () => {
    const input = manifest();
    const first = input.claims[0]!.evidence[0]!;
    if (first.kind === "clip") first.endMs = 1;
    // A malformed known kind is dropped like an unreadable one, so the clip disappears.
    expect(decode(input).claims[0]?.evidence.map((item) => item.id)).not.toContain("trade-clip");
  });

  it("flags evidence media missing from media[] but not a dangling recording", () => {
    const input = manifest();
    input.media.pop();
    expect(findDanglingMediaReferences(decode(input))).toEqual([clip]);
    expect(findDanglingMediaReferences(decode(manifest()))).toEqual([]);
  });
});

describe("ReviewClaimsFile", () => {
  it("decodes with paths and id omitted", () => {
    const decoded = decodeClaims({
      claims: [{ title: "Trade in world", statement: "Choosing a row trades one unit." }],
    });
    expect(decoded.claims[0]?.paths).toBeUndefined();
  });
});
