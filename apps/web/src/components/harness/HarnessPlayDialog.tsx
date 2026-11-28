import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { isLiveHarnessSession } from "@t3tools/client-runtime/state/harness";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  HARNESS_MARK_NOTE_MAX_CHARS,
  type HarnessNetwork,
  type HarnessPacketOutcome,
  type HarnessSession,
  type HarnessSessionId,
} from "@t3tools/contracts";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { MaximizeIcon, RefreshCwIcon, SquareIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { m, type MessageResolver } from "../../i18n/messages";
import { harnessEnvironment, harnessSnapshotAtom } from "../../state/harness";
import { useEnvironmentQuery } from "../../state/query";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useStableCallback } from "../../hooks/useStableCallback";
import { ensureHarnessApproved } from "../../worktreeLayoutApproval";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import {
  harnessViewerUrl,
  MARK_LAST_SECONDS_CHOICES,
  type HarnessCheckout,
} from "./harnessPlay.logic";
import { closeHarnessPlay, useHarnessPlayStore } from "./harnessPlayStore";

const failureMessage = (
  result: Extract<AtomCommandResult<unknown, unknown>, { _tag: "Failure" }>,
) =>
  isAtomCommandInterrupted(result)
    ? null
    : (thrownErrorMessage(squashAtomCommandFailure(result), m) ??
      m(msg("The harness request failed.")));

function phaseLabel(phase: HarnessSession["phase"], resolve: MessageResolver) {
  switch (phase) {
    case "starting":
      return resolve(msg("Starting", { $context: "harness session state" }));
    case "running":
      return resolve(msg("Running", { $context: "harness session state" }));
    case "stopping":
      return resolve(msg("Stopping", { $context: "harness session state" }));
    case "stopped":
      return resolve(msg("Stopped", { $context: "harness session state" }));
    case "failed":
      return resolve(msg("Failed", { $context: "harness session state" }));
  }
}

/** Plays a checkout's harness: starts a streamed session, shows it, marks moments, stops it. */
export function HarnessPlayDialogHost() {
  const { checkout, open } = useHarnessPlayStore();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeHarnessPlay();
      }}
    >
      <DialogPopup className="max-w-5xl" bottomStickOnMobile={false}>
        {checkout ? (
          <HarnessPlayView
            key={`${checkout.environmentId}:${checkout.projectId}:${checkout.worktreePath}`}
            checkout={checkout}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function HarnessPlayView({ checkout }: { checkout: HarnessCheckout }) {
  const gt = useGT();
  const resolve = useMessages();
  const { environmentId, projectId, worktreePath } = checkout;
  const snapshot = useEnvironmentQuery(harnessSnapshotAtom(environmentId)).data;
  const canOperate = useAtomValue(harnessEnvironment.start.permissionAtom(environmentId));
  const start = useAtomCommand(harnessEnvironment.start, { reportFailure: false });
  const stop = useAtomCommand(harnessEnvironment.stop, { reportFailure: false });
  const collect = useAtomCommand(harnessEnvironment.packet, { reportFailure: false });
  const [sessionId, setSessionId] = useState<HarnessSessionId | null>(null);
  const [started, setStarted] = useState<HarnessSession | null>(null);
  const [net, setNet] = useState<HarnessNetwork>("direct");
  // Null follows the network: recorded when isolated, not when direct.
  const [recordChoice, setRecordChoice] = useState<boolean | null>(null);
  const record = recordChoice ?? net === "isolated";
  const [busy, setBusy] = useState<"start" | "stop" | "packet" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collected, setCollected] = useState<HarnessPacketOutcome | null>(null);

  // Re-opening the view for a session already running attaches to it instead of starting one.
  const live = snapshot?.sessions.find(
    (session) =>
      isLiveHarnessSession(session) &&
      session.projectId === projectId &&
      session.worktreePath === worktreePath,
  );
  if (sessionId === null && busy === null && live !== undefined) setSessionId(live.id);
  const session =
    sessionId === null
      ? null
      : (snapshot?.sessions.find((entry) => entry.id === sessionId) ??
        (started?.id === sessionId ? started : null));

  const startSession = async () => {
    setBusy("start");
    setError(null);
    setCollected(null);
    const approval = await ensureHarnessApproved(checkout);
    if (approval.status !== "proceed") {
      setBusy(null);
      if (approval.status === "blocked") setError(approval.message);
      return;
    }
    const result = await start({
      environmentId,
      input: {
        projectId,
        worktreePath,
        by: "person",
        net,
        record,
        ...(checkout.threadId === null ? {} : { threadId: checkout.threadId }),
      },
    });
    setBusy(null);
    if (result._tag === "Failure") {
      setError(failureMessage(result));
      return;
    }
    setStarted(result.value);
    setSessionId(result.value.id);
  };

  const stopSession = async (id: HarnessSessionId) => {
    setBusy("stop");
    setError(null);
    const result = await stop({ environmentId, input: { sessionId: id } });
    setBusy(null);
    if (result._tag === "Failure") setError(failureMessage(result));
  };

  const collectPacket = async () => {
    setBusy("packet");
    setError(null);
    const result = await collect({ environmentId, input: { projectId, worktreePath } });
    setBusy(null);
    if (result._tag === "Failure") setError(failureMessage(result));
    else setCollected(result.value);
  };

  const startAgain = () => {
    setSessionId(null);
    setStarted(null);
    setCollected(null);
    setError(null);
  };

  const ended = session !== null && !isLiveHarnessSession(session);
  const packet = collected ?? session?.packet ?? null;

  return (
    <>
      <DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <DialogTitle>
            <T>Play this branch</T>
          </DialogTitle>
          {session ? (
            <Badge
              variant={
                session.phase === "failed"
                  ? "error"
                  : session.phase === "running"
                    ? "success"
                    : "outline"
              }
            >
              {phaseLabel(session.phase, resolve)}
            </Badge>
          ) : null}
        </div>
        <DialogDescription>
          <T>
            <Var>{checkout.projectTitle}</Var> in{" "}
            <code className="wrap-anywhere">
              <Var>{worktreePath}</Var>
            </code>
          </T>
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {session === null ? (
          <StartForm
            net={net}
            onNetChange={(next) => {
              setNet(next);
              setRecordChoice(null);
            }}
            record={record}
            onRecordChange={setRecordChoice}
            disabled={!canOperate || busy !== null}
            starting={busy === "start"}
            canOperate={canOperate}
            onStart={() => void startSession()}
          />
        ) : (
          <>
            {session.outbound && !ended ? (
              <Alert variant="warning">
                <TriangleAlertIcon />
                <AlertDescription>
                  <T>
                    This session can make outbound network connections: the game, its server and the
                    stream server share this machine's network.
                  </T>
                </AlertDescription>
              </Alert>
            ) : null}
            {ended ? null : <SessionStream checkout={checkout} session={session} />}
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">
                {session.net === "direct" ? <T>Direct network</T> : <T>Isolated network</T>}
              </Badge>
              <Badge variant={session.recorded ? "info" : "outline"}>
                {session.recorded ? <T>Recorded</T> : <T>Not recorded</T>}
              </Badge>
              {session.by === "agent" ? (
                <Badge variant="outline">
                  <T>Agent playtest</T>
                </Badge>
              ) : null}
              <span>
                {gt("{count, plural, =0 {No marks} one {{count} mark} other {{count} marks}}", {
                  count: session.markCount,
                })}
              </span>
              {ended ? null : (
                <Button
                  className="ms-auto"
                  size="sm"
                  variant="destructive-outline"
                  disabled={!canOperate || busy !== null || session.phase === "stopping"}
                  onClick={() => void stopSession(session.id)}
                >
                  {busy === "stop" || session.phase === "stopping" ? <Spinner /> : <SquareIcon />}
                  <T>Stop</T>
                </Button>
              )}
            </div>
            {session.phase === "failed" && session.error ? (
              <Alert variant="error">
                <TriangleAlertIcon />
                <AlertTitle>
                  <T>The session failed</T>
                </AlertTitle>
                <AlertDescription className="whitespace-pre-wrap wrap-anywhere">
                  {session.error}
                </AlertDescription>
              </Alert>
            ) : null}
            {ended ? null : (
              <MarkForm
                key={session.id}
                session={session}
                canOperate={canOperate}
                environmentId={environmentId}
              />
            )}
            {ended ? (
              <div className="flex flex-col gap-3">
                <PacketOutcome packet={packet} waiting={session.phase === "stopped"} />
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canOperate || busy !== null}
                    onClick={() => void collectPacket()}
                  >
                    {busy === "packet" ? <Spinner /> : <RefreshCwIcon />}
                    <T>Collect packet again</T>
                  </Button>
                  <Button size="sm" disabled={busy !== null} onClick={startAgain}>
                    <T>Start again</T>
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        )}
        {error ? (
          <p role="alert" className="whitespace-pre-wrap wrap-anywhere text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          <T>
            Closing this leaves the session running; its thread shows it in the sidebar. The picture
            comes over WebRTC straight from that machine, so this device needs a network route to
            it.
          </T>
        </p>
      </DialogPanel>
    </>
  );
}

function StartForm(props: {
  net: HarnessNetwork;
  onNetChange: (net: HarnessNetwork) => void;
  record: boolean;
  onRecordChange: (record: boolean) => void;
  disabled: boolean;
  starting: boolean;
  canOperate: boolean;
  onStart: () => void;
}) {
  const gt = useGT();
  return (
    <div className="flex flex-col gap-3">
      <RadioGroup
        aria-label={gt("Network")}
        disabled={props.disabled}
        value={props.net}
        onValueChange={(value) => {
          if (value === "direct" || value === "isolated") props.onNetChange(value);
        }}
      >
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-3 text-sm">
          <Radio value="direct" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="font-medium">
              <T>Direct</T>
            </span>
            <span className="text-xs text-muted-foreground">
              <T>
                The game and the stream can reach the internet. Fastest; not recorded unless you
                turn recording on.
              </T>
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-3 text-sm">
          <Radio value="isolated" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="font-medium">
              <T>Isolated</T>
            </span>
            <span className="text-xs text-muted-foreground">
              <T>No outbound network. Recorded unless you turn recording off. A bit slower.</T>
            </span>
          </span>
        </label>
      </RadioGroup>
      <label className="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-3 text-sm">
        <Switch
          checked={props.record}
          disabled={props.disabled}
          onCheckedChange={(checked) => props.onRecordChange(Boolean(checked))}
          aria-label={gt("Record the session")}
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium">
            <T>Record</T>
          </span>
          <span className="text-xs text-muted-foreground">
            <T>Marks need a recording. Recording costs the game some frames.</T>
          </span>
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={props.disabled} onClick={props.onStart}>
          {props.starting ? <Spinner /> : null}
          <T>Start session</T>
        </Button>
        {props.canOperate ? null : (
          <span className="text-xs text-muted-foreground">
            <T>This connection cannot start harness sessions.</T>
          </span>
        )}
      </div>
    </div>
  );
}

/** The stream page in a frame. Its address is minted once per session and kept across ticks. */
function SessionStream({
  checkout,
  session,
}: {
  checkout: HarnessCheckout;
  session: HarnessSession;
}) {
  const gt = useGT();
  const containerRef = useRef<HTMLDivElement>(null);
  const connection = usePreparedConnection(checkout.environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const mintViewer = useAtomCommand(harnessEnvironment.viewer, { reportFailure: false });
  const [attempt, setAttempt] = useState(0);
  const [viewer, setViewer] = useState<{
    readonly key: string;
    readonly src: string | null;
    readonly error: string | null;
  } | null>(null);
  const canView = session.viewable && session.phase === "running";
  const viewerKey = `${session.id}:${attempt}`;
  const mint = useStableCallback(async (sessionId: HarnessSessionId, key: string) => {
    const result = await mintViewer({
      environmentId: checkout.environmentId,
      input: { sessionId },
    });
    return result._tag === "Success"
      ? { key, src: harnessViewerUrl(httpBaseUrl, result.value.path), error: null }
      : { key, src: null, error: failureMessage(result) };
  });
  const sessionId = session.id;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mints a viewer token from the server once the session it is for is running, and again on Reconnect
  useEffect(() => {
    if (!canView) return;
    let cancelled = false;
    void mint(sessionId, viewerKey).then((next) => {
      if (!cancelled) setViewer(next);
    });
    return () => {
      cancelled = true;
    };
  }, [canView, sessionId, viewerKey, mint]);

  if (!session.streamed) {
    return (
      <p className="rounded-lg border bg-muted/40 px-3 py-6 text-center text-sm text-muted-foreground">
        <T>This session runs hidden, so there is nothing to watch. It records for the packet.</T>
      </p>
    );
  }
  const current = viewer?.key === viewerKey ? viewer : null;
  const src = current?.src ?? null;
  return (
    <div className="flex flex-col gap-2">
      <div
        ref={containerRef}
        className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg border bg-black text-sm text-white/70"
      >
        {src !== null && canView ? (
          <StreamFrame src={src} title={gt("Harness stream")} />
        ) : current?.error ? (
          <span className="px-4 text-center">{current.error}</span>
        ) : (
          <span className="flex items-center gap-2">
            <Spinner />
            {session.phase === "starting" ? (
              <T>Starting the harness…</T>
            ) : (
              <T>Connecting to the stream…</T>
            )}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="xs"
          variant="outline"
          disabled={src === null}
          onClick={() => void containerRef.current?.requestFullscreen()}
        >
          <MaximizeIcon />
          <T>Fullscreen</T>
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={!canView || current === null}
          onClick={() => setAttempt((value) => value + 1)}
        >
          <RefreshCwIcon />
          <T>Reconnect</T>
        </Button>
      </div>
    </div>
  );
}

function StreamFrame({ src, title }: { src: string; title: string }) {
  return (
    // oxlint-disable-next-line react/iframe-missing-sandbox -- the stream page is the environment's own, needs pointer lock and keyboard capture, and a sandbox would block its WebRTC client
    <iframe
      src={src}
      title={title}
      className="size-full border-0"
      allow="fullscreen; pointer-lock; keyboard-map; clipboard-read; clipboard-write; autoplay"
      allowFullScreen
    />
  );
}

function MarkForm({
  session,
  canOperate,
  environmentId,
}: {
  session: HarnessSession;
  canOperate: boolean;
  environmentId: HarnessCheckout["environmentId"];
}) {
  const gt = useGT();
  const mark = useAtomCommand(harnessEnvironment.mark, { reportFailure: false });
  const [note, setNote] = useState("");
  const [lastSeconds, setLastSeconds] = useState<string>("moment");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabled = canOperate && session.recorded && session.phase === "running";

  const submit = async () => {
    const trimmed = note.trim();
    if (!enabled || trimmed.length === 0 || saving) return;
    setSaving(true);
    setError(null);
    const seconds = lastSeconds === "moment" ? undefined : Number(lastSeconds);
    const result = await mark({
      environmentId,
      input: {
        sessionId: session.id,
        note: trimmed,
        ...(seconds === undefined ? {} : { lastSeconds: seconds }),
      },
    });
    setSaving(false);
    if (result._tag === "Failure") setError(failureMessage(result));
    else setNote("");
  };

  const choices: Record<string, string> = {
    moment: gt("This moment"),
    ...Object.fromEntries(
      MARK_LAST_SECONDS_CHOICES.map((seconds) => [
        String(seconds),
        gt("Last {seconds} seconds", { seconds }),
      ]),
    ),
  };

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="min-w-48 flex-1"
          size="sm"
          aria-label={gt("Mark note")}
          placeholder={gt("What you see, e.g. the door opens before the key is used")}
          maxLength={HARNESS_MARK_NOTE_MAX_CHARS}
          disabled={!enabled || saving}
          value={note}
          onChange={(event) => setNote(event.currentTarget.value)}
        />
        <Select
          value={lastSeconds}
          items={choices}
          disabled={!enabled || saving}
          onValueChange={(value) => {
            if (typeof value === "string") setLastSeconds(value);
          }}
        >
          <SelectTrigger size="sm" className="w-auto" aria-label={gt("Mark range")}>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {Object.entries(choices).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button type="submit" size="sm" disabled={!enabled || saving || note.trim().length === 0}>
          {saving ? <Spinner /> : null}
          <T context="verb, marks a moment of the recording">Mark</T>
        </Button>
      </div>
      {session.recorded ? null : (
        <p className="text-xs text-muted-foreground">
          <T>
            Marks need a recording, and this session is not recorded. Start a session with Record on
            to mark what you see.
          </T>
        </p>
      )}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function PacketOutcome({
  packet,
  waiting,
}: {
  packet: HarnessPacketOutcome | null;
  waiting: boolean;
}) {
  if (packet === null) {
    return waiting ? (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner size="sm" />
        <T>Collecting the review packet…</T>
      </p>
    ) : null;
  }
  return (
    <Alert variant={packet.status === "stored" ? "success" : "error"}>
      <AlertTitle>
        {packet.status === "stored" ? (
          <T>Review packet stored</T>
        ) : (
          <T>The review packet could not be collected</T>
        )}
      </AlertTitle>
      {packet.detail ? (
        <AlertDescription className="whitespace-pre-wrap wrap-anywhere">
          {packet.detail}
        </AlertDescription>
      ) : null}
    </Alert>
  );
}
