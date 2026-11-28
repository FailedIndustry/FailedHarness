import {
  claimDescription,
  isPacketBehind,
  PACKET_LEAD_MEDIA,
  packetChecks,
  packetVisuals,
  shortSha,
  type PacketClaim,
  type PacketVisual,
} from "@t3tools/client-runtime/review-packet";
import {
  anchorClaimTitle,
  describeAnchor,
  threadsUnder,
} from "@t3tools/client-runtime/review-packet-comments";
import {
  EnvironmentId,
  isUnknownUnionMember,
  type ReviewCommentState,
  type ReviewCommentThread,
  type ReviewPacket,
} from "@t3tools/contracts";
import { StackActions, useNavigation } from "@react-navigation/native";
import { Image } from "expo-image";
import { T, useGT, useMessages, Var } from "gt-react-native";
import { useContext, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { RelativeTime } from "../../../components/RelativeTime";
import { VideoAttachmentTile } from "../../../components/VideoAttachmentTile";
import { AppText as Text } from "../../../components/ui/AppText";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { Button } from "../../../components/ui/Button";
import { Chip } from "../../../components/ui/Chip";
import {
  FilePreviewModal,
  type FilePreviewItem,
  type FilePreviewSource,
} from "../../../components/ui/FilePreviewModal";
import { Menu } from "../../../components/ui/Menu";
import {
  VideoPreviewModal,
  type VideoPreviewSource,
} from "../../../components/ui/VideoPreviewModal";
import { assetImageCacheKey } from "../../../lib/assetImageSource";
import { cn } from "../../../lib/cn";
import { useAssetUrlState } from "../../../state/assets";
import { PullRequestMediaVisibleContext } from "../PullRequestMedia";
import { PacketCommentThread, PacketCommentThreadList } from "./PacketCommentThread";
import { PacketSendCard } from "./PacketSendCard";
import { PacketScreenContext, usePacketScreen, type PacketScreenModel } from "./packetContext";
import type { PacketCommentIntent } from "./PullRequestPacketCommentScreen";
import {
  usePacketComments,
  useReviewCommentActions,
  type PacketChangeParams,
} from "./usePacketComments";

type Finding = ReviewPacket["blockers"][number];

const reviewMedia = (id: string) => ({ _tag: "review-media" as const, id });

type MediaPreview =
  | { readonly kind: "image"; readonly source: FilePreviewSource }
  | { readonly kind: "clip"; readonly source: VideoPreviewSource };

/**
 * A pull request's review packet: each claim with its evidence, checks, blockers and notes, and
 * the comments a reviewer writes on them until one send hands them all to the agent.
 */
export function PullRequestPacketContent(props: {
  readonly change: PacketChangeParams;
  readonly packet: ReviewPacket;
  readonly pullRequestHeadSha: string | undefined;
}) {
  const { change, packet } = props;
  const navigation = useNavigation();
  const comments = usePacketComments(change, packet);
  const actions = useReviewCommentActions(change);
  const [filter, setFilter] = useState<ReviewCommentState | null>(null);
  const [preview, setPreview] = useState<MediaPreview | null>(null);
  const behind = isPacketBehind(packet, props.pullRequestHeadSha);
  const model: PacketScreenModel = {
    change,
    packet,
    comments,
    actions,
    filter,
    openComposer: (intent: PacketCommentIntent, context: string, clipMs?: number) =>
      navigation.navigate("PullRequestPacketComment", {
        ...change,
        intent,
        context,
        ...(clipMs === undefined ? {} : { clipMs }),
      }),
    openMedia: (visual, row) => {
      const environmentId = EnvironmentId.make(change.environmentId);
      const name = visual.caption ?? visual.media?.file ?? visual.evidenceId;
      if (visual.kind === "clip") {
        setPreview({
          kind: "clip",
          source: {
            type: "media",
            name,
            mimeType: visual.media?.type ?? "video/mp4",
            sourceIdentifier: mediaSourceIdentifier(visual),
            environmentId,
            resource: reviewMedia(visual.mediaId),
          },
        });
        return;
      }
      const images = row
        .filter((item) => item.kind === "image")
        .map((item): FilePreviewItem => ({
          kind: "image",
          name: item.caption ?? item.media?.file ?? item.evidenceId,
          sourceIdentifier: mediaSourceIdentifier(item),
          environmentId,
          resource: reviewMedia(item.mediaId),
        }));
      const selected = images.find(
        (image) => image.sourceIdentifier === mediaSourceIdentifier(visual),
      );
      if (selected) setPreview({ kind: "image", source: { ...selected, gallery: images } });
    },
  };
  return (
    <PacketScreenContext value={model}>
      <View className="w-full max-w-[760px] gap-5 self-center">
        <View className="gap-3">
          <PacketHeader packet={packet} behind={behind} headSha={props.pullRequestHeadSha} />
          <CommentOverview filter={filter} onFilterChange={setFilter} />
        </View>
        <PacketSendCard />
        {packet.summary !== undefined && packet.summary.trim() !== "" ? (
          <Text className="text-sm text-foreground-muted">{packet.summary}</Text>
        ) : null}
        {packet.claims.length === 0 ? (
          <Text className="text-sm text-foreground-muted">
            <T>This packet makes no claims.</T>
          </Text>
        ) : (
          <View>
            {packet.claims.map((claim, index) => (
              <PacketClaimItem key={claim.id} claim={claim} first={index === 0} behind={behind} />
            ))}
          </View>
        )}
        <PacketFindings kind="blockers" findings={packet.blockers} />
        <PacketFindings kind="notes" findings={packet.notes} />
        <OtherComments />
      </View>
      {preview?.kind === "image" ? (
        <FilePreviewModal source={preview.source} onRequestClose={() => setPreview(null)} />
      ) : null}
      {preview?.kind === "clip" ? (
        <VideoPreviewModal source={preview.source} onRequestClose={() => setPreview(null)} />
      ) : null}
    </PacketScreenContext>
  );
}

const mediaSourceIdentifier = (visual: PacketVisual) =>
  `review-packet:${visual.evidenceId}:${visual.mediaId}`;

function Badge(props: {
  readonly label: string;
  readonly tone: "success" | "danger" | "warning" | "muted";
  readonly icon?: "checkmark" | "xmark";
}) {
  const text = {
    success: "text-adaptive-emerald-600-400",
    danger: "text-danger-foreground",
    warning: "text-warning-foreground",
    muted: "text-foreground-muted",
  }[props.tone];
  const tint = {
    success: "accent-adaptive-emerald-600-400",
    danger: "accent-danger-foreground",
    warning: "accent-warning-foreground",
    muted: "accent-icon-muted",
  }[props.tone];
  return (
    <View className="flex-row items-center gap-1 rounded-md bg-subtle px-1.5 py-0.5">
      {props.icon ? <SymbolView name={props.icon} size={10} tintColorClassName={tint} /> : null}
      <Text className={cn("text-2xs font-t3-medium", text)}>{props.label}</Text>
    </View>
  );
}

function PacketHeader(props: {
  readonly packet: ReviewPacket;
  readonly behind: boolean;
  readonly headSha: string | undefined;
}) {
  const gt = useGT();
  const { packet } = props;
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
    <View className="gap-2">
      <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
        <SymbolView name="arrow.triangle.branch" size={12} tintColorClassName="accent-icon-muted" />
        <Text className="min-w-0 shrink font-mono text-xs text-foreground-muted" numberOfLines={1}>
          {packet.change.branch}
        </Text>
        <Text
          className="font-mono text-xs text-foreground-muted"
          accessibilityLabel={gt("Recorded against {base}..{head}", {
            base: packet.revision.base,
            head: packet.revision.head,
          })}
        >
          {shortSha(packet.revision.base)}..{shortSha(packet.revision.head)}
        </Text>
        <Text className="text-xs text-foreground-muted">
          <T context="followed by a relative time such as 5m ago or just now">
            recorded{" "}
            <Var>
              <RelativeTime timestamp={packet.revision.recordedAt} />
            </Var>
          </T>
        </Text>
      </View>
      <View className="flex-row flex-wrap gap-1.5">
        {checks === undefined ? null : (
          <Badge
            tone={checks.newFailures > 0 ? "danger" : "success"}
            icon={checks.newFailures > 0 ? "xmark" : "checkmark"}
            label={
              checks.newFailures > 0
                ? gt(
                    "{failures, plural, one {{failures} new failure} other {{failures} new failures}}, {passed} passed",
                    { failures: checks.newFailures, passed: checks.passed },
                  )
                : gt(
                    "{passed, plural, one {{passed} check passed} other {{passed} checks passed}}",
                    {
                      passed: checks.passed,
                    },
                  )
            }
          />
        )}
        <Badge
          tone={verdict === "pass" ? "success" : verdict === "fail" ? "danger" : "warning"}
          label={gt(
            "{verdict, select, pass {Passed} fail {Failed} other {Blocked}} · {by, select, model {played by {model}} agent {played by an agent} person {played by a person} other {not playtested}}",
            { verdict, by: playedBy, model: playtest?.model ?? "" },
          )}
        />
        {props.behind && props.headSha !== undefined ? (
          <Badge
            tone="warning"
            label={gt("Behind the latest push ({head})", { head: shortSha(props.headSha) })}
          />
        ) : null}
      </View>
    </View>
  );
}

const OVERVIEW_STATES: ReadonlyArray<ReviewCommentState> = [
  "pending",
  "open",
  "answered",
  "resolved",
];

/** Counts by state that also filter the comments shown; tapping the active one clears it. */
function CommentOverview(props: {
  readonly filter: ReviewCommentState | null;
  readonly onFilterChange: (filter: ReviewCommentState | null) => void;
}) {
  const gt = useGT();
  const { comments } = usePacketScreen();
  if (comments.error !== null) {
    return (
      <Text className="text-xs text-foreground-muted">
        <T>
          Comments could not be loaded: <Var>{comments.error}</Var>
        </T>
      </Text>
    );
  }
  const shown = OVERVIEW_STATES.filter(
    (state) => comments.counts[state] > 0 || props.filter === state,
  );
  if (shown.length === 0) return null;
  const label = (state: ReviewCommentState) => {
    const count = comments.counts[state];
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
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8 }}
    >
      {shown.map((state) => (
        <Chip
          key={state}
          size="small"
          label={label(state)}
          selected={props.filter === state}
          accessibilityLabel={gt("Show comments: {state}", { state: label(state) })}
          onPress={() => props.onFilterChange(props.filter === state ? null : state)}
        />
      ))}
    </ScrollView>
  );
}

function ClaimResult(props: { readonly result: PacketClaim["result"] }) {
  const gt = useGT();
  if (props.result === "seen") {
    return (
      <SymbolView
        name="checkmark"
        size={13}
        accessibilityLabel={gt("Seen", { $context: "a claim the playtest saw happen" })}
        tintColorClassName="accent-icon-muted"
      />
    );
  }
  return props.result === "not-seen" ? (
    <Badge
      tone="danger"
      label={gt("Not seen", { $context: "a claim the playtest did not see happen" })}
    />
  ) : (
    <Badge
      tone="warning"
      label={gt("Untested", { $context: "a claim the playtest did not try" })}
    />
  );
}

function PacketClaimItem(props: {
  readonly claim: PacketClaim;
  readonly first: boolean;
  readonly behind: boolean;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const model = usePacketScreen();
  const { claim } = props;
  const visuals = packetVisuals(claim.evidence, model.packet.media);
  const checks = packetChecks(claim.evidence);
  const threads = model.comments.layout.byClaim.get(claim.id) ?? [];
  const openCode = () =>
    navigation.dispatch(
      StackActions.push("PullRequestPacketCode", {
        ...model.change,
        base: model.packet.revision.base,
        head: model.packet.revision.head,
        paths: claim.paths,
        claimId: claim.id,
        claimTitle: claim.title,
        behind: props.behind,
        canComment: model.comments.canWrite,
      }),
    );
  const openAnchor = (thread: ReviewCommentThread) => {
    const anchor = thread.anchor;
    if (isUnknownUnionMember(anchor) || anchor.kind === "claim") return undefined;
    if (anchor.kind === "code-range") return claim.paths.length > 0 ? openCode : undefined;
    const visual = visuals.find(
      (item) => item.mediaId === (thread.currentClip?.media ?? anchor.media),
    );
    return visual === undefined ? undefined : () => model.openMedia(visual, visuals);
  };
  return (
    <View className={cn("gap-2 py-4", !props.first && "border-t border-border-subtle")}>
      <View className="flex-row items-start gap-2">
        <Text className="min-w-0 flex-1 text-base font-t3-semibold">{claim.title}</Text>
        <View className="pt-0.5">
          <ClaimResult result={claim.result} />
        </View>
      </View>
      {visuals.length > 0 ? (
        <PacketMediaRow visuals={visuals} name={claim.title} claimId={claim.id} />
      ) : null}
      <Text className="text-sm text-foreground">{claimDescription(claim)}</Text>
      {checks.length > 0 ? (
        <View className="flex-row flex-wrap gap-1.5">
          {checks.map((check) => (
            <Badge
              key={check.id}
              tone={check.passed ? "muted" : "danger"}
              icon={check.passed ? "checkmark" : "xmark"}
              label={check.name}
            />
          ))}
        </View>
      ) : null}
      {visuals.length === 0 && checks.length === 0 && claim.result === "seen" ? (
        <Text className="text-xs text-foreground-muted">
          <T>No evidence recorded.</T>
        </Text>
      ) : null}
      {claim.paths.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Code for {paths}", { paths: claim.paths.join(", ") })}
          onPress={openCode}
          className="min-h-9 flex-row items-center gap-2 active:opacity-60"
        >
          <SymbolView
            name="chevron.left.forwardslash.chevron.right"
            size={13}
            tintColorClassName="accent-icon-muted"
          />
          <Text
            className="min-w-0 flex-1 font-mono text-xs text-foreground-muted"
            numberOfLines={2}
          >
            {claim.paths.join("  ")}
          </Text>
          <SymbolView name="chevron.right" size={11} tintColorClassName="accent-icon-muted" />
        </Pressable>
      ) : null}
      <PacketCommentThreadList threads={threads} context={claim.title} onOpenAnchor={openAnchor} />
      {model.comments.canWrite ? (
        <View className="flex-row">
          <Button
            size="compact"
            tone="text"
            icon="plus.bubble"
            label={gt("Comment", { $context: "button, starts a review comment on a claim" })}
            onPress={() =>
              model.openComposer(
                {
                  kind: "create",
                  anchor: {
                    kind: "claim",
                    packetHead: model.packet.revision.head,
                    claimId: claim.id,
                  },
                },
                claim.title,
              )
            }
          />
        </View>
      ) : null}
    </View>
  );
}

/**
 * One row of evidence that scrolls sideways, with the rest behind a final "more" tile. A tap shows
 * an item full screen; touch and hold one to comment on it.
 */
function PacketMediaRow(props: {
  readonly visuals: ReadonlyArray<PacketVisual>;
  readonly name: string;
  readonly claimId: string | null;
}) {
  const gt = useGT();
  const model = usePacketScreen();
  const [expanded, setExpanded] = useState(false);
  const lead =
    expanded || props.visuals.length <= PACKET_LEAD_MEDIA
      ? props.visuals
      : props.visuals.slice(0, PACKET_LEAD_MEDIA);
  const more = props.visuals.length - lead.length;
  // The same screenshot can back several claims; each counts the comments written under it.
  const openCount = (mediaId: string) =>
    threadsUnder(model.comments.layout.byMedia.get(mediaId) ?? [], props.claimId).filter(
      (thread) => thread.state !== "resolved",
    ).length;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8 }}
    >
      {lead.map((visual) => (
        <PacketMediaTile
          key={visual.evidenceId}
          visual={visual}
          name={visual.caption ?? props.name}
          openCount={openCount(visual.mediaId)}
          onOpen={() => model.openMedia(visual, props.visuals)}
          onComment={
            model.comments.canWrite
              ? () =>
                  model.openComposer(
                    visual.kind === "image"
                      ? {
                          kind: "create",
                          anchor: {
                            kind: "image-region",
                            packetHead: model.packet.revision.head,
                            ...(props.claimId === null ? {} : { claimId: props.claimId }),
                            media: visual.mediaId,
                          },
                        }
                      : {
                          kind: "create",
                          anchor: {
                            kind: "video-range",
                            packetHead: model.packet.revision.head,
                            ...(props.claimId === null ? {} : { claimId: props.claimId }),
                            media: visual.mediaId,
                            startMs: 0,
                            endMs: visual.clipMs ?? 0,
                          },
                        },
                    visual.caption ?? props.name,
                    visual.kind === "clip" ? (visual.clipMs ?? 0) : undefined,
                  )
              : undefined
          }
        />
      ))}
      {more > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt(
            "{count, plural, one {Show {count} more item} other {Show {count} more items}}",
            { count: more },
          )}
          onPress={() => setExpanded(true)}
          className="items-center justify-center rounded-2xl border border-border-subtle bg-grouped-card active:opacity-70"
          style={{ width: 96, height: 112 }}
        >
          <Text className="text-lg font-t3-medium">+{more}</Text>
          <Text className="text-xs text-foreground-muted">
            <T context="tile that opens the rest of a claim's screenshots and clips">more</T>
          </Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

function PacketMediaTile(props: {
  readonly visual: PacketVisual;
  readonly name: string;
  readonly openCount: number;
  readonly onOpen: () => void;
  readonly onComment: (() => void) | undefined;
}) {
  const gt = useGT();
  const model = usePacketScreen();
  const visible = useContext(PullRequestMediaVisibleContext);
  const environmentId = EnvironmentId.make(model.change.environmentId);
  const resource = reviewMedia(props.visual.mediaId);
  const url = useAssetUrlState(environmentId, resource);
  const uri = url._tag === "Success" ? url.url : null;
  const tile =
    props.visual.kind === "clip" ? (
      <VideoAttachmentTile
        name={props.name}
        sourceIdentifier={mediaSourceIdentifier(props.visual)}
        thumbnailSource={visible ? uri : null}
        style={{ width: 176, height: 112, borderRadius: 16 }}
        onPress={props.onOpen}
      />
    ) : (
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={gt("Open {name}", { name: props.name })}
        accessibilityHint={props.onComment ? gt("Touch and hold to comment on it.") : undefined}
        onPress={props.onOpen}
        className="overflow-hidden rounded-2xl border border-border-subtle bg-grouped-card active:opacity-70"
        style={{ width: 176, height: 112 }}
      >
        {url._tag === "Failure" ? (
          <View className="flex-1 items-center justify-center gap-1 p-2">
            <SymbolView name="photo" size={16} tintColorClassName="accent-icon-muted" />
            <Text className="text-center text-xs text-foreground-muted" numberOfLines={2}>
              <T>
                Could not load <Var>{props.name}</Var>
              </T>
            </Text>
          </View>
        ) : (
          <Image
            source={uri ? { uri, cacheKey: assetImageCacheKey(environmentId, resource) } : null}
            style={{ width: 174, height: 110 }}
            contentFit="cover"
            cachePolicy="memory-disk"
          />
        )}
      </Pressable>
    );
  return (
    <View>
      {props.onComment ? (
        <Menu
          shouldOpenOnLongPress
          title={props.name}
          actions={[
            {
              id: "comment",
              title:
                props.visual.kind === "clip"
                  ? gt("Comment on a moment of this clip")
                  : gt("Comment on this screenshot"),
              image: "plus.bubble",
            },
          ]}
          onPressAction={({ nativeEvent }) => {
            if (nativeEvent.event === "comment") props.onComment?.();
          }}
        >
          {tile}
        </Menu>
      ) : (
        tile
      )}
      {props.openCount > 0 ? (
        <View
          pointerEvents="none"
          accessibilityLabel={gt(
            "{count, plural, one {{count} open comment} other {{count} open comments}}",
            { count: props.openCount },
          )}
          className="absolute left-1.5 top-1.5 flex-row items-center gap-0.5 rounded-md bg-black/70 px-1 py-0.5"
        >
          <SymbolView name="bubble.left" size={9} tintColor="white" />
          <Text className="text-2xs font-t3-medium text-white">{props.openCount}</Text>
        </View>
      ) : null}
    </View>
  );
}

function PacketFindings(props: {
  readonly kind: "blockers" | "notes";
  readonly findings: ReadonlyArray<Finding>;
}) {
  const gt = useGT();
  const model = usePacketScreen();
  if (props.findings.length === 0) return null;
  const blockers = props.kind === "blockers";
  return (
    <View className="gap-2">
      <View className="flex-row items-center gap-1.5">
        {blockers ? (
          <SymbolView
            name="exclamationmark.triangle"
            size={13}
            tintColorClassName="accent-danger-foreground"
          />
        ) : null}
        <Text
          className={cn(
            "text-xs font-t3-semibold",
            blockers ? "text-danger-foreground" : "text-foreground-muted",
          )}
        >
          {blockers
            ? gt("{count, plural, one {Blocker} other {Blockers}}", {
                count: props.findings.length,
              })
            : gt("{count, plural, one {Note} other {Notes}}", { count: props.findings.length })}
        </Text>
      </View>
      {props.findings.map((finding) => {
        const visuals = packetVisuals(finding.evidence ?? [], model.packet.media);
        return (
          // Findings carry no id; their place in the packet is their identity.
          <View
            key={finding.text}
            className={cn(
              "gap-2",
              blockers && "rounded-2xl border border-border-subtle bg-danger/5 p-3",
            )}
          >
            <Text className={cn("text-sm", blockers ? "text-foreground" : "text-foreground-muted")}>
              {finding.text}
            </Text>
            {visuals.length > 0 ? (
              <PacketMediaRow
                visuals={visuals}
                name={blockers ? gt("Blocker") : gt("Note")}
                claimId={null}
              />
            ) : null}
            <FindingThreads visuals={visuals} context={finding.text} />
          </View>
        );
      })}
    </View>
  );
}

/** Comments on a finding's screenshots and clips; findings have no anchor of their own. */
function FindingThreads(props: {
  readonly visuals: ReadonlyArray<PacketVisual>;
  readonly context: string;
}) {
  const model = usePacketScreen();
  const media = new Set(props.visuals.map((visual) => visual.mediaId));
  const threads = model.comments.layout.outsideClaims.filter((thread) => {
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
    const visual = props.visuals.find(
      (item) => item.mediaId === (thread.currentClip?.media ?? anchor.media),
    );
    return visual === undefined ? undefined : () => model.openMedia(visual, props.visuals);
  };
  return (
    <PacketCommentThreadList threads={threads} context={props.context} onOpenAnchor={openAnchor} />
  );
}

/** Comments whose anchor left the latest packet, and anchors this app cannot place. */
function OtherComments() {
  const gt = useGT();
  const resolve = useMessages();
  const model = usePacketScreen();
  const { packet } = model;
  const { layout } = model.comments;
  const onFindings = new Set(
    [...packet.blockers, ...packet.notes].flatMap((finding) =>
      (finding.evidence ?? []).flatMap((item) => (item.kind === "check" ? [] : [item.media])),
    ),
  );
  const unplaced = layout.outsideClaims.filter((thread) => {
    const anchor = thread.anchor;
    if (isUnknownUnionMember(anchor)) return false;
    return !(
      (anchor.kind === "image-region" || anchor.kind === "video-range") &&
      onFindings.has(thread.currentClip?.media ?? anchor.media)
    );
  });
  const visible = (threads: ReadonlyArray<ReviewCommentThread>) =>
    model.filter === null ? threads : threads.filter((thread) => thread.state === model.filter);
  const outdated = visible(layout.outdated);
  const rest = visible([...unplaced, ...layout.unknown]);
  if (outdated.length === 0 && rest.length === 0) return null;
  const item = (thread: ReviewCommentThread) => {
    const where = describeAnchor(thread, resolve);
    const claim = anchorClaimTitle(thread, packet);
    return (
      <View key={thread.id} className="gap-1">
        <Text className="text-xs text-foreground-muted">
          {claim === null ? where : `${where} · ${claim}`}
        </Text>
        <PacketCommentThread thread={thread} context={claim ?? where} showAnchor={false} />
      </View>
    );
  };
  return (
    <>
      {rest.length > 0 ? (
        <View className="gap-2">
          <Text className="text-xs font-t3-semibold text-foreground-muted">
            {gt("Other comments")}
          </Text>
          {rest.map(item)}
        </View>
      ) : null}
      {outdated.length > 0 ? (
        <View className="gap-2">
          <Text className="text-xs font-t3-semibold text-foreground-muted">
            {gt("On earlier revisions")}
          </Text>
          <Text className="text-xs text-foreground-muted">
            <T>
              The latest packet no longer has what these point at. They can still be answered,
              followed up and resolved.
            </T>
          </Text>
          {outdated.map(item)}
        </View>
      ) : null}
    </>
  );
}
