import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { isUnknownUnionMember, type ReviewCommentThread } from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";
import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { useRenderedAppearance } from "~/hooks/useTheme";
import { getRenderablePatch, resolveDiffThemeName, resolveFileDiffPath } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { resolveDiffReviewAnchor } from "~/reviewCommentContext";
import { useEnvironmentQuery } from "~/state/query";
import { reviewCommentEnvironment, useReviewCommentDrafts } from "~/state/reviewComments";

import { DiffCommentAnnotation } from "../../diffs/DiffCommentAnnotation";
import { DIFF_VIEW_UNSAFE_CSS } from "../../diffs/StyledDiffCodeView";
import { Button } from "../../ui/button";
import { Spinner } from "../../ui/spinner";
import { GuideFileList } from "../guide/GuideFileList";
import { CommentThread, usePacketComments } from "./PacketComments";
import { codeRangeAnchor } from "@t3tools/client-runtime/review-packet-comments";
import { shortSha } from "@t3tools/client-runtime/review-packet";

const NO_FILES: ReadonlyMap<string, FileDiffMetadata> = new Map();

/**
 * The code behind a claim as the packet recorded it: `git diff base head` narrowed to the
 * claim's pathspecs, so line comments point at the packet's own revision.
 */
export function PacketClaimCode({
  claimId,
  paths,
  behind,
  onOpenCode,
}: {
  claimId: string;
  paths: ReadonlyArray<string>;
  behind: boolean;
  onOpenCode: (() => void) | null;
}) {
  const gt = useGT();
  const model = usePacketComments();
  const { base, head } = model.packet.revision;
  const query = useEnvironmentQuery(
    reviewCommentEnvironment.recordedDiff({
      environmentId: model.environmentId,
      input: { ...model.change, head, paths: [...paths] },
    }),
    useMessages(),
  );
  const result = query.data;
  const parsed =
    result?._tag === "available"
      ? getRenderablePatch(
          result.patch,
          `packet-recorded:${model.change.repository}:${head}:${paths.join("\0")}`,
        )
      : null;
  const files =
    parsed?.kind === "files"
      ? new Map(parsed.files.map((file) => [resolveFileDiffPath(file), file]))
      : NO_FILES;
  const openCode =
    onOpenCode === null ? null : (
      <Button size="xs" variant="outline" onClick={onOpenCode}>
        <T>Open the Code tab</T>
      </Button>
    );

  return (
    <div className="flex min-w-0 flex-col gap-2 pt-1">
      {behind ? (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <TriangleAlertIcon
            aria-hidden
            className="mt-px size-3.5 shrink-0 text-warning-foreground"
          />
          <span>
            <T>
              The code as the packet recorded it, <Var>{shortSha(base)}</Var>..
              <Var>{shortSha(head)}</Var>. The pull request has newer pushes; the Code tab shows
              them.
            </T>
          </span>
        </p>
      ) : null}
      {files.size > 0 ? (
        <GuideFileList
          files={[...files.keys()].toSorted().map((path) => ({ path }))}
          diffs={files}
          loading={false}
          commenting={null}
          loadDiffFiles={null}
          renderDiff={(path, file) => (
            <PacketFileDiff key={path} path={path} file={file} claimId={claimId} />
          )}
        />
      ) : null}
      {query.error !== null ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            <T>
              The recorded diff could not be loaded: <Var>{query.error}</Var>
            </T>
          </span>
          <Button size="xs" variant="outline" onClick={query.refresh}>
            {gt("Retry")}
          </Button>
          {openCode}
        </p>
      ) : result === null ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner />
          {gt("Loading the diff...")}
        </p>
      ) : result._tag === "unavailable" ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            {result.reason === "no-checkout"
              ? gt(
                  "No project here has a checkout of this repository, so the recorded code cannot be shown.",
                )
              : result.reason === "commits-missing"
                ? gt(
                    "The checkout here does not have the packet's commits and could not fetch them.",
                  )
                : gt("This packet revision is no longer stored.")}
          </span>
          {openCode}
        </p>
      ) : files.size === 0 ? (
        <p className="text-xs text-muted-foreground">
          <T>The packet's commits change no file these paths name.</T>
        </p>
      ) : result.truncated ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            <T>The diff is too large to show in full here; the last files are cut off.</T>
          </span>
          {openCode}
        </p>
      ) : null}
    </div>
  );
}

interface CodeAnnotation {
  readonly threads: ReadonlyArray<ReviewCommentThread>;
  readonly draft: boolean;
}

interface CodeDraft {
  readonly range: SelectedLineRange;
  readonly anchor: ReturnType<typeof codeRangeAnchor>;
}

const viewerSide = (side: "old" | "new") => (side === "old" ? "deletions" : "additions");

/** One file of the recorded diff; select lines, or use the gutter, to comment on them. */
function PacketFileDiff({
  path,
  file,
  claimId,
}: {
  path: string;
  file: FileDiffMetadata;
  claimId: string;
}) {
  const gt = useGT();
  const model = usePacketComments();
  const resolvedTheme = useRenderedAppearance();
  const [draft, setDraft] = useState<CodeDraft | null>(null);
  const { base, head } = model.packet.revision;
  const draftKey =
    draft === null
      ? null
      : `new:code:${path}:${draft.anchor.side}:${draft.anchor.startLine}-${draft.anchor.endLine}`;
  const draftText = useReviewCommentDrafts((state) =>
    draftKey === null ? "" : (state.drafts[draftKey] ?? ""),
  );
  const setDraftText = useReviewCommentDrafts((state) => state.setDraft);
  const clearDraftText = useReviewCommentDrafts((state) => state.clearDraft);

  const groups = new Map<
    string,
    { side: "additions" | "deletions"; line: number } & CodeAnnotation
  >();
  const place = (
    side: "additions" | "deletions",
    line: number,
    change: (annotation: CodeAnnotation) => CodeAnnotation,
  ) => {
    const key = `${side}:${line}`;
    const current = groups.get(key) ?? { side, line, threads: [], draft: false };
    groups.set(key, { ...current, ...change(current) });
  };
  for (const thread of model.layout.byPath.get(path) ?? []) {
    const anchor = thread.anchor;
    if (isUnknownUnionMember(anchor) || anchor.kind !== "code-range") continue;
    // Lines of another revision would land on the wrong code here; the claim lists them instead.
    if (anchor.commit !== (anchor.side === "new" ? head : base)) continue;
    place(viewerSide(anchor.side), anchor.endLine, (annotation) => ({
      ...annotation,
      threads: [...annotation.threads, thread],
    }));
  }
  if (draft !== null) {
    place(viewerSide(draft.anchor.side), draft.anchor.endLine, (annotation) => ({
      ...annotation,
      draft: true,
    }));
  }
  const annotations = [...groups.values()].map((group) => ({
    side: group.side,
    lineNumber: group.line,
    metadata: { threads: group.threads, draft: group.draft },
  }));

  const begin = (range: SelectedLineRange | null) => {
    if (range === null) return;
    const resolved = resolveDiffReviewAnchor(file, range, true);
    if (resolved === null) return;
    setDraft({
      range,
      anchor: codeRangeAnchor({
        path,
        position: resolved.position,
        startPosition: resolved.startPosition,
        revision: { base, head },
        claimId,
      }),
    });
  };
  const interactive = model.canWrite && draft === null;
  const close = () => {
    if (draftKey !== null) clearDraftText(draftKey);
    setDraft(null);
  };

  return (
    <div className="border-t border-border/60">
      <FileDiff<CodeAnnotation>
        fileDiff={file}
        options={{
          diffStyle: "unified",
          lineDiffType: "none",
          overflow: "scroll",
          disableFileHeader: true,
          theme: resolveDiffThemeName(resolvedTheme),
          themeType: resolvedTheme,
          preferredHighlighter: PREFERRED_HIGHLIGHTER,
          unsafeCSS: DIFF_VIEW_UNSAFE_CSS,
          hunkSeparators: "simple",
          enableGutterUtility: interactive,
          enableLineSelection: interactive,
          onGutterUtilityClick: begin,
          onLineSelectionEnd: begin,
        }}
        lineAnnotations={annotations}
        selectedLines={draft?.range ?? null}
        renderAnnotation={(annotation) => (
          <div className="flex flex-col gap-2 px-3 py-2 font-sans">
            {annotation.metadata.threads.map((thread) => (
              <CommentThread key={thread.id} thread={thread} showAnchor={false} />
            ))}
            {annotation.metadata.draft && draft !== null && draftKey !== null ? (
              <DiffCommentAnnotation
                kind="draft"
                rangeLabel={`${path}:${draft.anchor.startLine === draft.anchor.endLine ? draft.anchor.startLine : `${draft.anchor.startLine}-${draft.anchor.endLine}`}`}
                text={draftText}
                onTextChange={(text) => setDraftText(draftKey, text)}
                placeholder={gt("What should change in these lines?")}
                submitLabel={gt("Comment", { $context: "verb, saves a review comment" })}
                onCancel={close}
                onComment={(text) => {
                  void model.create(draft.anchor, text).then((saved) => {
                    if (saved) close();
                  });
                }}
              />
            ) : null}
          </div>
        )}
      />
    </div>
  );
}
