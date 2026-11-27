import type { ReviewEvidence, ReviewPacket } from "@t3tools/contracts";

export type PacketMediaEntry = ReviewPacket["media"][number];
export type PacketClaim = ReviewPacket["claims"][number];
export type PacketCheck = Extract<ReviewEvidence, { kind: "check" }>;

export interface PacketVisual {
  readonly evidenceId: string;
  readonly kind: "clip" | "image";
  readonly mediaId: string;
  readonly caption: string | null;
  readonly media: PacketMediaEntry | null;
}

/** How many media a claim shows in its row before the rest go behind a "more" tile. */
export const PACKET_LEAD_MEDIA = 4;

/** The packet the server keeps for this branch, unless it names a different pull request. */
export function packetForPullRequest(
  packet: ReviewPacket | null,
  number: number,
): ReviewPacket | null {
  if (packet === null) return null;
  const named = packet.change.pullRequest;
  return named === undefined || named === number ? packet : null;
}

/** Clips lead, then screenshots, each in the packet's own order; checks are not media. */
export function packetVisuals(
  evidence: ReadonlyArray<ReviewEvidence>,
  media: ReadonlyArray<PacketMediaEntry>,
): ReadonlyArray<PacketVisual> {
  const byId = new Map(media.map((entry) => [entry.id, entry]));
  const visual = (item: ReviewEvidence): PacketVisual | null =>
    item.kind === "check"
      ? null
      : {
          evidenceId: item.id,
          kind: item.kind,
          mediaId: item.media,
          caption: item.kind === "image" ? (item.caption ?? null) : null,
          media: byId.get(item.media) ?? null,
        };
  const visuals = evidence.flatMap((item) => visual(item) ?? []);
  return [
    ...visuals.filter((item) => item.kind === "clip"),
    ...visuals.filter((item) => item.kind === "image"),
  ];
}

export function packetChecks(evidence: ReadonlyArray<ReviewEvidence>): ReadonlyArray<PacketCheck> {
  return evidence.filter((item): item is PacketCheck => item.kind === "check");
}

export function claimDescription(claim: PacketClaim): string {
  const observed = claim.observed?.trim() ?? "";
  return observed === "" ? claim.statement : observed;
}

/** The pull request moved on after the packet was recorded. Unknown heads never count. */
export function isPacketBehind(packet: ReviewPacket, pullRequestHeadSha: string | undefined) {
  return (
    pullRequestHeadSha !== undefined &&
    pullRequestHeadSha.toLowerCase() !== packet.revision.head.toLowerCase()
  );
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

interface ParsedPathspec {
  readonly pattern: string;
  readonly exclude: boolean;
}

/**
 * Git's default pathspec rules for the forms a harness writes: a file, a folder (with or
 * without its slash), fnmatch wildcards where `*` also crosses `/`, `:/` and `:(top)`, and
 * exclusion (`:!`, `:^`, `:(exclude)`). Any other magic is returned as unsupported.
 */
function parsePathspec(spec: string): ParsedPathspec | null {
  let rest = spec;
  let exclude = false;
  if (rest.startsWith(":(")) {
    const close = rest.indexOf(")");
    if (close === -1) return null;
    for (const word of rest.slice(2, close).split(",")) {
      const magic = word.trim();
      if (magic === "exclude") exclude = true;
      else if (magic !== "top") return null;
    }
    rest = rest.slice(close + 1);
  } else if (rest.startsWith(":")) {
    let index = 1;
    while (index < rest.length && "/!^".includes(rest[index] ?? "")) {
      if (rest[index] !== "/") exclude = true;
      index += 1;
    }
    rest = rest.slice(index);
    if (rest.startsWith(":")) rest = rest.slice(1);
  }
  while (rest.startsWith("./")) rest = rest.slice(2);
  return { pattern: rest === "." ? "" : rest, exclude };
}

const WILDCARD = /[*?[]/u;

function fnmatchSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else if (char === "\\" && index + 1 < pattern.length) {
      index += 1;
      source += escapeRegExp(pattern[index] ?? "");
    } else if (char === "[") {
      const close = pattern.indexOf("]", index + 2);
      if (close === -1) {
        source += "\\[";
        continue;
      }
      let body = pattern.slice(index + 1, close);
      const negated = body.startsWith("!") || body.startsWith("^");
      if (negated) body = body.slice(1);
      source += `[${negated ? "^" : ""}${body.replace(/[\\\]]/gu, "\\$&")}]`;
      index = close;
    } else source += escapeRegExp(char);
  }
  return source;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
}

function matchesPattern(path: string, pattern: string): boolean {
  if (pattern === "") return true;
  if (!WILDCARD.test(pattern)) {
    const folder = pattern.endsWith("/") ? pattern : `${pattern}/`;
    return path === pattern || path.startsWith(folder);
  }
  return new RegExp(`^${fnmatchSource(pattern)}(?:/.*)?$`, "u").test(path);
}

export interface PathspecFilter {
  readonly matches: (path: string) => boolean;
  /** Pathspecs this reader cannot apply; a path they name is not matched. */
  readonly unsupported: ReadonlyArray<string>;
}

export function pathspecFilter(specs: ReadonlyArray<string>): PathspecFilter {
  const parsed = specs.map((spec) => ({ spec, parsed: parsePathspec(spec) }));
  const unsupported = parsed.flatMap((entry) => (entry.parsed === null ? [entry.spec] : []));
  const usable = parsed.flatMap((entry) => (entry.parsed === null ? [] : [entry.parsed]));
  const included = usable.filter((spec) => !spec.exclude);
  const excluded = usable.filter((spec) => spec.exclude);
  // Like git, exclusions alone narrow everything; nothing usable at all matches nothing.
  const includesAll = included.length === 0 && excluded.length > 0;
  return {
    unsupported,
    matches: (path) =>
      (includesAll || included.some((spec) => matchesPattern(path, spec.pattern))) &&
      !excluded.some((spec) => matchesPattern(path, spec.pattern)),
  };
}
