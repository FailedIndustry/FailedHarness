import { codeRangeAnchor } from "@t3tools/client-runtime/review-packet-comments";
import { shortSha } from "@t3tools/client-runtime/review-packet";
import { EnvironmentId } from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { T, useGT, useMessages, Var } from "gt-react-native";
import { useMemo, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import { AppBar } from "../../../components/ui/AppBar";
import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { useContentTopInset } from "../../../components/ui/useBarInset";
import { useEnvironmentQuery } from "../../../state/query";
import { reviewCommentEnvironment } from "../../../state/reviewComments";
import { resolveNativeReviewDiffView } from "../../diffs/nativeReviewDiffSurface";
import {
  getCachedNativeReviewDiffData,
  NATIVE_REVIEW_DIFF_CONTENT_WIDTH,
} from "../../review/nativeReviewDiffAdapter";
import { buildReviewParsedDiff } from "../../review/reviewModel";
import { useNativeReviewDiffBridge } from "../../review/useNativeReviewDiffBridge";
import { useAppearancePreferences } from "../../settings/appearance/AppearancePreferencesProvider";
import { useAppearanceCodeSurface } from "../../settings/appearance/useAppearanceCodeSurface";
import { reviewPosition } from "../pullRequestDiffComments";
import { usePullRequestDiffEntry } from "../usePullRequestDiff";
import { packetChangeRef, type PacketChangeParams } from "./usePacketComments";

export type PacketCodeParams = PacketChangeParams & {
  readonly base: string;
  readonly head: string;
  readonly paths: readonly string[];
  readonly claimId: string;
  readonly claimTitle: string;
  /** The pull request has pushes the packet does not cover. */
  readonly behind: boolean;
  readonly canComment: boolean;
};

/**
 * The code behind a claim as the packet recorded it, so line comments point at the packet's own
 * revision. Tap a line to comment on it; touch and hold one first to comment on the lines from
 * there to the one tapped.
 */
export function PullRequestPacketCodeScreen({ route }: StaticScreenProps<PacketCodeParams>) {
  const params = route.params;
  const navigation =
    useNavigation<
      NativeStackNavigationProp<ReactNavigation.RootParamList, "PullRequestPacketCode">
    >();
  const gt = useGT();
  const messages = useMessages();
  const insets = useSafeAreaInsets();
  const contentTopInset = useContentTopInset();
  const query = useEnvironmentQuery(
    reviewCommentEnvironment.recordedDiff({
      environmentId: EnvironmentId.make(params.environmentId),
      input: { ...packetChangeRef(params), head: params.head, paths: [...params.paths] },
    }),
  );
  const result = query.data;
  const patch = result?._tag === "available" ? result.patch : null;
  const parsed = useMemo(
    () => buildReviewParsedDiff(patch, `packet:${params.repository}:${params.head}`, messages),
    [patch, params.repository, params.head, messages],
  );
  const data = useMemo(() => getCachedNativeReviewDiffData({ parsedDiff: parsed }), [parsed]);
  const [startRowId, setStartRowId] = useState<string | null>(null);
  const { nativeReviewDiffStyle } = useAppearanceCodeSurface();
  const { themeAppearance } = useAppearancePreferences();
  const bridge = useNativeReviewDiffBridge({
    threadKey: null,
    sectionId: `packet:${params.repository}:${params.head}:${params.claimId}`,
    diff: patch,
    data,
    collapsedFileIds: [],
    viewedFileIds: [],
    selectedRowIds: startRowId ? [startRowId] : [],
    canHighlight: true,
  });
  const [NativeDiffView] = useState(() => resolveNativeReviewDiffView());
  // The native diff mounts after the opening transition, as the pull request's diff does.
  const entered = usePullRequestDiffEntry(navigation);

  const commentOn = (rowId: string) => {
    const row = data.rows.find((candidate) => candidate.id === rowId);
    const file = data.files.find((candidate) => candidate.id === row?.fileId);
    const position = row ? reviewPosition(row) : null;
    if (!row || !file || !position || !params.canComment) return;
    const start = data.rows.find((candidate) => candidate.id === startRowId);
    const startPosition = start && start.fileId === row.fileId ? reviewPosition(start) : null;
    setStartRowId(null);
    const anchor = codeRangeAnchor({
      path: file.path,
      position,
      startPosition: startPosition ?? undefined,
      revision: { base: params.base, head: params.head },
      claimId: params.claimId,
    });
    navigation.navigate("PullRequestPacketComment", {
      environmentId: params.environmentId,
      host: params.host,
      repository: params.repository,
      branch: params.branch,
      intent: { kind: "create", anchor },
      context:
        anchor.startLine === anchor.endLine
          ? `${anchor.path}:${anchor.startLine}`
          : `${anchor.path}:${anchor.startLine}-${anchor.endLine}`,
    });
  };

  const notice =
    query.error !== null
      ? gt("The recorded diff could not be loaded: {error}", { error: query.error })
      : result?._tag === "unavailable"
        ? result.reason === "no-checkout"
          ? gt(
              "No project here has a checkout of this repository, so the recorded code cannot be shown.",
            )
          : result.reason === "commits-missing"
            ? gt("The checkout here does not have the packet's commits and could not fetch them.")
            : gt("This packet revision is no longer stored.")
        : result?._tag === "available" && data.rows.length === 0
          ? gt("The packet's commits change no file these paths name.")
          : null;

  return (
    <View className="flex-1 android:bg-header ios:bg-screen">
      <AppBar
        title={params.claimTitle}
        subtitle={`${shortSha(params.base)}..${shortSha(params.head)}`}
        onBack={() => navigation.goBack()}
      />
      <ScreenContent>
        <View className="flex-1" style={{ paddingTop: contentTopInset }}>
          <View className="gap-1 px-4 pb-2">
            {params.behind ? (
              <Text className="text-xs text-warning-foreground">
                <T>
                  The code as the packet recorded it, <Var>{shortSha(params.base)}</Var>..
                  <Var>{shortSha(params.head)}</Var>. The pull request has newer pushes.
                </T>
              </Text>
            ) : null}
            {params.canComment && data.rows.length > 0 ? (
              <Text className="text-xs text-foreground-muted">
                {startRowId
                  ? gt("Tap the last line to comment on the lines between.")
                  : gt("Tap a line to comment on it. Touch and hold one first to mark a range.")}
              </Text>
            ) : null}
            {result?._tag === "available" && result.truncated ? (
              <Text className="text-xs text-foreground-muted">
                <T>The diff is too large to show in full here; the last files are cut off.</T>
              </Text>
            ) : null}
          </View>
          {result === null && query.error === null ? (
            <View className="flex-1 items-center justify-center">
              <AppActivityIndicator accessibilityLabel={gt("Loading the diff...")} />
            </View>
          ) : notice !== null ? (
            <EmptyState
              title={gt("Diff unavailable")}
              detail={notice}
              action={
                query.error !== null ? (
                  <Button label={gt("Retry")} onPress={query.refresh} />
                ) : undefined
              }
              variant="plain"
            />
          ) : NativeDiffView && entered ? (
            <View className="flex-1" collapsable={false}>
              <NativeDiffView
                style={StyleSheet.absoluteFill}
                rowsJson={bridge.rowsJson}
                themeJson={bridge.themeJson}
                styleJson={bridge.styleJson}
                tokensPatchJson={bridge.tokensPatchJson}
                tokensResetKey={bridge.tokensResetKey}
                collapsedFileIdsJson={bridge.collapsedFileIdsJson}
                viewedFileIdsJson={bridge.viewedFileIdsJson}
                selectedRowIdsJson={bridge.selectedRowIdsJson}
                onDebug={bridge.onDebug}
                onPressLine={(event) => {
                  const rowId = event.nativeEvent.rowId;
                  if (!rowId) return;
                  if (event.nativeEvent.gesture === "longPress") setStartRowId(rowId);
                  else commentOn(rowId);
                }}
                appearanceScheme={themeAppearance}
                rowHeight={nativeReviewDiffStyle.rowHeight}
                contentWidth={NATIVE_REVIEW_DIFF_CONTENT_WIDTH}
                contentInsetTop={0}
                contentInsetBottom={Platform.OS === "android" ? 24 : insets.bottom}
                contentResetKey={`packet:${params.environmentId}:${params.repository}:${params.head}:${params.claimId}`}
              />
            </View>
          ) : null}
        </View>
      </ScreenContent>
    </View>
  );
}
