import { describe, expect, it } from "vite-plus/test";

import { harnessSessionControls } from "./harness-session-controls";

describe("harnessSessionControls", () => {
  it("allows stop and mark on a running recorded session", () => {
    expect(harnessSessionControls({ phase: "running", recorded: true }, true)).toEqual({
      live: true,
      canStop: true,
      markBlock: null,
    });
  });

  it("explains an unrecorded session before anything else", () => {
    expect(harnessSessionControls({ phase: "running", recorded: false }, false).markBlock).toBe(
      "not-recorded",
    );
  });

  it("holds marks until the session runs", () => {
    expect(harnessSessionControls({ phase: "starting", recorded: true }, true).markBlock).toBe(
      "not-running",
    );
  });

  it("turns both off without the operate scope", () => {
    const controls = harnessSessionControls({ phase: "running", recorded: true }, false);
    expect(controls.canStop).toBe(false);
    expect(controls.markBlock).toBe("no-permission");
  });

  it("stops offering stop once the session is stopping or ended", () => {
    expect(harnessSessionControls({ phase: "stopping", recorded: true }, true).canStop).toBe(false);
    expect(harnessSessionControls({ phase: "stopped", recorded: true }, true).live).toBe(false);
  });
});
