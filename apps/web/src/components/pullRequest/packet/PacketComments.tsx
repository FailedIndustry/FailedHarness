import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  isUnknownUnionMember,
  type EnvironmentId,
  type ReviewCommentAnchorInput,
  type ReviewCommentCounts,
  type ReviewCommentEntry,
  type ReviewCommentMutationResult,
  type ReviewCommentState,
  type ReviewCommentThread,
  type ReviewPacket,
  type ReviewPacketChangeRef,
  type ThreadId,
} from "@t3tools/contracts";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import {
  BotIcon,
  ChevronRightIcon,
  ImageIcon,
  MessageSquarePlusIcon,
  PencilIcon,
  RotateCcwIcon,
  CheckIcon,
  Trash2Icon,
  VideoIcon,
  CodeIcon,
} from "lucide-react";
import { createContext, use, useState, type ReactNode } from "react";

import { RelativeTime } from "~/components/RelativeTime";
import { m } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import { formatEnvironmentQueryError } from "~/state/query";
import {
  reviewCommentEnvironment,
  useChangeComments,
  useReviewCommentDrafts,
} from "~/state/reviewComments";
import { useAtomCommand } from "~/state/use-atom-command";
import { textDirection } from "~/textDirection";

import { isCommentSubmitShortcut } from "../../diffs/commentSubmitShortcut";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import { Textarea } from "../../ui/textarea";
import { toastManager } from "../../ui/toast";
import {
  applyOverlay,
  commentCounts,
  EMPTY_OVERLAY,
  formatClipRange,
  layoutPacketComments,
  overlayChange,
  unsentEntryIds,
  type CommentOverlay,
  type PacketCommentLayout,
} from "@t3tools/client-runtime/review-packet-comments";
import type { PacketVisual } from "@t3tools/client-runtime/review-packet";

export interface PacketViewerRequest {
  readonly visuals: ReadonlyArray<PacketVisual>;
  readonly index: number;
  readonly name: string;
  readonly claimId: string | null;
  readonly threadId: string | null;
}

export interface PacketCommentsModel {
  readonly environmentId: EnvironmentId;
  readonly change: ReviewPacketChangeRef;
  readonly packet: ReviewPacket;
  readonly canWrite: boolean;
  readonly loaded: boolean;
  readonly error: string | null;
  readonly threads: ReadonlyArray<ReviewCommentThread>;
  readonly layout: PacketCommentLayout;
  readonly counts: ReviewCommentCounts;
  readonly filter: ReviewCommentState | null;
  readonly setFilter: (filter: ReviewCommentState | null) => void;
  readonly create: (anchor: ReviewCommentAnchorInput, text: string) => Promise<boolean>;
  readonly edit: (thread: ReviewCommentThread, entryId: string, text: string) => Promise<boolean>;
  readonly remove: (thread: ReviewCommentThread, entryId: string) => Promise<boolean>;
  readonly reply: (thread: ReviewCommentThread, text: string) => Promise<boolean>;
  readonly setResolved: (thread: ReviewCommentThread, resolved: boolean) => Promise<boolean>;
  readonly markSent: (threadId: ThreadId) => void;
  readonly viewer: PacketViewerRequest | null;
  readonly openViewer: (request: PacketViewerRequest) => void;
  readonly closeViewer: () => void;
}

const PacketCommentsContext = createContext<PacketCommentsModel | null>(null);

export function usePacketComments(): PacketCommentsModel {
  const model = use(PacketCommentsContext);
  if (model === null) throw new Error("usePacketComments needs a PacketCommentsProvider.");
  return model;
}

/** The comments of the change whose packet is on screen, and every way to change them. */
export function PacketCommentsProvider({
  environmentId,
  change,
  packet,
  children,
}: {
  environmentId: EnvironmentId;
  change: ReviewPacketChangeRef;
  packet: ReviewPacket;
  children: ReactNode;
}) {
  const resolve = useMessages();
  const view = useChangeComments(environmentId, change);
  const [overlay, setOverlay] = useState<CommentOverlay>(EMPTY_OVERLAY);
  const [filter, setFilter] = useState<ReviewCommentState | null>(null);
  const [viewer, setViewer] = useState<PacketViewerRequest | null>(null);
  const canWrite = useAtomValue(reviewCommentEnvironment.create.permissionAtom(environmentId));
  const runCreate = useAtomCommand(reviewCommentEnvironment.create, { reportFailure: false });
  const runEdit = useAtomCommand(reviewCommentEnvironment.edit, { reportFailure: false });
  const runRemove = useAtomCommand(reviewCommentEnvironment.remove, { reportFailure: false });
  const runReply = useAtomCommand(reviewCommentEnvironment.reply, { reportFailure: false });
  const runSetResolved = useAtomCommand(reviewCommentEnvironment.setResolved, {
    reportFailure: false,
  });

  const data = view.data;
  const threads = data === null ? [] : applyOverlay(data.threads, overlay, data.updatedAt);
  const counts =
    data === null ? commentCounts([]) : data.complete ? commentCounts(threads) : data.counts;

  const settle = async <E,>(
    run: Promise<AtomCommandResult<ReviewCommentMutationResult, E>>,
    commentId: string | null,
    failure: string,
  ) => {
    const result = await run;
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: failure,
          description: formatEnvironmentQueryError(result.cause),
        });
      }
      return false;
    }
    const comment = result.value.comment;
    const id = comment?.id ?? commentId;
    if (id !== null) setOverlay((current) => overlayChange(current, id, comment, Date.now()));
    return true;
  };

  const model: PacketCommentsModel = {
    environmentId,
    change,
    packet,
    canWrite,
    loaded: data !== null,
    error: view.failure === null ? null : formatEnvironmentQueryError(view.failure, resolve),
    threads,
    layout: layoutPacketComments(threads, packet),
    counts,
    filter,
    setFilter,
    create: (anchor, text) =>
      settle(
        runCreate({ environmentId, input: { ...change, anchor, text } }),
        null,
        m(msg("Could not save the comment")),
      ),
    edit: (thread, entryId, text) =>
      settle(
        runEdit({ environmentId, input: { commentId: thread.id, entryId, text } }),
        thread.id,
        m(msg("Could not save the comment")),
      ),
    remove: (thread, entryId) =>
      settle(
        runRemove({ environmentId, input: { commentId: thread.id, entryId } }),
        thread.id,
        m(msg("Could not delete the comment")),
      ),
    reply: (thread, text) =>
      settle(
        runReply({ environmentId, input: { commentId: thread.id, text } }),
        thread.id,
        m(msg("Could not save the reply")),
      ),
    setResolved: (thread, resolved) =>
      settle(
        runSetResolved({ environmentId, input: { commentId: thread.id, resolved } }),
        thread.id,
        resolved ? m(msg("Could not resolve the comment")) : m(msg("Could not reopen the comment")),
      ),
    markSent: (threadId) => {
      const now = Date.now();
      setOverlay((current) => ({
        ...current,
        sent: { threadId, at: new Date(now).toISOString(), atMs: now },
      }));
    },
    viewer,
    openViewer: setViewer,
    closeViewer: () => setViewer(null),
  };

  return <PacketCommentsContext value={model}>{children}</PacketCommentsContext>;
}

function CommentStateChip({ state }: { state: ReviewCommentState }) {
  const gt = useGT();
  switch (state) {
    case "pending":
      return (
        <Badge variant="outline" size="sm">
          {gt("Not sent", { $context: "a review comment not yet sent to the agent" })}
        </Badge>
      );
    case "open":
      return (
        <Badge variant="info" size="sm">
          {gt("Waiting on agent", { $context: "a review comment sent to the agent" })}
        </Badge>
      );
    case "answered":
      return (
        <Badge variant="success" size="sm">
          {gt("Answered", { $context: "a review comment the agent answered" })}
        </Badge>
      );
    case "resolved":
      return (
        <Badge variant="secondary" size="sm">
          {gt("Resolved", { $context: "a review comment the reviewer resolved" })}
        </Badge>
      );
  }
}

/** A small label for what a comment points at, when it is not the claim itself. */
function AnchorLabel({
  thread,
  number,
  onOpen,
}: {
  thread: ReviewCommentThread;
  number?: number | undefined;
  onOpen?: (() => void) | undefined;
}) {
  const gt = useGT();
  const anchor = thread.anchor;
  if (isUnknownUnionMember(anchor) || anchor.kind === "claim") return null;
  const range = thread.currentClip ?? (anchor.kind === "video-range" ? anchor : null);
  const content =
    anchor.kind === "image-region" ? (
      <>
        <ImageIcon aria-hidden />
        {anchor.region === undefined ? gt("Screenshot") : gt("Area of a screenshot")}
      </>
    ) : anchor.kind === "video-range" && range !== null ? (
      <>
        <VideoIcon aria-hidden />
        <span className="font-mono tabular-nums">{formatClipRange(range)}</span>
        {anchor.region === undefined ? null : <span>{gt("with an area")}</span>}
      </>
    ) : anchor.kind === "code-range" ? (
      <>
        <CodeIcon aria-hidden />
        <span className="min-w-0 truncate font-mono">
          {anchor.path}:
          {anchor.startLine === anchor.endLine
            ? anchor.startLine
            : `${anchor.startLine}-${anchor.endLine}`}
        </span>
      </>
    ) : null;
  if (content === null) return null;
  const numbered = (
    <>
      {number === undefined ? null : <span className="tabular-nums">#{number}</span>}
      {content}
    </>
  );
  return onOpen === undefined ? (
    <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground [&_svg]:size-3.5">
      {numbered}
    </span>
  ) : (
    <Button size="micro" variant="ghost-muted" className="min-w-0" onClick={onOpen}>
      {numbered}
    </Button>
  );
}

/**
 * A text box whose words live in the drafts store, so a refresh of the comments under it, or
 * closing the viewer, never loses them. `Cmd/Ctrl+Enter` saves and `Esc` cancels.
 */
export function CommentComposer({
  draftKey,
  initialText = "",
  label,
  placeholder,
  submitLabel,
  autoFocus = true,
  onSubmit,
  onCancel,
}: {
  draftKey: string;
  initialText?: string;
  label: string;
  placeholder: string;
  submitLabel: string;
  autoFocus?: boolean;
  onSubmit: (text: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const gt = useGT();
  const draft = useReviewCommentDrafts((state) => state.drafts[draftKey]);
  const setDraft = useReviewCommentDrafts((state) => state.setDraft);
  const clearDraft = useReviewCommentDrafts((state) => state.clearDraft);
  const [saving, setSaving] = useState(false);
  const text = draft ?? initialText;
  const cancel = () => {
    clearDraft(draftKey);
    onCancel();
  };
  const submit = async () => {
    const value = text.trim();
    if (value === "" || saving) return;
    setSaving(true);
    const saved = await onSubmit(value);
    setSaving(false);
    if (saved) {
      clearDraft(draftKey);
      onCancel();
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-packet-composer={draftKey}>
      <Textarea
        size="sm"
        rows={2}
        value={text}
        dir={textDirection(text)}
        autoFocus={autoFocus}
        aria-label={label}
        placeholder={placeholder}
        disabled={saving}
        onChange={(event) => setDraft(draftKey, event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            cancel();
            return;
          }
          if (isCommentSubmitShortcut(event, text, saving)) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="flex flex-wrap items-center justify-end gap-1">
        <span className="mr-auto text-3xs text-muted-foreground/70">
          <T>⌘/Ctrl Enter to save</T>
        </span>
        <Button size="xs" variant="ghost-muted" onClick={cancel}>
          {gt("Cancel")}
        </Button>
        <Button size="xs" disabled={saving || text.trim() === ""} onClick={() => void submit()}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

function AgentKind({ entry }: { entry: Extract<ReviewCommentEntry, { author: "agent" }> }) {
  const gt = useGT();
  switch (entry.kind) {
    case "fixed":
      return entry.fixedIn === undefined ? (
        <span>{gt("Fixed", { $context: "the agent's answer to a review comment" })}</span>
      ) : (
        <T context="the agent's answer to a review comment, then a commit">
          Fixed in{" "}
          <Var>
            <code className="font-mono">{entry.fixedIn.slice(0, 7)}</code>
          </Var>
        </T>
      );
    case "answered":
      return <span>{gt("Answered", { $context: "the agent's answer to a review comment" })}</span>;
    case "disagrees":
      return <span>{gt("Disagrees", { $context: "the agent's answer to a review comment" })}</span>;
  }
}

function PersonEntry({
  thread,
  entry,
  unsent,
}: {
  thread: ReviewCommentThread;
  entry: Extract<ReviewCommentEntry, { author: "person" }>;
  unsent: boolean;
}) {
  const gt = useGT();
  const model = usePacketComments();
  const editKey = `edit:${entry.id}`;
  const hasDraft = useReviewCommentDrafts((state) => state.drafts[editKey] !== undefined);
  const [editing, setEditing] = useState(false);
  if (unsent && model.canWrite && (editing || hasDraft)) {
    return (
      <CommentComposer
        draftKey={editKey}
        initialText={entry.text}
        label={gt("Edit your comment")}
        placeholder={gt("Your comment")}
        submitLabel={gt("Save")}
        onSubmit={(text) => model.edit(thread, entry.id, text)}
        onCancel={() => setEditing(false)}
      />
    );
  }
  return (
    <div className="group/entry flex min-w-0 flex-col gap-0.5">
      <p
        className="min-w-0 text-sm whitespace-pre-wrap break-words"
        dir={textDirection(entry.text)}
      >
        {entry.text}
      </p>
      <div className="flex min-h-5 items-center gap-1 text-3xs text-muted-foreground">
        <RelativeTime timestamp={entry.createdAt} />
        {unsent && thread.entries[0]?.id !== entry.id ? (
          <span>
            · {gt("Not sent", { $context: "a review comment not yet sent to the agent" })}
          </span>
        ) : null}
        {unsent && model.canWrite ? (
          <span className="ml-auto flex items-center gap-0.5">
            <Button
              size="icon-micro"
              variant="ghost-muted"
              aria-label={gt("Edit comment")}
              onClick={() => setEditing(true)}
            >
              <PencilIcon aria-hidden />
            </Button>
            <Button
              size="icon-micro"
              variant="ghost-destructive"
              aria-label={gt("Delete comment")}
              onClick={() => void model.remove(thread, entry.id)}
            >
              <Trash2Icon aria-hidden />
            </Button>
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** One comment: what the reviewer said, what the agent answered, and what comes next. */
export function CommentThread({
  thread,
  number,
  selected = false,
  onSelect,
  onOpenAnchor,
  showAnchor = true,
}: {
  thread: ReviewCommentThread;
  number?: number | undefined;
  selected?: boolean;
  onSelect?: (() => void) | undefined;
  onOpenAnchor?: (() => void) | undefined;
  showAnchor?: boolean;
}) {
  const gt = useGT();
  const model = usePacketComments();
  const replyKey = `reply:${thread.id}`;
  const hasReplyDraft = useReviewCommentDrafts((state) => state.drafts[replyKey] !== undefined);
  const [replying, setReplying] = useState(false);
  const unsent = unsentEntryIds(thread);
  const canReply = model.canWrite && thread.state !== "pending";
  return (
    <article
      data-packet-comment={thread.id}
      data-state={thread.state}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-lg border border-border/60 bg-card/40 px-3 py-2",
        selected && "border-primary/60 ring-1 ring-primary/40",
      )}
      onClick={onSelect}
    >
      <header className="flex min-w-0 flex-wrap items-center gap-1.5">
        <CommentStateChip state={thread.state} />
        {showAnchor ? (
          <AnchorLabel thread={thread} number={number} onOpen={onOpenAnchor} />
        ) : number === undefined ? null : (
          <span className="text-xs text-muted-foreground tabular-nums">#{number}</span>
        )}
        {model.canWrite && thread.state !== "pending" ? (
          <Button
            size="micro"
            variant="ghost-muted"
            className="ml-auto"
            onClick={(event) => {
              event.stopPropagation();
              void model.setResolved(thread, thread.state !== "resolved");
            }}
          >
            {thread.state === "resolved" ? (
              <>
                <RotateCcwIcon aria-hidden />
                {gt("Reopen", { $context: "button, reopens a resolved review comment" })}
              </>
            ) : (
              <>
                <CheckIcon aria-hidden />
                {gt("Resolve", { $context: "button, resolves a review comment" })}
              </>
            )}
          </Button>
        ) : null}
      </header>
      <ol className="flex min-w-0 flex-col gap-2">
        {thread.entries.map((entry) => (
          <li key={entry.id} className="min-w-0">
            {entry.author === "person" ? (
              <PersonEntry thread={thread} entry={entry} unsent={unsent.has(entry.id)} />
            ) : (
              <div className="flex min-w-0 flex-col gap-0.5 border-s-2 border-primary/40 ps-2">
                <span className="flex items-center gap-1 text-xs font-medium text-foreground [&_svg]:size-3.5">
                  <BotIcon aria-hidden />
                  <AgentKind entry={entry} />
                  <span className="font-normal text-muted-foreground">
                    · <RelativeTime timestamp={entry.createdAt} />
                  </span>
                </span>
                <p
                  className="min-w-0 text-sm whitespace-pre-wrap break-words text-foreground/90"
                  dir={textDirection(entry.text)}
                >
                  {entry.text}
                </p>
              </div>
            )}
          </li>
        ))}
      </ol>
      {canReply && (replying || hasReplyDraft) ? (
        <CommentComposer
          draftKey={replyKey}
          label={gt("Reply to this comment")}
          placeholder={gt("Follow up…")}
          submitLabel={gt("Reply", { $context: "button, saves a follow-up to a review comment" })}
          onSubmit={(text) => model.reply(thread, text)}
          onCancel={() => setReplying(false)}
        />
      ) : canReply ? (
        <Button
          size="micro"
          variant="ghost-muted"
          className="self-start"
          onClick={(event) => {
            event.stopPropagation();
            setReplying(true);
          }}
        >
          {gt("Reply", { $context: "button, opens a follow-up box under a review comment" })}
        </Button>
      ) : null}
    </article>
  );
}

/** Threads in the order they were written; resolved ones fold away unless a filter asks for them. */
export function CommentThreadList({
  threads,
  numbers,
  selectedId,
  onSelect,
  onOpenAnchor,
  showAnchor = true,
}: {
  threads: ReadonlyArray<ReviewCommentThread>;
  numbers?: ReadonlyMap<string, number> | undefined;
  selectedId?: string | null | undefined;
  onSelect?: ((thread: ReviewCommentThread) => void) | undefined;
  onOpenAnchor?: ((thread: ReviewCommentThread) => (() => void) | undefined) | undefined;
  showAnchor?: boolean;
}) {
  const gt = useGT();
  const model = usePacketComments();
  const shown = model.filter === null ? threads : threads.filter((t) => t.state === model.filter);
  const foldResolved = model.filter === null;
  const open = foldResolved ? shown.filter((thread) => thread.state !== "resolved") : shown;
  const resolved = foldResolved ? shown.filter((thread) => thread.state === "resolved") : [];
  if (shown.length === 0) return null;
  const render = (thread: ReviewCommentThread) => (
    <li key={thread.id} className="min-w-0">
      <CommentThread
        thread={thread}
        number={numbers?.get(thread.id)}
        selected={selectedId === thread.id}
        onSelect={onSelect === undefined ? undefined : () => onSelect(thread)}
        onOpenAnchor={onOpenAnchor?.(thread)}
        showAnchor={showAnchor}
      />
    </li>
  );
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {open.length > 0 ? <ul className="flex min-w-0 flex-col gap-2">{open.map(render)}</ul> : null}
      {resolved.length > 0 ? (
        <Collapsible>
          <CollapsibleTrigger
            render={<Button size="micro" variant="ghost-muted" className="group -ml-1.5" />}
          >
            <ChevronRightIcon aria-hidden className="group-data-panel-open:rotate-90" />
            {gt(
              "{count, plural, one {{count} resolved comment} other {{count} resolved comments}}",
              {
                count: resolved.length,
              },
            )}
          </CollapsibleTrigger>
          <CollapsiblePanel animate={false}>
            <ul className="flex min-w-0 flex-col gap-2 pt-2">{resolved.map(render)}</ul>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </div>
  );
}

/** "Comment" under a claim: a quiet button that becomes a composer. */
export function ClaimCommentAction({ claimId }: { claimId: string }) {
  const gt = useGT();
  const model = usePacketComments();
  const draftKey = `new:claim:${claimId}`;
  const hasDraft = useReviewCommentDrafts((state) => state.drafts[draftKey] !== undefined);
  const [open, setOpen] = useState(false);
  if (!model.canWrite) return null;
  if (open || hasDraft) {
    return (
      <CommentComposer
        draftKey={draftKey}
        label={gt("Comment on this claim")}
        placeholder={gt("What should the agent know or change about this claim?")}
        submitLabel={gt("Comment", { $context: "verb, saves a review comment" })}
        onSubmit={(text) =>
          model.create({ kind: "claim", packetHead: model.packet.revision.head, claimId }, text)
        }
        onCancel={() => setOpen(false)}
      />
    );
  }
  return (
    <Button
      size="micro"
      variant="ghost-muted"
      className="-ml-1.5 self-start"
      onClick={() => setOpen(true)}
    >
      <MessageSquarePlusIcon aria-hidden />
      {gt("Comment", { $context: "button, starts a review comment on a claim" })}
    </Button>
  );
}
