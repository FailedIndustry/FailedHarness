import {
  isUnknownUnionMember,
  type EnvironmentId,
  type ReviewCommentState,
  type ReviewCommentThread,
  type ReviewPacket,
  type ReviewPacketChangeRef,
} from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";
import {
  CheckIcon,
  ChevronRightIcon,
  CodeIcon,
  GitBranchIcon,
  MessageSquareIcon,
  OctagonAlertIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { RelativeTime } from "~/components/RelativeTime";
import { cn } from "~/lib/utils";

import { Alert, AlertDescription } from "../../ui/alert";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import { SharedTooltipTrigger } from "../../ui/shared-tooltip";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import { PacketClaimCode } from "./PacketClaimCode";
import {
  ClaimCommentAction,
  CommentThread,
  CommentThreadList,
  PacketCommentsProvider,
  usePacketComments,
} from "./PacketComments";
import { anchorClaimTitle, describeAnchor } from "./packetComments.logic";
import { PacketMediaRow } from "./PacketMedia";
import { PacketMediaViewer } from "./PacketMediaViewer";
import { PacketSendBar, type PacketCheckout } from "./PacketSendBar";
import {
  claimDescription,
  isPacketBehind,
  packetChecks,
  packetVisuals,
  shortSha,
  type PacketClaim,
  type PacketMediaEntry,
} from "./reviewPacket.logic";

type Finding = ReviewPacket["blockers"][number];

export function PullRequestPacketTab({
  environmentId,
  change,
  packet,
  pullRequestHeadSha,
  scrollerRef,
  checkout,
  onOpenCode,
}: {
  environmentId: EnvironmentId;
  change: ReviewPacketChangeRef;
  packet: ReviewPacket;
  pullRequestHeadSha: string | undefined;
  scrollerRef: (node: HTMLDivElement | null) => void;
  checkout: PacketCheckout | null;
  onOpenCode: (() => void) | null;
}) {
  const behind = isPacketBehind(packet, pullRequestHeadSha);
  return (
    <PacketCommentsProvider environmentId={environmentId} change={change} packet={packet}>
      <div
        ref={scrollerRef}
        tabIndex={-1}
        data-workspace-focus-default
        className="flex h-full flex-col overflow-y-auto scrollbar-gutter-both outline-none"
      >
        <div className="mx-auto flex w-full max-w-[60rem] flex-1 flex-col gap-5 px-4 pt-3">
          <div className="flex min-w-0 flex-col gap-2">
            <PacketHeader packet={packet} behind={behind} pullRequestHeadSha={pullRequestHeadSha} />
            <CommentOverview />
          </div>
          {packet.summary !== undefined && packet.summary.trim() !== "" ? (
            <p className="text-sm text-muted-foreground">{packet.summary}</p>
          ) : null}
          {packet.claims.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              <T>This packet makes no claims.</T>
            </p>
          ) : (
            <ol className="flex flex-col">
              {packet.claims.map((claim) => (
                <PacketClaimItem
                  key={claim.id}
                  environmentId={environmentId}
                  claim={claim}
                  media={packet.media}
                  behind={behind}
                  onOpenCode={onOpenCode}
                />
              ))}
            </ol>
          )}
          <PacketFindings
            kind="blockers"
            environmentId={environmentId}
            findings={packet.blockers}
            media={packet.media}
          />
          <PacketFindings
            kind="notes"
            environmentId={environmentId}
            findings={packet.notes}
            media={packet.media}
          />
          <OtherComments />
          <div className="pb-3" />
          <PacketSendBar checkout={checkout} />
        </div>
      </div>
      <PacketMediaViewer />
    </PacketCommentsProvider>
  );
}

const OVERVIEW_STATES: ReadonlyArray<ReviewCommentState> = [
  "pending",
  "open",
  "answered",
  "resolved",
];

/** Counts by state that also filter the comments shown; pressing the active one clears it. */
function CommentOverview() {
  const gt = useGT();
  const model = usePacketComments();
  const { counts } = model;
  if (model.error !== null) {
    return (
      <p className="text-xs text-muted-foreground">
        <T>
          Comments could not be loaded: <Var>{model.error}</Var>
        </T>
      </p>
    );
  }
  const shown = OVERVIEW_STATES.filter((state) => counts[state] > 0 || model.filter === state);
  if (shown.length === 0) return null;
  const label = (state: ReviewCommentState) => {
    const count = counts[state];
    switch (state) {
      case "pending":
        return gt("{count} not sent", { count });
      case "open":
        return gt("{count} waiting on agent", { count });
      case "answered":
        return gt("{count} answered", { count });
      case "resolved":
        return gt("{count} resolved", { count });
    }
  };
  return (
    <ToggleGroup
      variant="segmented"
      aria-label={gt("Show comments by state")}
      value={model.filter === null ? [] : [model.filter]}
      onValueChange={(next) => {
        const state = OVERVIEW_STATES.find((candidate) => candidate === next[0]);
        model.setFilter(state ?? null);
      }}
    >
      {shown.map((state) => (
        <Toggle key={state} value={state}>
          {label(state)}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

/** Comments whose anchor left the latest packet, and anchors this app cannot place. */
function OtherComments() {
  const gt = useGT();
  const resolve = useMessages();
  const model = usePacketComments();
  const onFindings = new Set(
    [...model.packet.blockers, ...model.packet.notes].flatMap((finding) =>
      (finding.evidence ?? []).flatMap((item) => (item.kind === "check" ? [] : [item.media])),
    ),
  );
  const unplaced = model.layout.outsideClaims.filter((thread) => {
    const anchor = thread.anchor;
    if (isUnknownUnionMember(anchor)) return false;
    return !(
      (anchor.kind === "image-region" || anchor.kind === "video-range") &&
      onFindings.has(thread.currentClip?.media ?? anchor.media)
    );
  });
  const other = [...unplaced, ...model.layout.unknown];
  const visible = (threads: ReadonlyArray<ReviewCommentThread>) =>
    model.filter === null ? threads : threads.filter((thread) => thread.state === model.filter);
  const outdated = visible(model.layout.outdated);
  const rest = visible(other);
  if (outdated.length === 0 && rest.length === 0) return null;
  const describe = (thread: ReviewCommentThread) => {
    const claim = anchorClaimTitle(thread, model.packet);
    return (
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
        <span className="min-w-0 break-words text-foreground/80">
          {describeAnchor(thread, resolve)}
        </span>
        {claim === null ? null : <span className="min-w-0 break-words">{claim}</span>}
      </p>
    );
  };
  return (
    <>
      {rest.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">{gt("Other comments")}</h3>
          <ul className="flex flex-col gap-2">
            {rest.map((thread) => (
              <li key={thread.id} className="flex min-w-0 flex-col gap-1">
                {describe(thread)}
                <CommentThread thread={thread} showAnchor={false} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {outdated.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">
            {gt("On earlier revisions")}
          </h3>
          <p className="text-xs text-muted-foreground">
            <T>
              The latest packet no longer has what these point at. They can still be answered,
              followed up and resolved.
            </T>
          </p>
          <ul className="flex flex-col gap-2">
            {outdated.map((thread) => (
              <li key={thread.id} className="flex min-w-0 flex-col gap-1">
                {describe(thread)}
                <CommentThread thread={thread} showAnchor={false} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function PacketHeader({
  packet,
  behind,
  pullRequestHeadSha,
}: {
  packet: ReviewPacket;
  behind: boolean;
  pullRequestHeadSha: string | undefined;
}) {
  const gt = useGT();
  const { checks, playtest, verdict } = packet.status;
  const playedBy =
    playtest === undefined
      ? "none"
      : playtest.by === "person"
        ? "person"
        : playtest.model === undefined
          ? "agent"
          : "model";
  return (
    <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground">
      <span className="flex min-w-0 items-center gap-1 font-mono">
        <GitBranchIcon aria-hidden className="size-3 shrink-0" />
        <span className="min-w-0 truncate">{packet.change.branch}</span>
      </span>
      <SharedTooltipTrigger
        render={<span className="font-mono tabular-nums" />}
        label={gt("Recorded against {base}..{head}", {
          base: packet.revision.base,
          head: packet.revision.head,
        })}
      >
        {shortSha(packet.revision.base)}..{shortSha(packet.revision.head)}
      </SharedTooltipTrigger>
      <span className="shrink-0">
        <T context="followed by a relative time such as 5m ago or just now">
          recorded{" "}
          <Var>
            <RelativeTime timestamp={packet.revision.recordedAt} />
          </Var>
        </T>
      </span>
      {checks === undefined ? null : (
        <Badge variant={checks.newFailures > 0 ? "error" : "success"}>
          {checks.newFailures > 0 ? <XIcon aria-hidden /> : <CheckIcon aria-hidden />}
          {checks.newFailures > 0
            ? gt(
                "{failures, plural, one {{failures} new failure} other {{failures} new failures}}, {passed} passed",
                { failures: checks.newFailures, passed: checks.passed },
              )
            : gt("{passed, plural, one {{passed} check passed} other {{passed} checks passed}}", {
                passed: checks.passed,
              })}
        </Badge>
      )}
      <Badge variant={verdict === "pass" ? "success" : verdict === "fail" ? "error" : "warning"}>
        {gt(
          "{verdict, select, pass {Passed} fail {Failed} other {Blocked}} · {by, select, model {played by {model}} agent {played by an agent} person {played by a person} other {not playtested}}",
          { verdict, by: playedBy, model: playtest?.model ?? "" },
        )}
      </Badge>
      {behind && pullRequestHeadSha !== undefined ? (
        <Badge variant="warning">
          {gt("Behind the latest push ({head})", { head: shortSha(pullRequestHeadSha) })}
        </Badge>
      ) : null}
    </header>
  );
}

function ClaimResult({ result }: { result: PacketClaim["result"] }) {
  const gt = useGT();
  if (result === "seen") {
    return (
      <CheckIcon
        role="img"
        aria-label={gt("Seen", { $context: "a claim the playtest saw happen" })}
        className="size-3.5 shrink-0 self-center text-muted-foreground"
      />
    );
  }
  return (
    <Badge variant={result === "not-seen" ? "error" : "warning"} className="self-center">
      {result === "not-seen"
        ? gt("Not seen", { $context: "a claim the playtest did not see happen" })
        : gt("Untested", { $context: "a claim the playtest did not try" })}
    </Badge>
  );
}

function PacketClaimItem({
  environmentId,
  claim,
  media,
  behind,
  onOpenCode,
}: {
  environmentId: EnvironmentId;
  claim: PacketClaim;
  media: ReadonlyArray<PacketMediaEntry>;
  behind: boolean;
  onOpenCode: (() => void) | null;
}) {
  const gt = useGT();
  const model = usePacketComments();
  const [codeOpen, setCodeOpen] = useState(false);
  const [threadsShown, setThreadsShown] = useState(true);
  const visuals = packetVisuals(claim.evidence, media);
  const checks = packetChecks(claim.evidence);
  const threads = model.layout.byClaim.get(claim.id) ?? [];
  const waiting = threads.filter((thread) => thread.state !== "resolved").length;
  const openAnchor = (thread: ReviewCommentThread) => {
    const anchor = thread.anchor;
    if (isUnknownUnionMember(anchor)) return undefined;
    if (anchor.kind === "code-range") return () => setCodeOpen(true);
    if (anchor.kind === "claim") return undefined;
    const at = visuals.findIndex(
      (visual) => visual.mediaId === (thread.currentClip?.media ?? anchor.media),
    );
    return at === -1
      ? undefined
      : () =>
          model.openViewer({
            visuals,
            index: at,
            name: claim.title,
            claimId: claim.id,
            threadId: thread.id,
          });
  };
  return (
    <li
      id={`packet-claim-${claim.id}`}
      data-packet-claim={claim.id}
      className="flex min-w-0 flex-col gap-2 border-border/60 py-4 first:pt-1 not-first:border-t"
    >
      <h3 className="flex min-w-0 items-start gap-2 text-sm font-semibold text-foreground">
        <span className="min-w-0 break-words">{claim.title}</span>
        <ClaimResult result={claim.result} />
        {threads.length > 0 ? (
          <Button
            size="micro"
            variant="ghost-muted"
            className="ml-auto self-center"
            aria-expanded={threadsShown}
            aria-label={
              threadsShown
                ? gt("{count, plural, one {Hide {count} comment} other {Hide {count} comments}}", {
                    count: threads.length,
                  })
                : gt("{count, plural, one {Show {count} comment} other {Show {count} comments}}", {
                    count: threads.length,
                  })
            }
            onClick={() => setThreadsShown((shown) => !shown)}
          >
            <MessageSquareIcon aria-hidden />
            <span className="tabular-nums">{waiting > 0 ? waiting : threads.length}</span>
          </Button>
        ) : null}
      </h3>
      {visuals.length > 0 ? (
        <PacketMediaRow
          environmentId={environmentId}
          visuals={visuals}
          name={claim.title}
          claimId={claim.id}
        />
      ) : null}
      <p className="text-sm text-foreground/90">{claimDescription(claim)}</p>
      {checks.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {checks.map((check) => (
            <li key={check.id} data-packet-evidence={check.id}>
              <Badge variant={check.passed ? "outline" : "error"}>
                {check.passed ? <CheckIcon aria-hidden /> : <XIcon aria-hidden />}
                <span className="font-mono">{check.name}</span>
                <span className="sr-only">
                  {check.passed
                    ? gt("passed", { $context: "a check" })
                    : gt("failed", { $context: "a check" })}
                </span>
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      {visuals.length === 0 && checks.length === 0 && claim.result === "seen" ? (
        <p className="text-xs text-muted-foreground">
          <T>No evidence recorded.</T>
        </p>
      ) : null}
      {claim.paths.length > 0 ? (
        <Collapsible open={codeOpen} onOpenChange={setCodeOpen}>
          <CollapsibleTrigger
            render={
              <Button
                size="sm-multiline"
                variant="ghost-muted"
                className="group -ml-2.5 max-w-full"
                aria-label={gt("Code for {paths}", { paths: claim.paths.join(", ") })}
              />
            }
          >
            <CodeIcon aria-hidden />
            <span className="min-w-0 text-left font-mono text-xs break-words">
              {claim.paths.join("  ")}
            </span>
            <ChevronRightIcon aria-hidden className="group-data-panel-open:rotate-90" />
          </CollapsibleTrigger>
          <CollapsiblePanel animate={false}>
            <PacketClaimCode
              claimId={claim.id}
              paths={claim.paths}
              behind={behind}
              onOpenCode={onOpenCode}
            />
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
      {threadsShown ? <CommentThreadList threads={threads} onOpenAnchor={openAnchor} /> : null}
      <ClaimCommentAction claimId={claim.id} />
    </li>
  );
}

function PacketFindings({
  kind,
  environmentId,
  findings,
  media,
}: {
  kind: "blockers" | "notes";
  environmentId: EnvironmentId;
  findings: ReadonlyArray<Finding>;
  media: ReadonlyArray<PacketMediaEntry>;
}) {
  const gt = useGT();
  if (findings.length === 0) return null;
  const blockers = kind === "blockers";
  return (
    <section className="flex flex-col gap-2">
      <h3
        className={cn(
          "flex items-center gap-1.5 text-xs font-medium",
          blockers ? "text-error-foreground" : "text-muted-foreground",
        )}
      >
        {blockers ? <OctagonAlertIcon aria-hidden className="size-3.5" /> : null}
        {blockers
          ? gt("{count, plural, one {Blocker} other {Blockers}}", { count: findings.length })
          : gt("{count, plural, one {Note} other {Notes}}", { count: findings.length })}
      </h3>
      <ul className="flex flex-col gap-2">
        {findings.map((finding, index) => {
          const visuals = packetVisuals(finding.evidence ?? [], media);
          const body = (
            <>
              <p className="text-sm">{finding.text}</p>
              {visuals.length > 0 ? (
                <PacketMediaRow
                  environmentId={environmentId}
                  visuals={visuals}
                  name={blockers ? gt("Blocker") : gt("Note")}
                  claimId={null}
                />
              ) : null}
              <FindingThreads visuals={visuals} />
            </>
          );
          return (
            // Findings carry no id; their place in the packet is their identity.
            <li key={finding.text} data-packet-finding={`${kind}:${index}`} className="min-w-0">
              {blockers ? (
                <Alert variant="error">
                  <OctagonAlertIcon />
                  <AlertDescription>
                    <div className="flex min-w-0 flex-col gap-2">{body}</div>
                  </AlertDescription>
                </Alert>
              ) : (
                <div className="flex min-w-0 flex-col gap-2 text-muted-foreground">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Comments on a finding's screenshots and clips; findings have no anchor of their own. */
function FindingThreads({ visuals }: { visuals: ReturnType<typeof packetVisuals> }) {
  const model = usePacketComments();
  const media = new Set(visuals.map((visual) => visual.mediaId));
  const threads = model.layout.outsideClaims.filter((thread) => {
    const anchor = thread.anchor;
    if (isUnknownUnionMember(anchor)) return false;
    return (
      (anchor.kind === "image-region" || anchor.kind === "video-range") &&
      media.has(thread.currentClip?.media ?? anchor.media)
    );
  });
  const openAnchor = (thread: ReviewCommentThread) => {
    const anchor = thread.anchor;
    if (isUnknownUnionMember(anchor) || anchor.kind === "claim" || anchor.kind === "code-range") {
      return undefined;
    }
    const at = visuals.findIndex(
      (visual) => visual.mediaId === (thread.currentClip?.media ?? anchor.media),
    );
    return at === -1
      ? undefined
      : () =>
          model.openViewer({ visuals, index: at, name: "", claimId: null, threadId: thread.id });
  };
  return <CommentThreadList threads={threads} onOpenAnchor={openAnchor} />;
}
