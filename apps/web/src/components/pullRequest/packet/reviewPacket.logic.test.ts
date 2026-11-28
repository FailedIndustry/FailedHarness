import type { ReviewPacket } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isPacketBehind,
  packetForPullRequest,
  packetVisuals,
  pathspecFilter,
} from "./reviewPacket.logic";

const media = (char: string) => `sha256:${char.repeat(64)}`;

describe("pathspecFilter", () => {
  const paths = [
    "harness/gw",
    "harness/gw/finalize.lua",
    "harness/gwx.lua",
    "harness/README.md",
    "ixhl2rp/plugins/storage/sh_plugin.lua",
    "ixhl2rp/plugins/storage_ui.lua",
    "ixhl2rp/plugins/stacking/sh_plugin.lua",
    "AGENTS.md",
  ];
  const cases: ReadonlyArray<readonly [ReadonlyArray<string>, ReadonlyArray<string>]> = [
    [["harness/gw"], ["harness/gw", "harness/gw/finalize.lua"]],
    [["harness/gw/"], ["harness/gw/finalize.lua"]],
    [["./AGENTS.md"], ["AGENTS.md"]],
    // Without :(glob), git's `*` crosses `/`.
    [
      ["ixhl2rp/plugins/storage*"],
      ["ixhl2rp/plugins/storage/sh_plugin.lua", "ixhl2rp/plugins/storage_ui.lua"],
    ],
    [["*.md"], ["harness/README.md", "AGENTS.md"]],
    [["ixhl2rp/plugins/st?cking"], ["ixhl2rp/plugins/stacking/sh_plugin.lua"]],
    [["harness/gw[x]*"], ["harness/gwx.lua"]],
    [
      ["harness", ":!harness/gw"],
      ["harness/gwx.lua", "harness/README.md"],
    ],
    [
      [":(exclude)*.lua", ":/harness"],
      ["harness/gw", "harness/README.md"],
    ],
    [[":^*.lua"], ["harness/gw", "harness/README.md", "AGENTS.md"]],
    [[], []],
  ];
  it.each(cases)("%j matches what git would", (specs, expected) => {
    const filter = pathspecFilter(specs);
    expect(paths.filter(filter.matches)).toEqual(expected);
    expect(filter.unsupported).toEqual([]);
  });

  it("reports magic it cannot apply instead of matching on it", () => {
    const filter = pathspecFilter([":(glob)**/*.lua", "AGENTS.md"]);
    expect(filter.unsupported).toEqual([":(glob)**/*.lua"]);
    expect(paths.filter(filter.matches)).toEqual(["AGENTS.md"]);
  });
});

describe("packetVisuals", () => {
  it("leads with clips, keeps each kind's order, and leaves checks out", () => {
    const visuals = packetVisuals(
      [
        { id: "shot-1", kind: "image", media: media("a"), caption: "Before" },
        { id: "tests", kind: "check", name: "unit", passed: true },
        { id: "clip-1", kind: "clip", media: media("b"), startMs: 0, endMs: 10 },
        { id: "shot-2", kind: "image", media: media("c") },
        { id: "clip-2", kind: "clip", media: media("d"), startMs: 0, endMs: 10 },
      ],
      [{ id: media("a"), file: "media/a.jpg", type: "image/jpeg", bytes: 1 }],
    );
    expect(visuals.map((item) => item.evidenceId)).toEqual([
      "clip-1",
      "clip-2",
      "shot-1",
      "shot-2",
    ]);
    expect(visuals[2]).toMatchObject({ caption: "Before", media: { file: "media/a.jpg" } });
    expect(visuals[3]?.media).toBeNull();
  });
});

describe("packet and pull request", () => {
  const packet = {
    change: { repository: "o/r", branch: "b", base: "main" },
    revision: { base: "1".repeat(40), head: "f1e22078b7ad4fa559a083c38059b71c0f7334ae" },
  } as unknown as ReviewPacket;

  it("is behind only when the pull request's head is known and differs", () => {
    expect(isPacketBehind(packet, undefined)).toBe(false);
    expect(isPacketBehind(packet, "F1E22078B7AD4FA559A083C38059B71C0F7334AE")).toBe(false);
    expect(isPacketBehind(packet, "9ae228ffe0c496bebb9b57d509a38f22e6208813")).toBe(true);
  });

  it("ignores a packet that names another pull request on the same branch", () => {
    expect(packetForPullRequest(packet, 21)).toBe(packet);
    const named = { ...packet, change: { ...packet.change, pullRequest: 18 } };
    expect(packetForPullRequest(named, 18)).toBe(named);
    expect(packetForPullRequest(named, 21)).toBeNull();
  });
});
