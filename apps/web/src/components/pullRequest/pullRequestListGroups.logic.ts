import type {
  PullRequestInvolvement,
  PullRequestListFilters,
  PullRequestListResult,
} from "@t3tools/contracts";

import type { PullRequestTabStatusSeed } from "~/components/RightPanelTabs";
import { pullRequestSurfaceId } from "~/rightPanelStore";
import {
  comparePullRequestsByRecency,
  filterPullRequestsByInvolvement,
  groupPullRequestsByInvolvement,
  matchesPullRequestFilters,
  matchesPullRequestQuery,
  partitionPullRequestsWithPriority,
  pullRequestEntryKey,
  pullRequestEntryViewer,
  rankPullRequestMatches,
  type EnvironmentPullRequestEntry,
  type PullRequestPartitionsSnapshot,
} from "./pullRequestList.logic";

export const pullRequestListEntryId = (target: Parameters<typeof pullRequestSurfaceId>[0]) =>
  pullRequestSurfaceId({ ...target, repository: target.repository.toLowerCase() });

/** The held rows narrowed to what the reader asked for, in the groups the list shows. */
export function pullRequestGroups({
  known,
  baseline,
  providers,
  viewers,
  involvement,
  localFilters,
  hasLocalFilters,
  text,
  answeredLocally,
  baselineEmpty,
  held,
  authored,
  reviewing,
  partitionsWanted,
}: {
  known: ReadonlyArray<EnvironmentPullRequestEntry>;
  /** The text-free rows already loaded, or undefined when the typed filters cannot vet them. */
  baseline: ReadonlyArray<EnvironmentPullRequestEntry> | undefined;
  providers: PullRequestListResult["providers"];
  viewers: PullRequestListResult["viewers"];
  involvement: PullRequestInvolvement;
  localFilters: PullRequestListFilters;
  hasLocalFilters: boolean;
  text: string;
  answeredLocally: boolean;
  baselineEmpty: boolean;
  held: PullRequestPartitionsSnapshot | undefined;
  authored: ReadonlyArray<EnvironmentPullRequestEntry> | undefined;
  reviewing: ReadonlyArray<EnvironmentPullRequestEntry> | undefined;
  partitionsWanted: boolean;
}) {
  const searchingHosts = new Set(
    providers.flatMap((provider) => (provider.searchesOnHost ? [provider.host] : [])),
  );

  const narrowRows = (rows: ReadonlyArray<EnvironmentPullRequestEntry>) => {
    const involvementEntries = filterPullRequestsByInvolvement(rows, viewers, involvement);
    return hasLocalFilters
      ? involvementEntries.filter((entry) =>
          matchesPullRequestFilters(entry, localFilters, pullRequestEntryViewer(entry, viewers)),
        )
      : involvementEntries;
  };

  const entries = (() => {
    const narrowedEntries = narrowRows(known);
    if (text.length === 0) {
      return narrowedEntries.toSorted(comparePullRequestsByRecency);
    }
    // Host text searches cover fields absent from rows, so do not narrow their matches locally.
    // Filter text locally while results are pending or when the host has no text search.
    const matched = narrowedEntries.filter(
      (entry) =>
        (answeredLocally && searchingHosts.has(entry.host)) || matchesPullRequestQuery(entry, text),
    );
    // Host search matches whole words, so it can miss loaded rows a partial word matches here.
    // Those follow the host's ranked answer rather than reshuffling it.
    const listed = new Set(matched.map(pullRequestEntryKey));
    const missed = narrowRows(baseline ?? []).filter(
      (entry) => !listed.has(pullRequestEntryKey(entry)) && matchesPullRequestQuery(entry, text),
    );
    return missed.length === 0 ? matched : [...matched, ...rankPullRequestMatches(missed, text)];
  })();

  const listedPullRequestTabStatuses: Record<string, PullRequestTabStatusSeed> = Object.fromEntries(
    entries.map((entry) => [
      pullRequestSurfaceId(entry),
      {
        state: entry.state,
        isDraft: entry.isDraft,
      },
    ]),
  );

  const groups = (() => {
    if (involvement !== "all") return [{ key: "others" as const, label: "", entries }];
    if (baselineEmpty) {
      return groupPullRequestsByInvolvement(entries, viewers);
    }
    const narrow = (rows: ReadonlyArray<EnvironmentPullRequestEntry> | undefined) =>
      rows === undefined || !hasLocalFilters
        ? rows
        : rows.filter((entry) =>
            matchesPullRequestFilters(entry, localFilters, pullRequestEntryViewer(entry, viewers)),
          );
    const narrowedAuthored = narrow(partitionsWanted ? (authored ?? held?.authored) : undefined);
    const narrowedReviewing = narrow(partitionsWanted ? (reviewing ?? held?.reviewing) : undefined);
    if (narrowedAuthored === undefined || narrowedReviewing === undefined) {
      return groupPullRequestsByInvolvement(entries, viewers);
    }
    return partitionPullRequestsWithPriority(entries, narrowedAuthored, narrowedReviewing);
  })();

  const entriesByStatsKey: ReadonlyMap<string, EnvironmentPullRequestEntry> = new Map(
    groups.flatMap((group) =>
      group.entries.map((entry) => [pullRequestEntryKey(entry), entry] as const),
    ),
  );
  const heldPullRequestsBySurface = new Map(
    groups.flatMap((group) =>
      group.entries.map((entry) => [pullRequestListEntryId(entry), entry] as const),
    ),
  );
  return {
    entries,
    listedPullRequestTabStatuses,
    groups,
    entriesByStatsKey,
    heldPullRequestsBySurface,
  };
}

/**
 * The pull requests either side of `current`. A walk keeps the order the list had when it began,
 * so a change that re-ranks once reviewed does not send the next step back over it; rows that
 * have left the list since are skipped.
 */
export function pullRequestQueueNeighbours<Key extends string>(input: {
  readonly walk: ReadonlyArray<Key> | null;
  readonly listed: ReadonlyArray<Key>;
  readonly current: Key | null;
}): {
  readonly keys: ReadonlyArray<Key>;
  readonly previous: Key | null;
  readonly next: Key | null;
} {
  const { walk, current } = input;
  const listed = new Set(input.listed);
  const order = walk !== null && current !== null && walk.includes(current) ? walk : input.listed;
  const keys = order.filter((key) => key === current || listed.has(key));
  const at = current === null ? -1 : keys.indexOf(current);
  if (at === -1) {
    // Like the sidebar: from nowhere, either way enters the list; from a row not in it, next does.
    return {
      keys,
      previous: current === null ? (keys.at(-1) ?? null) : null,
      next: keys[0] ?? null,
    };
  }
  return { keys, previous: keys[at - 1] ?? null, next: keys[at + 1] ?? null };
}
