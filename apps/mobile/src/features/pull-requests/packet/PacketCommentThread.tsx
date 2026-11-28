import { formatClipRange, unsentEntryIds } from "@t3tools/client-runtime/review-packet-comments";
import {
  isUnknownUnionMember,
  type ReviewCommentEntry,
  type ReviewCommentState,
  type ReviewCommentThread,
} from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { RelativeTime } from "../../../components/RelativeTime";
import { AppText as Text } from "../../../components/ui/AppText";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { Button } from "../../../components/ui/Button";
import * as Dialog from "../../../components/ui/Dialog";
import { cn } from "../../../lib/cn";
import { usePacketScreen } from "./packetContext";

const STATE_CHIP_CLASS: Record<ReviewCommentState, readonly [string, string]> = {
  pending: ["border border-border bg-transparent", "text-foreground-muted"],
  open: ["bg-subtle-strong", "text-foreground"],
  answered: ["bg-subtle", "text-adaptive-emerald-600-400"],
  resolved: ["bg-subtle", "text-foreground-muted"],
};

function CommentStateChip(props: { readonly state: ReviewCommentState }) {
  const gt = useGT();
  const label = {
    pending: gt("Not sent", { $context: "a review comment not yet sent to the agent" }),
    open: gt("Waiting on agent", { $context: "a review comment sent to the agent" }),
    answered: gt("Answered", { $context: "a review comment the agent answered" }),
    resolved: gt("Resolved", { $context: "a review comment the reviewer resolved" }),
  }[props.state];
  const [container, text] = STATE_CHIP_CLASS[props.state];
  return (
    <View className={cn("rounded-md px-1.5 py-0.5", container)}>
      <Text className={cn("text-2xs font-t3-medium", text)}>{label}</Text>
    </View>
  );
}

/** What a comment points at, when it is not the claim itself; a tap opens it where it can. */
function AnchorLabel(props: {
  readonly thread: ReviewCommentThread;
  readonly onOpen?: (() => void) | undefined;
}) {
  const gt = useGT();
  const anchor = props.thread.anchor;
  if (isUnknownUnionMember(anchor) || anchor.kind === "claim") return null;
  const range = props.thread.currentClip ?? (anchor.kind === "video-range" ? anchor : null);
  const label =
    anchor.kind === "image-region"
      ? anchor.region === undefined
        ? gt("Screenshot")
        : gt("Area of a screenshot")
      : anchor.kind === "video-range" && range !== null
        ? anchor.region === undefined
          ? formatClipRange(range)
          : gt("{range} with an area", { range: formatClipRange(range) })
        : anchor.kind === "code-range"
          ? `${anchor.path}:${anchor.startLine === anchor.endLine ? anchor.startLine : `${anchor.startLine}-${anchor.endLine}`}`
          : null;
  if (label === null) return null;
  const icon =
    anchor.kind === "image-region"
      ? "photo"
      : anchor.kind === "video-range"
        ? "play"
        : "chevron.left.forwardslash.chevron.right";
  const content = (
    <>
      <SymbolView name={icon} size={12} tintColorClassName="accent-icon-muted" />
      <Text
        className={cn(
          "min-w-0 shrink text-xs text-foreground-muted",
          anchor.kind !== "image-region" && "font-mono",
        )}
        numberOfLines={1}
      >
        {label}
      </Text>
    </>
  );
  return props.onOpen === undefined ? (
    <View className="min-w-0 shrink flex-row items-center gap-1">{content}</View>
  ) : (
    <Pressable
      accessibilityRole="button"
      onPress={props.onOpen}
      className="min-h-8 min-w-0 shrink flex-row items-center gap-1 active:opacity-60"
    >
      {content}
    </Pressable>
  );
}

function AgentEntry(props: { readonly entry: Extract<ReviewCommentEntry, { author: "agent" }> }) {
  const gt = useGT();
  const { entry } = props;
  return (
    <View className="gap-0.5 border-l-2 border-border pl-2">
      <View className="flex-row items-center gap-1">
        <SymbolView name="robot" size={12} tintColorClassName="accent-icon-muted" />
        <Text className="text-xs font-t3-medium">
          {entry.kind === "fixed" ? (
            entry.fixedIn === undefined ? (
              gt("Fixed", { $context: "the agent's answer to a review comment" })
            ) : (
              <T context="the agent's answer to a review comment, then a commit">
                Fixed in <Var>{entry.fixedIn.slice(0, 7)}</Var>
              </T>
            )
          ) : entry.kind === "answered" ? (
            gt("Answered", { $context: "the agent's answer to a review comment" })
          ) : (
            gt("Disagrees", { $context: "the agent's answer to a review comment" })
          )}
        </Text>
        <Text className="text-2xs text-foreground-tertiary">
          <RelativeTime timestamp={entry.createdAt} />
        </Text>
      </View>
      <Text selectable className="text-sm text-foreground">
        {entry.text}
      </Text>
    </View>
  );
}

function PersonEntry(props: {
  readonly thread: ReviewCommentThread;
  readonly entry: Extract<ReviewCommentEntry, { author: "person" }>;
  readonly unsent: boolean;
  readonly context: string;
}) {
  const gt = useGT();
  const model = usePacketScreen();
  const { thread, entry } = props;
  const editable = props.unsent && model.comments.canWrite;
  const remove = () =>
    Dialog.alert(
      gt("Delete this comment?"),
      gt("It has not been sent, so the agent never sees it."),
      [
        { text: gt("Cancel"), style: "cancel" },
        {
          text: gt("Delete"),
          style: "destructive",
          onPress: () => void model.actions.remove(thread.id, entry.id),
        },
      ],
    );
  return (
    <View className="gap-0.5">
      <Text selectable className="text-sm text-foreground">
        {entry.text}
      </Text>
      <View className="min-h-6 flex-row items-center gap-1">
        <Text className="text-2xs text-foreground-tertiary">
          <RelativeTime timestamp={entry.createdAt} />
        </Text>
        {props.unsent && thread.entries[0]?.id !== entry.id ? (
          <Text className="text-2xs text-foreground-tertiary">
            · {gt("Not sent", { $context: "a review comment not yet sent to the agent" })}
          </Text>
        ) : null}
        {editable ? (
          <View className="ml-auto flex-row items-center gap-1">
            <Button
              size="compact"
              tone="text"
              icon="pencil"
              label={gt("Edit", { $context: "button, edits an unsent review comment" })}
              accessibilityLabel={gt("Edit comment")}
              onPress={() =>
                model.openComposer(
                  { kind: "edit", commentId: thread.id, entryId: entry.id, text: entry.text },
                  props.context,
                )
              }
            />
            <Button
              size="compact"
              tone="text"
              icon="trash"
              label={gt("Delete")}
              accessibilityLabel={gt("Delete comment")}
              onPress={remove}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** One comment: what the reviewer said, what the agent answered, and what comes next. */
export function PacketCommentThread(props: {
  readonly thread: ReviewCommentThread;
  /** What the comment is on, in words, for the sheets it opens. */
  readonly context: string;
  readonly onOpenAnchor?: (() => void) | undefined;
  readonly showAnchor?: boolean;
}) {
  const gt = useGT();
  const model = usePacketScreen();
  const { thread } = props;
  const unsent = unsentEntryIds(thread);
  const canAct = model.comments.canWrite && thread.state !== "pending";
  return (
    <View className="gap-2 rounded-2xl border border-border-subtle bg-grouped-card px-3 py-2.5">
      <View className="flex-row items-center gap-2">
        <CommentStateChip state={thread.state} />
        {props.showAnchor === false ? null : (
          <AnchorLabel thread={thread} onOpen={props.onOpenAnchor} />
        )}
        {canAct ? (
          <View className="ml-auto">
            <Button
              size="compact"
              tone="text"
              icon={thread.state === "resolved" ? "arrow.uturn.backward" : "checkmark"}
              label={
                thread.state === "resolved"
                  ? gt("Reopen", { $context: "button, reopens a resolved review comment" })
                  : gt("Resolve", { $context: "button, resolves a review comment" })
              }
              onPress={() => void model.actions.setResolved(thread.id, thread.state !== "resolved")}
            />
          </View>
        ) : null}
      </View>
      {thread.entries.map((entry) =>
        entry.author === "person" ? (
          <PersonEntry
            key={entry.id}
            thread={thread}
            entry={entry}
            unsent={unsent.has(entry.id)}
            context={props.context}
          />
        ) : (
          <AgentEntry key={entry.id} entry={entry} />
        ),
      )}
      {canAct ? (
        <View className="flex-row">
          <Button
            size="compact"
            tone="text"
            icon="arrow.uturn.backward"
            label={gt("Reply", {
              $context: "button, opens a follow-up box under a review comment",
            })}
            onPress={() =>
              model.openComposer({ kind: "reply", commentId: thread.id }, props.context)
            }
          />
        </View>
      ) : null}
    </View>
  );
}

/** Comments in the order they were written; resolved ones fold away unless the filter asks for them. */
export function PacketCommentThreadList(props: {
  readonly threads: ReadonlyArray<ReviewCommentThread>;
  readonly context: string;
  readonly onOpenAnchor?: (thread: ReviewCommentThread) => (() => void) | undefined;
  readonly showAnchor?: boolean;
}) {
  const gt = useGT();
  const model = usePacketScreen();
  const [resolvedShown, setResolvedShown] = useState(false);
  const shown =
    model.filter === null
      ? props.threads
      : props.threads.filter((thread) => thread.state === model.filter);
  const fold = model.filter === null;
  const open = fold ? shown.filter((thread) => thread.state !== "resolved") : shown;
  const resolved = fold ? shown.filter((thread) => thread.state === "resolved") : [];
  if (shown.length === 0) return null;
  const render = (thread: ReviewCommentThread) => (
    <PacketCommentThread
      key={thread.id}
      thread={thread}
      context={props.context}
      onOpenAnchor={props.onOpenAnchor?.(thread)}
      showAnchor={props.showAnchor}
    />
  );
  return (
    <View className="gap-2">
      {open.map(render)}
      {resolved.length > 0 ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: resolvedShown }}
            onPress={() => setResolvedShown((value) => !value)}
            className="min-h-8 flex-row items-center gap-1 self-start active:opacity-60"
          >
            <SymbolView
              name={resolvedShown ? "chevron.down" : "chevron.right"}
              size={11}
              tintColorClassName="accent-icon-muted"
            />
            <Text className="text-xs text-foreground-muted">
              {gt(
                "{count, plural, one {{count} resolved comment} other {{count} resolved comments}}",
                { count: resolved.length },
              )}
            </Text>
          </Pressable>
          {resolvedShown ? resolved.map(render) : null}
        </>
      ) : null}
    </View>
  );
}
