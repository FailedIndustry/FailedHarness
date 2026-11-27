import type {
  ReviewCommentAnchor,
  ReviewCommentAnswerKind,
  ReviewCommentEntry,
  ReviewCommentState,
  ThreadId,
} from "@t3tools/contracts";

/** A comment as stored: its change key ('' host when the forge is unknown) and every entry. */
export interface StoredReviewComment {
  readonly id: string;
  /** Creation order, as stored; absent before the first write. */
  readonly position?: number;
  readonly host: string;
  readonly repository: string;
  readonly branch: string;
  readonly anchor: ReviewCommentAnchor;
  readonly entries: ReadonlyArray<StoredReviewCommentEntry>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resolvedAt: string | null;
}

export type StoredReviewCommentEntry =
  | {
      readonly id: string;
      readonly author: "person";
      readonly text: string;
      readonly createdAt: string;
      readonly updatedAt: string;
      readonly sentAt: string | null;
      readonly sentToThreadId: ThreadId | null;
      readonly messageId: string | null;
    }
  | {
      readonly id: string;
      readonly author: "agent";
      readonly kind: ReviewCommentAnswerKind;
      readonly text: string;
      readonly fixedIn: string | null;
      readonly threadId: ThreadId | null;
      readonly createdAt: string;
    };

/** What the agent has seen or said: its own answers and every person's entry that was sent. */
export const deliveredEntries = (entries: ReadonlyArray<StoredReviewCommentEntry>) =>
  entries.filter((entry) => entry.author === "agent" || entry.sentAt !== null);

/** A person's entries still waiting for a send. */
const unsentEntries = (comment: Pick<StoredReviewComment, "entries">) =>
  comment.entries.filter(
    (entry): entry is Extract<StoredReviewCommentEntry, { readonly author: "person" }> =>
      entry.author === "person" && entry.sentAt === null,
  );

/**
 * Unsent follow-ups do not change the state: an answered comment stays answered until the
 * follow-up is sent, so the state always says who the agent is waiting on.
 */
export const deriveReviewCommentState = (
  comment: Pick<StoredReviewComment, "entries" | "resolvedAt">,
): ReviewCommentState => {
  const root = comment.entries[0];
  if (root === undefined || (root.author === "person" && root.sentAt === null)) return "pending";
  if (comment.resolvedAt !== null) return "resolved";
  return deliveredEntries(comment.entries).at(-1)?.author === "agent" ? "answered" : "open";
};

/** What a send would deliver for this comment; resolved comments send nothing. */
export const sendableEntries = (comment: StoredReviewComment) =>
  deriveReviewCommentState(comment) === "resolved" ? [] : unsentEntries(comment);

export const toWireEntry = (entry: StoredReviewCommentEntry): ReviewCommentEntry =>
  entry.author === "person"
    ? {
        id: entry.id,
        author: "person",
        text: entry.text,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        sentAt: entry.sentAt,
        sentToThreadId: entry.sentToThreadId,
      }
    : {
        id: entry.id,
        author: "agent",
        kind: entry.kind,
        text: entry.text,
        ...(entry.fixedIn === null ? {} : { fixedIn: entry.fixedIn }),
        threadId: entry.threadId,
        createdAt: entry.createdAt,
      };
