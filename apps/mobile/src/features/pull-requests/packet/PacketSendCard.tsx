import { useAtomValue } from "@effect/atom-react";
import { chooseSendTarget } from "@t3tools/client-runtime/review-packet-comments";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { msg, T, useGT, Var } from "gt-react-native";
import { useRef, useState } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import * as Dialog from "../../../components/ui/Dialog";
import { ListFilterMenu } from "../../layout/workspace/ListFilterMenu";
import { useSelectWorkspaceDetail } from "../../layout/workspace/useSelectWorkspaceDetail";
import { m } from "../../../i18n/messages";
import { useEnvironmentQuery } from "../../../state/query";
import { reviewCommentEnvironment } from "../../../state/reviewComments";
import { useAtomCommand } from "../../../state/use-atom-command";
import { usePacketScreen } from "./packetContext";
import { failureMessage, packetChangeRef } from "./usePacketComments";

interface SentNotice {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly delivery: "started" | "queued";
}

/**
 * While anything is unsent: how much, which thread it goes to, and the one action that sends it
 * all. The server names the threads that own the change; a person picks when several do.
 */
export function PacketSendCard() {
  const gt = useGT();
  const model = usePacketScreen();
  const environmentId = EnvironmentId.make(model.change.environmentId);
  const change = packetChangeRef(model.change);
  const unsent = model.comments.counts.unsent;
  const selectDetail = useSelectWorkspaceDetail();
  const [picked, setPicked] = useState<string | null>(null);
  const [notice, setNotice] = useState<SentNotice | null>(null);
  const pending = useRef(false);
  const [sending, setSending] = useState(false);
  const canSend = useAtomValue(reviewCommentEnvironment.send.permissionAtom(environmentId));
  const runSend = useAtomCommand(reviewCommentEnvironment.send, { reportFailure: false });
  const target = useEnvironmentQuery(
    unsent > 0 ? reviewCommentEnvironment.sendTarget({ environmentId, input: change }) : null,
  );
  if (!model.comments.canWrite || (unsent === 0 && notice === null)) return null;
  const candidates = target.data?.candidates ?? [];
  const chosen = chooseSendTarget(candidates, picked);
  const openThread = (threadId: ThreadId) =>
    selectDetail({
      name: "Thread",
      params: { environmentId: model.change.environmentId, threadId: String(threadId) },
    });

  const send = async () => {
    if (chosen === null || pending.current) return;
    pending.current = true;
    setSending(true);
    const result = await runSend({
      environmentId,
      input: { ...change, threadId: chosen.threadId, source: "mobile" },
    });
    pending.current = false;
    setSending(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        Dialog.alert(m(msg("Could not send the comments")), failureMessage(result));
      }
      return;
    }
    const sent = result.value;
    if (sent._tag === "sent") {
      model.actions.markSent(sent.threadId);
      setNotice({ threadId: sent.threadId, title: chosen.title, delivery: sent.delivery });
    } else {
      target.refresh();
    }
  };

  if (unsent === 0 && notice !== null) {
    return (
      <View
        accessibilityLiveRegion="polite"
        className="gap-2 rounded-2xl border border-border-subtle bg-grouped-card p-3"
      >
        <Text className="text-sm text-foreground">
          <T>
            Sent to <Var>{notice.title}</Var>.
          </T>{" "}
          <Text className="text-foreground-muted">
            {notice.delivery === "queued"
              ? gt("It will read them after its current turn.")
              : gt("It is reading them now.")}
          </Text>
        </Text>
        <View className="flex-row gap-2">
          <Button
            size="compact"
            label={gt("Open thread")}
            onPress={() => openThread(notice.threadId)}
          />
          <Button
            size="compact"
            tone="text"
            label={gt("Dismiss")}
            onPress={() => setNotice(null)}
          />
        </View>
      </View>
    );
  }

  return (
    <View className="gap-2 rounded-2xl border border-border-subtle bg-grouped-card p-3">
      <Text className="text-sm font-t3-semibold">
        {gt("{count, plural, one {{count} comment not sent} other {{count} comments not sent}}", {
          count: unsent,
        })}
      </Text>
      {target.data === null ? (
        target.error === null ? (
          <View className="flex-row items-center gap-2">
            <AppActivityIndicator size="small" />
            <Text className="text-xs text-foreground-muted">
              {gt("Finding the thread that owns this change…")}
            </Text>
          </View>
        ) : (
          <Text className="text-xs text-danger-foreground">{target.error}</Text>
        )
      ) : chosen === null ? (
        <View className="gap-2">
          <Text className="text-xs text-foreground-muted">
            <T>
              No thread works on <Var>{model.change.branch}</Var> yet. Start a thread on this pull
              request or check its branch out in a worktree, then send here.
            </T>
          </Text>
          <View className="flex-row">
            <Button size="compact" tone="text" label={gt("Check again")} onPress={target.refresh} />
          </View>
        </View>
      ) : candidates.length > 1 ? (
        <View className="flex-row flex-wrap items-center gap-2">
          <Text className="text-xs text-foreground-muted">
            {gt("Goes to", {
              $context: "label before a picker of threads to send review comments to",
            })}
          </Text>
          <ListFilterMenu
            label={chosen.title}
            accessibilityLabel={gt("Thread to send to")}
            actions={candidates.map((candidate) => ({
              id: candidate.threadId,
              title: candidate.title,
              state: candidate.threadId === chosen.threadId ? ("on" as const) : ("off" as const),
            }))}
            onSelect={setPicked}
          />
        </View>
      ) : (
        <Text className="text-xs text-foreground-muted" numberOfLines={2}>
          {gt("Goes to {thread}", { thread: chosen.title })}
        </Text>
      )}
      <View className="flex-row">
        <Button
          tone="contrast"
          icon="paperplane"
          label={gt("Send to agent")}
          loading={sending}
          disabled={!canSend || chosen === null || sending}
          onPress={() => void send()}
        />
      </View>
    </View>
  );
}
