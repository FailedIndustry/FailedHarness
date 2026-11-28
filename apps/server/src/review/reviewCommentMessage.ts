import type {
  ReviewCommentAnswerKind,
  ReviewRegion,
  ReviewVideoRangeLocation,
} from "@t3tools/contracts";

/** One comment as the agent reads it, with everything the server looked up for it. */
export interface ReviewCommentForAgent {
  readonly id: string;
  readonly claim?: { readonly id: string; readonly title: string | null };
  readonly where:
    | {
        readonly kind: "claim";
        readonly statement: string | null;
      }
    | {
        readonly kind: "code-range";
        readonly path: string;
        readonly side: "old" | "new";
        readonly startLine: number;
        readonly endLine: number;
        readonly commit: string;
        readonly excerpt: ReadonlyArray<{ readonly line: number; readonly text: string }> | null;
      }
    | {
        readonly kind: "image-region";
        readonly file: MediaFile;
        readonly region: ReviewRegion | null;
      }
    | {
        readonly kind: "video-range";
        readonly file: MediaFile;
        readonly startMs: number;
        readonly endMs: number;
        readonly recording: {
          readonly media: string;
          readonly path: string | null;
          readonly startMs: number;
          readonly endMs: number;
        } | null;
        readonly region: ReviewRegion | null;
        /** Set when the latest packet has the range in another clip. */
        readonly recut: (ReviewVideoRangeLocation & { readonly path: string | null }) | null;
      }
    | { readonly kind: "unknown"; readonly anchorKind: string };
  readonly outdated: boolean;
  /** What the agent already saw or said, oldest first. */
  readonly earlier: ReadonlyArray<AgentVisibleEntry>;
  /** The person's words that are new to the agent. */
  readonly latest: ReadonlyArray<string>;
}

export type AgentVisibleEntry =
  | { readonly author: "person"; readonly text: string }
  | {
      readonly author: "agent";
      readonly kind: ReviewCommentAnswerKind;
      readonly text: string;
      readonly fixedIn: string | null;
    };

interface MediaFile {
  readonly media: string;
  /** Absolute path on this machine; null when the store no longer has the file. */
  readonly path: string | null;
  readonly type: string | null;
  readonly width: number | null;
  readonly height: number | null;
}

export interface ReviewChangeForAgent {
  readonly repository: string;
  readonly branch: string;
  readonly pullRequest: number | null;
  readonly latestHead: string | null;
  readonly comments: ReadonlyArray<ReviewCommentForAgent>;
}

const REVIEW_COMMENT_CLAIMS_GUIDANCE =
  "The claims describe the change as it is today. Rewrite, split, merge or drop them whenever the change is better explained another way. A comment asks for an outcome; it does not ask for its claim to survive.";

const ANSWER_GUIDANCE =
  "Answer each comment by its id with the `answer_review_comment` tool: `fixed` with the commit the fix is in, `answered` when nothing needs to change, or `disagrees` with your reason. After a fix, re-run only the evidence the fix affects and submit a new packet. Never resolve a comment and never merge; the reviewer does both.";

const short = (sha: string) => sha.slice(0, 12);

const indent = (text: string) =>
  text
    .trim()
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");

const seconds = (ms: number) => `${(ms / 1000).toFixed(3)} s`;

const fixed = (value: number) => value.toFixed(3);

const regionText = (region: ReviewRegion | null, file: MediaFile, whole: string) => {
  if (region === null) return whole;
  const fractions = `x ${fixed(region.x)}-${fixed(region.x + region.width)}, y ${fixed(region.y)}-${fixed(region.y + region.height)} as fractions of the width and height`;
  if (file.width === null || file.height === null) return `region ${fractions}`;
  const px = (fraction: number, size: number) => Math.round(fraction * size);
  return `region ${fractions} (pixels x ${px(region.x, file.width)}-${px(region.x + region.width, file.width)}, y ${px(region.y, file.height)}-${px(region.y + region.height, file.height)} of ${file.width}x${file.height})`;
};

const fileText = (file: MediaFile) => {
  const type = file.type === null ? "" : ` (${file.type})`;
  return file.path === null
    ? `${file.media}${type}, which is no longer stored here`
    : `${file.path}${type}`;
};

const whereLines = (comment: ReviewCommentForAgent): ReadonlyArray<string> => {
  const where = comment.where;
  switch (where.kind) {
    case "claim":
      return [];
    case "code-range": {
      const lines =
        where.startLine === where.endLine
          ? `line ${where.startLine}`
          : `lines ${where.startLine}-${where.endLine}`;
      const head = `Where: ${where.path}, ${lines} of the ${where.side} side, at ${short(where.commit)}`;
      if (where.excerpt === null || where.excerpt.length === 0) return [head];
      const width = String(where.excerpt.at(-1)!.line).length;
      return [
        head,
        ...where.excerpt.map((line) => `    ${String(line.line).padStart(width)} | ${line.text}`),
      ];
    }
    case "image-region":
      return [
        `Where: image ${fileText(where.file)}, ${regionText(where.region, where.file, "the whole image")}`,
      ];
    case "video-range": {
      const parts = [
        `Where: clip ${fileText(where.file)}, ${seconds(where.startMs)} to ${seconds(where.endMs)} of the clip`,
      ];
      if (where.recording !== null) {
        const file = where.recording.path === null ? where.recording.media : where.recording.path;
        parts.push(
          `${seconds(where.recording.startMs)} to ${seconds(where.recording.endMs)} of the recording ${file}`,
        );
      }
      if (where.region !== null) parts.push(regionText(where.region, where.file, ""));
      const lines = [parts.join("; ")];
      if (where.recut !== null) {
        const file = where.recut.path === null ? where.recut.media : where.recut.path;
        lines.push(
          `In the latest packet the same range is ${seconds(where.recut.startMs)} to ${seconds(where.recut.endMs)} of clip ${file}`,
        );
      }
      return lines;
    }
    case "unknown":
      return [`Where: a ${where.anchorKind} anchor this server cannot describe`];
  }
};

const entryText = (entry: AgentVisibleEntry) => {
  if (entry.author === "person") return `  Reviewer:\n${indent(entry.text)}`;
  const label =
    entry.kind === "fixed"
      ? `You (fixed${entry.fixedIn === null ? "" : ` in ${short(entry.fixedIn)}`})`
      : entry.kind === "disagrees"
        ? "You (disagreed)"
        : "You (answered)";
  return `  ${label}:\n${indent(entry.text)}`;
};

const renderComment = (comment: ReviewCommentForAgent) => {
  const lines = [`### Comment ${comment.id}`];
  if (comment.where.kind === "claim") {
    const title = comment.claim?.title ?? null;
    lines.push(
      `On claim ${title === null ? "" : `"${title}" `}(${comment.claim?.id ?? "unknown"})`,
    );
    if (comment.where.statement !== null) lines.push(`Statement: ${comment.where.statement}`);
  } else if (comment.claim !== undefined) {
    const title = comment.claim.title;
    lines.push(`Under claim ${title === null ? "" : `"${title}" `}(${comment.claim.id})`);
  }
  lines.push(...whereLines(comment));
  if (comment.outdated) {
    lines.push("Outdated: the latest packet no longer has what this comment points at.");
  }
  if (comment.earlier.length > 0) {
    lines.push("Earlier:", ...comment.earlier.map(entryText));
  }
  lines.push(
    comment.earlier.length > 0 ? "Now:" : "Comment:",
    ...comment.latest.map((text) => `  Reviewer:\n${indent(text)}`),
  );
  return lines.join("\n");
};

const renderChange = (change: ReviewChangeForAgent) => {
  const pullRequest = change.pullRequest === null ? "" : ` (pull request #${change.pullRequest})`;
  const latest =
    change.latestHead === null ? "" : ` The latest review packet is at ${change.latestHead}.`;
  return [
    `## ${change.repository}, branch ${change.branch}${pullRequest}`,
    `${change.comments.length} ${change.comments.length === 1 ? "comment" : "comments"}.${latest}`,
    ...change.comments.map(renderComment),
  ].join("\n\n");
};

const MEDIA_GUIDANCE =
  "Media files are named by their hash, without an extension; the type is in parentheses. Copy one to a name with that extension if a tool needs one.";

const pointsAtMedia = (comment: ReviewCommentForAgent) =>
  comment.where.kind === "image-region" || comment.where.kind === "video-range";

/** The text the agent gets, as one message when a person sends and from `read_review_comments`. */
export const renderReviewComments = (changes: ReadonlyArray<ReviewChangeForAgent>): string => {
  const shown = changes.filter((change) => change.comments.length > 0);
  if (shown.length === 0) return "No review comments are waiting on you.";
  const media = shown.some((change) => change.comments.some(pointsAtMedia));
  return [
    "# Review comments",
    REVIEW_COMMENT_CLAIMS_GUIDANCE,
    ANSWER_GUIDANCE,
    ...(media ? [MEDIA_GUIDANCE] : []),
    ...shown.map(renderChange),
  ].join("\n\n");
};
