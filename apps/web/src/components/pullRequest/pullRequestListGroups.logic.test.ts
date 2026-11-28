import { describe, expect, it } from "vite-plus/test";

import { pullRequestQueueNeighbours } from "./pullRequestListGroups.logic";

describe("stepping through the pull request queue", () => {
  const listed = ["a", "b", "c"];

  it("stops at either end of the list", () => {
    expect(pullRequestQueueNeighbours({ walk: null, listed, current: "a" })).toMatchObject({
      previous: null,
      next: "b",
    });
    expect(pullRequestQueueNeighbours({ walk: null, listed, current: "c" })).toMatchObject({
      previous: "b",
      next: null,
    });
  });

  it("enters the list from nowhere either way, and from a row it no longer shows only forward", () => {
    expect(pullRequestQueueNeighbours({ walk: null, listed, current: null })).toMatchObject({
      previous: "c",
      next: "a",
    });
    expect(pullRequestQueueNeighbours({ walk: null, listed, current: "z" })).toMatchObject({
      previous: null,
      next: "a",
    });
    expect(pullRequestQueueNeighbours({ walk: null, listed: [], current: null })).toMatchObject({
      previous: null,
      next: null,
    });
  });

  it("keeps the walk's order when the change being reviewed re-ranks or leaves the list", () => {
    // "a" moved below "b" once its comments were resolved; the next step is still "b".
    expect(
      pullRequestQueueNeighbours({ walk: ["a", "b", "c"], listed: ["b", "a", "c"], current: "a" }),
    ).toMatchObject({ next: "b" });
    // A filter hid "a" and "b" closed meanwhile.
    expect(
      pullRequestQueueNeighbours({ walk: ["a", "b", "c"], listed: ["c"], current: "a" }),
    ).toMatchObject({ keys: ["a", "c"], previous: null, next: "c" });
  });
});
