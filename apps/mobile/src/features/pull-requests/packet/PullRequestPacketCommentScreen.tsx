import { useAtom } from "@effect/atom-react";
import { formatClipRange, markRange } from "@t3tools/client-runtime/review-packet-comments";
import {
  EnvironmentId,
  REVIEW_COMMENT_LIMITS,
  type ReviewCommentAnchorInput,
} from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useVideoPlayer, VideoView } from "expo-video";
import { T, useGT } from "gt-react-native";
import { useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { useAssetUrlState } from "../../../state/assets";
import { reviewCommentDraftFamily } from "../../../state/reviewComments";
import { PullRequestSheetContent } from "../PullRequestSheetContent";
import { useReviewCommentActions, type PacketChangeParams } from "./usePacketComments";

export type PacketCommentIntent =
  | { readonly kind: "create"; readonly anchor: ReviewCommentAnchorInput }
  | { readonly kind: "reply"; readonly commentId: string }
  | {
      readonly kind: "edit";
      readonly commentId: string;
      readonly entryId: string;
      readonly text: string;
    };

export type PacketCommentParams = PacketChangeParams & {
  readonly intent: PacketCommentIntent;
  /** What the comment is on, in words: a claim's title, a file and line. */
  readonly context: string;
  /** A new comment on a clip: the clip's length, so a moment of it can be marked. */
  readonly clipMs?: number;
};

type VideoRangeAnchor = Extract<ReviewCommentAnchorInput, { readonly kind: "video-range" }>;

/** Drafts are kept per target, so a dismissed sheet reopens on the words it had. */
export function packetCommentDraftKey(
  params: Pick<PacketCommentParams, "environmentId" | "repository" | "branch" | "intent">,
) {
  const { intent } = params;
  const target =
    intent.kind === "create"
      ? intent.anchor.kind === "video-range"
        ? { ...intent.anchor, startMs: 0, endMs: 0 }
        : intent.anchor
      : intent.kind === "reply"
        ? intent.commentId
        : intent.entryId;
  return JSON.stringify([
    params.environmentId,
    params.repository,
    params.branch,
    intent.kind,
    target,
  ]);
}

export function PullRequestPacketCommentScreen({ route }: StaticScreenProps<PacketCommentParams>) {
  const params = route.params;
  const { intent } = params;
  const navigation = useNavigation();
  const gt = useGT();
  const actions = useReviewCommentActions(params);
  const [draft, setDraft] = useAtom(reviewCommentDraftFamily(packetCommentDraftKey(params)));
  const text = draft ?? (intent.kind === "edit" ? intent.text : "");
  const clip =
    intent.kind === "create" && intent.anchor.kind === "video-range" && params.clipMs !== undefined
      ? { anchor: intent.anchor, lengthMs: params.clipMs }
      : null;
  const [range, setRange] = useState(
    clip === null ? null : { startMs: clip.anchor.startMs, endMs: clip.anchor.endMs },
  );
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const value = text.trim();
    if (pending.current || value === "") return;
    pending.current = true;
    setBusy(true);
    const saved =
      intent.kind === "create"
        ? await actions.create(
            intent.anchor.kind === "video-range" && range !== null
              ? { ...intent.anchor, ...range }
              : intent.anchor,
            value,
          )
        : intent.kind === "reply"
          ? await actions.reply(intent.commentId, value)
          : await actions.edit(intent.commentId, intent.entryId, value);
    pending.current = false;
    setBusy(false);
    if (!saved) return;
    setDraft(null);
    navigation.goBack();
  };
  const title =
    intent.kind === "reply"
      ? gt("Reply to this comment")
      : intent.kind === "edit"
        ? gt("Edit your comment")
        : intent.anchor.kind === "claim"
          ? gt("Comment on this claim")
          : intent.anchor.kind === "code-range"
            ? gt("Comment on these lines")
            : intent.anchor.kind === "image-region"
              ? gt("Comment on this screenshot")
              : gt("Comment on this clip");
  return (
    <PullRequestSheetContent
      busy={busy}
      title={title}
      subtitle={params.context}
      footer={
        <Button
          fullWidth
          tone="contrast"
          label={
            busy
              ? gt("Saving…")
              : intent.kind === "reply"
                ? gt("Reply", { $context: "button, saves a follow-up to a review comment" })
                : intent.kind === "edit"
                  ? gt("Save")
                  : gt("Comment", { $context: "verb, saves a review comment" })
          }
          loading={busy}
          disabled={text.trim() === ""}
          onPress={() => void save()}
        />
      }
    >
      {clip !== null && range !== null ? (
        <ClipMarker
          environmentId={params.environmentId}
          anchor={clip.anchor}
          lengthMs={clip.lengthMs}
          range={range}
          onRangeChange={setRange}
        />
      ) : null}
      <TextInput
        multiline
        editable={!busy}
        autoFocus={clip === null}
        accessibilityLabel={title}
        placeholder={
          intent.kind === "reply"
            ? gt("Follow up…")
            : intent.kind === "create" && intent.anchor.kind === "claim"
              ? gt("What should the agent know or change about this claim?")
              : gt("Your comment")
        }
        placeholderTextColorClassName="accent-foreground-muted"
        maxLength={REVIEW_COMMENT_LIMITS.textChars}
        value={text}
        onChangeText={setDraft}
        className="min-h-32 rounded-[20px] bg-grouped-card p-4 text-base text-foreground"
        style={{ textAlignVertical: "top" }}
      />
      {intent.kind === "create" ? (
        <Text className="text-xs text-foreground-muted">
          <T>New comments wait until you send them to the agent from the packet.</T>
        </Text>
      ) : null}
    </PullRequestSheetContent>
  );
}

type ClipRange = { readonly startMs: number; readonly endMs: number };

/** The clip with Mark start and Mark end at the playhead; unmarked, the comment is on all of it. */
function ClipMarker(props: {
  readonly environmentId: string;
  readonly anchor: VideoRangeAnchor;
  readonly lengthMs: number;
  readonly range: ClipRange;
  readonly onRangeChange: (range: ClipRange) => void;
}) {
  const gt = useGT();
  const url = useAssetUrlState(EnvironmentId.make(props.environmentId), {
    _tag: "review-media",
    id: props.anchor.media,
  });
  // A signed URL renews on reconnect; a new one would restart playback, so the first is kept.
  const [pinned, setPinned] = useState<string | null>(null);
  if (pinned === null && url._tag === "Success") setPinned(url.url);
  if (pinned !== null) return <ClipPlayer uri={pinned} {...props} />;
  return (
    <View className="gap-3">
      <View
        className="items-center justify-center overflow-hidden rounded-[20px] bg-black"
        style={{ aspectRatio: 16 / 9 }}
      >
        <Text className="text-sm text-white/80">
          {url._tag === "Failure" ? gt("Video unavailable") : gt("Loading…")}
        </Text>
      </View>
      <ClipRangeLabel range={props.range} lengthMs={props.lengthMs} />
    </View>
  );
}

function ClipRangeLabel(props: { readonly range: ClipRange; readonly lengthMs: number }) {
  const gt = useGT();
  return (
    <Text className="text-sm text-foreground" accessibilityLiveRegion="polite">
      {props.range.startMs === 0 && props.range.endMs === props.lengthMs
        ? gt("The whole clip ({range})", { range: formatClipRange(props.range) })
        : gt("From {range} of the clip", { range: formatClipRange(props.range) })}
    </Text>
  );
}

function ClipPlayer(props: {
  readonly uri: string;
  readonly lengthMs: number;
  readonly range: ClipRange;
  readonly onRangeChange: (range: ClipRange) => void;
}) {
  const gt = useGT();
  // Muted: marking a moment needs the picture, and a muted player leaves the shared audio session alone.
  const player = useVideoPlayer(props.uri, (created) => {
    created.muted = true;
    created.staysActiveInBackground = false;
  });
  const mark = (end: "start" | "end") =>
    props.onRangeChange(
      markRange(props.range, end, Math.round(player.currentTime * 1000), props.lengthMs),
    );
  return (
    <View className="gap-3">
      <View className="overflow-hidden rounded-[20px] bg-black" style={{ aspectRatio: 16 / 9 }}>
        <VideoView
          player={player}
          style={{ width: "100%", height: "100%" }}
          surfaceType="textureView"
          nativeControls
          contentFit="contain"
          allowsPictureInPicture={false}
        />
      </View>
      <ClipRangeLabel range={props.range} lengthMs={props.lengthMs} />
      <View className="flex-row flex-wrap gap-2">
        <Button size="compact" label={gt("Mark start")} onPress={() => mark("start")} />
        <Button size="compact" label={gt("Mark end")} onPress={() => mark("end")} />
        <Button
          size="compact"
          tone="text"
          label={gt("Whole clip")}
          onPress={() => props.onRangeChange({ startMs: 0, endMs: props.lengthMs })}
        />
      </View>
    </View>
  );
}
