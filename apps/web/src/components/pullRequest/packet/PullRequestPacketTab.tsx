import type { EnvironmentId, PullRequestRef, ReviewPacket } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import {
  CheckIcon,
  ChevronRightIcon,
  CodeIcon,
  GitBranchIcon,
  OctagonAlertIcon,
  XIcon,
} from "lucide-react";

import { RelativeTime } from "~/components/RelativeTime";
import { cn } from "~/lib/utils";

import { Alert, AlertDescription } from "../../ui/alert";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import { SharedTooltipTrigger } from "../../ui/shared-tooltip";
import { PacketClaimCode } from "./PacketClaimCode";
import { PacketMediaRow } from "./PacketMedia";
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
  reference,
  packet,
  pullRequestHeadSha,
  scrollerRef,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  packet: ReviewPacket;
  pullRequestHeadSha: string | undefined;
  scrollerRef: (node: HTMLDivElement | null) => void;
}) {
  const behind = isPacketBehind(packet, pullRequestHeadSha);
  return (
    <div
      ref={scrollerRef}
      tabIndex={-1}
      data-workspace-focus-default
      className="h-full overflow-y-auto scrollbar-gutter-both outline-none"
    >
      <div className="mx-auto flex max-w-[60rem] flex-col gap-5 px-4 py-3">
        <PacketHeader packet={packet} behind={behind} pullRequestHeadSha={pullRequestHeadSha} />
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
                reference={reference}
                claim={claim}
                media={packet.media}
                packetHeadSha={packet.revision.head}
                pullRequestHeadSha={pullRequestHeadSha}
                behind={behind}
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
      </div>
    </div>
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
  reference,
  claim,
  media,
  packetHeadSha,
  pullRequestHeadSha,
  behind,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  claim: PacketClaim;
  media: ReadonlyArray<PacketMediaEntry>;
  packetHeadSha: string;
  pullRequestHeadSha: string | undefined;
  behind: boolean;
}) {
  const gt = useGT();
  const visuals = packetVisuals(claim.evidence, media);
  const checks = packetChecks(claim.evidence);
  return (
    <li
      id={`packet-claim-${claim.id}`}
      data-packet-claim={claim.id}
      className="flex min-w-0 flex-col gap-2 border-border/60 py-4 first:pt-1 not-first:border-t"
    >
      <h3 className="flex min-w-0 items-start gap-2 text-sm font-semibold text-foreground">
        <span className="min-w-0 break-words">{claim.title}</span>
        <ClaimResult result={claim.result} />
      </h3>
      {visuals.length > 0 ? (
        <PacketMediaRow environmentId={environmentId} visuals={visuals} name={claim.title} />
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
        <Collapsible>
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
              environmentId={environmentId}
              reference={reference}
              pullRequestHeadSha={pullRequestHeadSha}
              packetHeadSha={packetHeadSha}
              behind={behind}
              paths={claim.paths}
            />
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
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
                />
              ) : null}
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
