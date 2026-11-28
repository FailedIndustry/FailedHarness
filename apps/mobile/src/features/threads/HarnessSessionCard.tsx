import { useAtomValue } from "@effect/atom-react";
import { liveHarnessSessionForThread } from "@t3tools/client-runtime/state/harness";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { harnessEnvironment } from "../../state/harness";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentScope } from "../../state/session";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { HARNESS_MARK_WINDOWS, harnessSessionControls } from "./harness-session-controls";

type Thread = Parameters<typeof liveHarnessSessionForThread>[1];

/**
 * A thread's harness session: its state, Stop, and Mark. The stream itself plays in the
 * desktop and web apps; mobile only steers the session.
 */
export function HarnessSessionCard(props: {
  readonly environmentId: EnvironmentId;
  readonly thread: Thread;
}) {
  const gt = useGT();
  const snapshot = AsyncResult.getOrElse(
    useAtomValue(harnessEnvironment.snapshot({ environmentId: props.environmentId, input: {} })),
    () => null,
  );
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const stop = useAtomCommand(harnessEnvironment.stop, "harness stop");
  const mark = useAtomCommand(harnessEnvironment.mark, "harness mark");
  const [trackedId, setTrackedId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [lastSeconds, setLastSeconds] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const live = liveHarnessSessionForThread(snapshot, props.thread);
  if (live !== null && live.id !== trackedId) setTrackedId(live.id);
  const session =
    live ??
    (trackedId === null ? null : snapshot?.sessions.find((s) => s.id === trackedId)) ??
    null;
  if (session === null) return null;

  const controls = harnessSessionControls(session, canOperate);
  const phaseLabel = {
    starting: gt("Starting"),
    running: gt("Running"),
    stopping: gt("Stopping"),
    stopped: gt("Stopped"),
    failed: gt("Failed"),
  }[session.phase];
  const markReason = {
    "not-recorded": gt("This session is not recorded, so marks are off."),
    "not-running": gt("Marks are available once the session is running."),
    "no-permission": gt("You do not have permission to mark this session."),
  };

  const confirmStop = () =>
    Dialog.confirm({
      title: gt("Stop this session?"),
      confirmText: gt("Stop"),
      cancelText: gt("Cancel"),
      destructive: true,
      onConfirm: () => {
        void stop({
          environmentId: props.environmentId,
          input: { sessionId: session.id },
        }).then((result) => {
          if (result._tag === "Failure") Dialog.alert(gt("Could not stop the session"));
        });
      },
    });

  const sendMark = () => {
    const text = note.trim();
    if (text.length === 0 || busy) return;
    setBusy(true);
    void mark({
      environmentId: props.environmentId,
      input: {
        sessionId: session.id,
        note: text,
        ...(lastSeconds === null ? {} : { lastSeconds }),
      },
    }).then((result) => {
      setBusy(false);
      if (result._tag === "Failure") Dialog.alert(gt("Could not add the mark"));
      else setNote("");
    });
  };

  return (
    <View className="mx-4 mb-3 gap-3 rounded-2xl bg-grouped-card px-4 py-3">
      <View className="gap-1">
        <Text className="font-t3-medium text-foreground">
          {gt("Harness session: {phase}", { phase: phaseLabel })}
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          {[
            session.by === "agent" ? gt("Started by an agent") : gt("Started by a person"),
            session.net === "isolated" ? gt("Isolated network") : gt("Direct network"),
            session.recorded ? gt("Recorded") : gt("Not recorded"),
            gt("{count, plural, one {{count} mark} other {{count} marks}}", {
              count: session.markCount,
            }),
          ].join(" · ")}
        </Text>
        {session.outbound ? (
          <Text textRole="footnote" className="text-danger-foreground">
            {gt("Outbound connections are possible from this session.")}
          </Text>
        ) : null}
        {session.error !== null ? (
          <Text textRole="footnote" className="text-danger-foreground">
            {session.error}
          </Text>
        ) : null}
        {session.packet !== null ? (
          <Text
            textRole="footnote"
            className={
              session.packet.status === "failed"
                ? "text-danger-foreground"
                : "text-foreground-muted"
            }
          >
            {session.packet.status === "stored"
              ? gt("Packet stored: {detail}", { detail: session.packet.detail })
              : gt("Packet failed: {detail}", { detail: session.packet.detail })}
          </Text>
        ) : null}
        {session.streamed && controls.live ? (
          <Text textRole="footnote" className="text-foreground-muted">
            {gt("Open this thread in the desktop or web app to play the stream.")}
          </Text>
        ) : null}
      </View>

      {controls.live ? (
        <>
          <View className="gap-2">
            <TextInput
              accessibilityLabel={gt("Mark note")}
              placeholder={gt("Note for a mark")}
              value={note}
              maxLength={500}
              editable={controls.markBlock === null}
              onChangeText={setNote}
              onSubmitEditing={sendMark}
            />
            <View className="flex-row flex-wrap gap-2">
              {HARNESS_MARK_WINDOWS.map((seconds) => (
                <Button
                  key={seconds ?? "none"}
                  size="compact"
                  tone={lastSeconds === seconds ? "primary" : "secondary"}
                  disabled={controls.markBlock !== null}
                  label={seconds === null ? gt("Just now") : gt("Last {seconds}s", { seconds })}
                  onPress={() => setLastSeconds(seconds)}
                />
              ))}
            </View>
            {controls.markBlock !== null ? (
              <Text textRole="footnote" className="text-foreground-muted">
                {markReason[controls.markBlock]}
              </Text>
            ) : null}
          </View>
          <View className="flex-row gap-2">
            <Button
              label={gt("Add mark")}
              loading={busy}
              disabled={controls.markBlock !== null || note.trim().length === 0}
              onPress={sendMark}
            />
            <Button
              label={gt("Stop")}
              tone="danger"
              disabled={!controls.canStop}
              onPress={confirmStop}
            />
          </View>
        </>
      ) : (
        <Button label={gt("Dismiss")} tone="text" onPress={() => setTrackedId(null)} />
      )}
    </View>
  );
}
