import {
  isUnknownUnionMember,
  type ReviewCommentThread,
  type ReviewRegion,
} from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ImageOffIcon,
  ScanIcon,
  SquareDashedIcon,
  XIcon,
} from "lucide-react";
import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";
import { useReviewCommentDrafts, type ReviewCommentMark } from "~/state/reviewComments";

import { Button } from "../../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../../ui/dialog";
import { Kbd } from "../../ui/kbd";
import { CommentComposer, CommentThreadList, usePacketComments } from "./PacketComments";
import {
  formatClipRange,
  formatClipTime,
  fractionInBox,
  isInRange,
  markerNumbers,
  markRange,
  moveRangeEnd,
  rangeFromTimes,
  rangePercentages,
  regionFromDrag,
  regionPercentages,
  REGION_TAP_PX,
  threadsUnder,
  timeAtFraction,
  type Box,
  type ClipRange,
  type Fraction,
} from "@t3tools/client-runtime/review-packet-comments";
import type { PacketVisual } from "@t3tools/client-runtime/review-packet";

export const reviewMediaResource = (id: string) => ({ _tag: "review-media" as const, id });

/** The packet's media, one at a time, with its comments and a way to mark where a new one points. */
export function PacketMediaViewer() {
  const model = usePacketComments();
  const request = model.viewer;
  if (request === null) return null;
  const key = `${request.visuals[request.index]?.evidenceId ?? ""}:${request.threadId ?? ""}`;
  return <PacketMediaDialog key={key} onClose={model.closeViewer} {...request} />;
}

function boxOf(element: Element): Box {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/** Keeps a drag going outside the element; a pointer the browser no longer tracks cannot be captured. */
function capturePointer(element: Element, pointerId: number) {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    // The drag still works while the pointer stays over the element.
  }
}

function isTyping(event: KeyboardEvent) {
  const target = event.target;
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === "TEXTAREA" || target.tagName === "INPUT")
  );
}

function PacketMediaDialog({
  visuals,
  index: initialIndex,
  name,
  claimId,
  threadId,
  onClose,
}: {
  visuals: ReadonlyArray<PacketVisual>;
  index: number;
  name: string;
  claimId: string | null;
  threadId: string | null;
  onClose: () => void;
}) {
  const gt = useGT();
  const model = usePacketComments();
  const [index, setIndex] = useState(initialIndex);
  const [selectedId, setSelectedId] = useState<string | null>(threadId);
  const visual = visuals[index];
  if (visual === undefined) return null;
  const label = visual.caption ?? name;
  const threads = threadsUnder(model.layout.byMedia.get(visual.mediaId) ?? [], claimId);
  const step = (direction: -1 | 1) => {
    setIndex((current) => (current + direction + visuals.length) % visuals.length);
    setSelectedId(null);
  };
  const review = {
    visual,
    label,
    claimId,
    threads,
    selectedId,
    onSelect: setSelectedId,
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup
        bottomStickOnMobile={false}
        showCloseButton={false}
        className="h-[calc(100dvh-2rem)] max-h-[60rem] w-full max-w-[84rem] overflow-hidden"
      >
        <DialogTitle className="sr-only">
          {visual.kind === "clip" ? gt("Review a clip") : gt("Review a screenshot")}
        </DialogTitle>
        <header className="flex min-w-0 items-center gap-1 border-b border-border/60 px-2 py-1.5">
          {visuals.length > 1 ? (
            <>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={gt("Previous media")}
                onClick={() => step(-1)}
              >
                <ChevronLeftIcon aria-hidden />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={gt("Next media")}
                onClick={() => step(1)}
              >
                <ChevronRightIcon aria-hidden />
              </Button>
            </>
          ) : null}
          <span className="min-w-0 flex-1 truncate px-1 text-sm font-medium">
            {label}
            {visuals.length > 1 ? (
              <span className="ms-1.5 text-xs font-normal text-muted-foreground tabular-nums">
                {index + 1}/{visuals.length}
              </span>
            ) : null}
          </span>
          <Button size="icon-xs" variant="ghost-muted" aria-label={gt("Close")} onClick={onClose}>
            <XIcon aria-hidden />
          </Button>
        </header>
        {visual.kind === "clip" ? (
          <ClipReview key={visual.evidenceId} {...review} />
        ) : (
          <ImageReview key={visual.evidenceId} {...review} />
        )}
      </DialogPopup>
    </Dialog>
  );
}

interface ReviewProps {
  visual: PacketVisual;
  label: string;
  claimId: string | null;
  threads: ReadonlyArray<ReviewCommentThread>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

function ViewerLayout({
  media,
  panel,
  onKeyDown,
}: {
  media: ReactNode;
  panel: ReactNode;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] outline-none sm:grid-cols-[minmax(0,1fr)_22rem] sm:grid-rows-1"
      onKeyDown={onKeyDown}
    >
      <div className="flex min-h-0 min-w-0 flex-col items-center justify-center gap-2 bg-black/90 p-2 sm:p-3">
        {media}
      </div>
      <aside className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto border-border/60 p-3 max-sm:border-t sm:border-s">
        {panel}
      </aside>
    </div>
  );
}

const MEDIA_SIZE_CLASS =
  "block max-h-[34dvh] max-w-full select-none sm:max-h-[calc(min(100dvh-2rem,60rem)-10rem)]";

/**
 * Draws a new region with a pointer drag (mouse, pen or touch) over a picture whose box it
 * covers, and shows the regions of existing comments as numbered outlines.
 */
function RegionLayer({
  active,
  outlines,
  selectedId,
  mark,
  onSelect,
  onMark,
}: {
  active: boolean;
  outlines: ReadonlyArray<{
    readonly id: string;
    readonly number: number;
    readonly region: ReviewRegion;
  }>;
  selectedId: string | null;
  mark: ReviewRegion | null;
  onSelect: (id: string) => void;
  onMark: (region: ReviewRegion | null) => void;
}) {
  const gt = useGT();
  const [drag, setDrag] = useState<{
    readonly start: Fraction;
    readonly end: Fraction;
    readonly box: Box;
  } | null>(null);
  const dragging = drag === null ? null : regionFromDrag(drag.start, drag.end, drag.box);
  const shown = dragging ?? mark;
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!active || event.button !== 0) return;
    event.preventDefault();
    capturePointer(event.currentTarget, event.pointerId);
    const box = boxOf(event.currentTarget);
    const start = fractionInBox(event.clientX, event.clientY, box);
    setDrag({ start, end: start, box });
  };
  return (
    <div
      data-packet-region-layer
      className={cn("absolute inset-0", active && "cursor-crosshair touch-none")}
      onPointerDown={onPointerDown}
      onPointerMove={(event) => {
        if (drag === null) return;
        setDrag({ ...drag, end: fractionInBox(event.clientX, event.clientY, drag.box) });
      }}
      onPointerUp={(event) => {
        if (drag === null) return;
        const end = fractionInBox(event.clientX, event.clientY, drag.box);
        setDrag(null);
        onMark(regionFromDrag(drag.start, end, drag.box));
      }}
      onPointerCancel={() => setDrag(null)}
    >
      {outlines.map((outline) => (
        <button
          key={outline.id}
          type="button"
          aria-label={gt("Comment {number}", { number: outline.number })}
          aria-pressed={selectedId === outline.id}
          className={cn(
            "absolute rounded-sm border-2 outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-inset",
            selectedId === outline.id
              ? "border-warning bg-warning/15"
              : "border-white/80 bg-black/5 hover:border-warning/80",
          )}
          style={regionPercentages(outline.region)}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onSelect(outline.id)}
        >
          <span className="absolute -top-2.5 -left-2.5 flex size-5 items-center justify-center rounded-full bg-black/80 text-3xs font-semibold text-white tabular-nums ring-1 ring-white/70">
            {outline.number}
          </span>
        </button>
      ))}
      {shown === null ? null : (
        <span
          aria-hidden
          className="pointer-events-none absolute rounded-sm border-2 border-dashed border-info bg-info/15"
          style={regionPercentages(shown)}
        />
      )}
    </div>
  );
}

function useMark(draftKey: string) {
  const mark = useReviewCommentDrafts((state) => state.marks[draftKey] ?? null);
  const setMark = useReviewCommentDrafts((state) => state.setMark);
  const clearDraft = useReviewCommentDrafts((state) => state.clearDraft);
  return {
    mark,
    setMark: (next: ReviewCommentMark) => setMark(draftKey, next),
    clear: () => clearDraft(draftKey),
  };
}

function regionOf(thread: ReviewCommentThread): ReviewRegion | null {
  const anchor = thread.anchor;
  if (isUnknownUnionMember(anchor)) return null;
  return anchor.kind === "image-region" || anchor.kind === "video-range"
    ? (anchor.region ?? null)
    : null;
}

function ImageReview({ visual, label, claimId, threads, selectedId, onSelect }: ReviewProps) {
  const gt = useGT();
  const model = usePacketComments();
  const url = useAssetUrlState(model.environmentId, reviewMediaResource(visual.mediaId));
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const draftKey = `new:image:${visual.mediaId}`;
  const { mark, setMark, clear } = useMark(draftKey);
  const numbers = markerNumbers(threads);
  const outlines = threads.flatMap((thread) => {
    const region = regionOf(thread);
    return region === null ? [] : [{ id: thread.id, number: numbers.get(thread.id) ?? 0, region }];
  });
  const src = url._tag === "Success" ? url.url : null;
  const failed = url._tag === "Failure" || (src !== null && failedSrc === src);
  const media = failed ? (
    <p className="flex flex-col items-center gap-1 text-sm text-white/80">
      <ImageOffIcon aria-hidden className="size-5" />
      <T>
        Could not load <Var>{label}</Var>
      </T>
    </p>
  ) : src === null ? null : (
    <>
      <div className="relative inline-block max-w-full">
        <img
          src={src}
          alt={label}
          draggable={false}
          className={MEDIA_SIZE_CLASS}
          onError={() => setFailedSrc(src)}
        />
        <RegionLayer
          active={model.canWrite}
          outlines={outlines}
          selectedId={selectedId}
          mark={mark?.region ?? null}
          onSelect={onSelect}
          onMark={(region) => setMark({ region, range: null })}
        />
      </div>
      {model.canWrite ? (
        <p className="text-center text-xs text-white/70">
          {gt("Drag on the screenshot to mark an area, or tap it to comment on all of it.")}
        </p>
      ) : null}
    </>
  );
  const panel = (
    <>
      {mark !== null ? (
        <section className="flex flex-col gap-1.5">
          <h4 className="flex items-center gap-1.5 text-xs font-medium [&_svg]:size-3.5">
            {mark.region === null ? <ScanIcon aria-hidden /> : <SquareDashedIcon aria-hidden />}
            {mark.region === null
              ? gt("New comment on the whole screenshot")
              : gt("New comment on the marked area")}
          </h4>
          <CommentComposer
            draftKey={draftKey}
            label={gt("Comment on this screenshot")}
            placeholder={gt("What is wrong or worth knowing here?")}
            submitLabel={gt("Comment", { $context: "verb, saves a review comment" })}
            onSubmit={(text) =>
              model.create(
                {
                  kind: "image-region",
                  packetHead: model.packet.revision.head,
                  ...(claimId === null ? {} : { claimId }),
                  media: visual.mediaId,
                  ...(mark.region === null ? {} : { region: mark.region }),
                },
                text,
              )
            }
            onCancel={clear}
          />
        </section>
      ) : model.canWrite ? (
        <Button
          size="xs"
          variant="outline"
          className="self-start"
          onClick={() => setMark({ region: null, range: null })}
        >
          <ScanIcon aria-hidden />
          {gt("Comment on the whole screenshot")}
        </Button>
      ) : null}
      <MediaThreads
        threads={threads}
        numbers={numbers}
        selectedId={selectedId}
        onSelect={(thread) => onSelect(thread.id)}
      />
    </>
  );
  return <ViewerLayout media={media} panel={panel} />;
}

function MediaThreads({
  threads,
  numbers,
  selectedId,
  onSelect,
}: {
  threads: ReadonlyArray<ReviewCommentThread>;
  numbers: ReadonlyMap<string, number>;
  selectedId: string | null;
  onSelect: (thread: ReviewCommentThread) => void;
}) {
  const gt = useGT();
  return threads.length === 0 ? (
    <p className="text-xs text-muted-foreground">{gt("No comments here yet.")}</p>
  ) : (
    <CommentThreadList
      threads={threads}
      numbers={numbers}
      selectedId={selectedId}
      onSelect={onSelect}
    />
  );
}

function threadRange(thread: ReviewCommentThread, media: string): ClipRange | null {
  const anchor = thread.anchor;
  if (isUnknownUnionMember(anchor) || anchor.kind !== "video-range") return null;
  if (thread.currentClip?.media === media) return thread.currentClip;
  return anchor.media === media ? anchor : null;
}

function ClipReview({ visual, label, claimId, threads, selectedId, onSelect }: ReviewProps) {
  const gt = useGT();
  const model = usePacketComments();
  const url = useAssetUrlState(model.environmentId, reviewMediaResource(visual.mediaId));
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [nowMs, setNowMs] = useState(0);
  const [paused, setPaused] = useState(true);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  const draftKey = `new:clip:${visual.mediaId}`;
  const { mark, setMark, clear } = useMark(draftKey);
  const lengthMs = visual.clipMs ?? visual.media?.durationMs ?? 0;
  const range = mark?.range ?? null;
  const numbers = markerNumbers(threads);
  const segments = threads.flatMap((thread) => {
    const located = threadRange(thread, visual.mediaId);
    return located === null ? [] : [{ thread, range: located }];
  });
  const selected = segments.find((segment) => segment.thread.id === selectedId);
  const selectedRegion =
    selected !== undefined && isInRange(nowMs, selected.range) ? regionOf(selected.thread) : null;
  const src = url._tag === "Success" ? url.url : null;
  const failed = url._tag === "Failure" || (src !== null && failedSrc === src);

  const seek = (ms: number) => {
    const video = videoRef.current;
    if (video === null) return;
    video.currentTime = ms / 1000;
    setNowMs(ms);
  };
  const playheadMs = () => Math.round((videoRef.current?.currentTime ?? nowMs / 1000) * 1000);
  const markAt = (end: "start" | "end") =>
    setMark({ region: mark?.region ?? null, range: markRange(range, end, playheadMs(), lengthMs) });
  const selectSegment = (thread: ReviewCommentThread) => {
    onSelect(thread.id);
    const located = threadRange(thread, visual.mediaId);
    if (located !== null) {
      videoRef.current?.pause();
      seek(located.startMs);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!model.canWrite || isTyping(event) || event.metaKey || event.ctrlKey || event.altKey)
      return;
    if (event.key === "i" || event.key === "I") {
      event.preventDefault();
      markAt("start");
    } else if (event.key === "o" || event.key === "O") {
      event.preventDefault();
      markAt("end");
    }
  };

  const media = failed ? (
    <p className="flex flex-col items-center gap-1 text-sm text-white/80">
      <ImageOffIcon aria-hidden className="size-5" />
      <T>
        Could not load <Var>{label}</Var>
      </T>
    </p>
  ) : src === null ? null : (
    <>
      <div className="relative inline-block max-w-full">
        <video
          ref={videoRef}
          src={src}
          aria-label={label}
          controls={!drawing}
          playsInline
          preload="metadata"
          className={MEDIA_SIZE_CLASS}
          onTimeUpdate={(event) => setNowMs(Math.round(event.currentTarget.currentTime * 1000))}
          onSeeked={(event) => setNowMs(Math.round(event.currentTarget.currentTime * 1000))}
          onPlay={() => {
            setPaused(false);
            setDrawing(false);
          }}
          onPause={() => setPaused(true)}
          onError={() => setFailedSrc(src)}
        />
        {drawing || selectedRegion !== null || mark?.region != null ? (
          <RegionLayer
            active={drawing}
            outlines={
              selectedRegion === null || selected === undefined
                ? []
                : [
                    {
                      id: selected.thread.id,
                      number: numbers.get(selected.thread.id) ?? 0,
                      region: selectedRegion,
                    },
                  ]
            }
            selectedId={selectedId}
            mark={mark?.region ?? null}
            onSelect={onSelect}
            onMark={(region) => {
              setDrawing(false);
              setMark({ range: range ?? markRange(null, "start", playheadMs(), lengthMs), region });
            }}
          />
        ) : null}
      </div>
      <RangeStrip
        lengthMs={lengthMs}
        nowMs={nowMs}
        range={range}
        segments={segments.map((segment) => ({
          id: segment.thread.id,
          number: numbers.get(segment.thread.id) ?? 0,
          range: segment.range,
          resolved: segment.thread.state === "resolved",
        }))}
        selectedId={selectedId}
        canMark={model.canWrite}
        onSeek={seek}
        onRange={(next) => setMark({ region: mark?.region ?? null, range: next })}
        onSelect={(id) => {
          const segment = segments.find((candidate) => candidate.thread.id === id);
          if (segment !== undefined) selectSegment(segment.thread);
        }}
      />
      <div className="flex w-full flex-wrap items-center justify-center gap-1.5 text-xs text-white/80">
        <span className="font-mono tabular-nums">
          {formatClipTime(nowMs)} / {formatClipTime(lengthMs)}
        </span>
        {model.canWrite ? (
          <>
            <Button size="xs" variant="overlay" onClick={() => markAt("start")}>
              {gt("Mark start")} <Kbd>I</Kbd>
            </Button>
            <Button size="xs" variant="overlay" onClick={() => markAt("end")}>
              {gt("Mark end")} <Kbd>O</Kbd>
            </Button>
            <Button
              size="xs"
              variant="overlay"
              aria-pressed={drawing}
              disabled={!paused}
              onClick={() => setDrawing((current) => !current)}
            >
              <SquareDashedIcon aria-hidden />
              {drawing ? gt("Drag on the frame…") : gt("Mark an area")}
            </Button>
          </>
        ) : null}
      </div>
    </>
  );

  const panel = (
    <>
      {mark !== null && range !== null ? (
        <section className="flex flex-col gap-1.5">
          <h4 className="flex flex-wrap items-center gap-1.5 text-xs font-medium">
            <span>
              <T>
                New comment on{" "}
                <span className="font-mono tabular-nums">
                  <Var>{formatClipRange(range)}</Var>
                </span>
              </T>
            </span>
            {mark.region === null ? null : (
              <span className="text-muted-foreground">{gt("with a marked area")}</span>
            )}
          </h4>
          {/* Marking only a start keeps the keyboard on the clip, so O can mark the end. */}
          <CommentComposer
            key={range.endMs > range.startMs ? "range" : "moment"}
            autoFocus={range.endMs > range.startMs}
            draftKey={draftKey}
            label={gt("Comment on this part of the clip")}
            placeholder={gt("What happens here that should not, or should?")}
            submitLabel={gt("Comment", { $context: "verb, saves a review comment" })}
            onSubmit={(text) =>
              model.create(
                {
                  kind: "video-range",
                  packetHead: model.packet.revision.head,
                  ...(claimId === null ? {} : { claimId }),
                  media: visual.mediaId,
                  startMs: range.startMs,
                  endMs: range.endMs,
                  ...(mark.region === null ? {} : { region: mark.region }),
                },
                text,
              )
            }
            onCancel={clear}
          />
        </section>
      ) : model.canWrite ? (
        <p className="text-xs text-muted-foreground">
          {gt(
            "Drag along the bar under the clip to mark a range, or use Mark start and Mark end at the playhead.",
          )}
        </p>
      ) : null}
      <MediaThreads
        threads={threads}
        numbers={numbers}
        selectedId={selectedId}
        onSelect={selectSegment}
      />
    </>
  );
  return <ViewerLayout media={media} panel={panel} onKeyDown={onKeyDown} />;
}

/**
 * The clip's length as a bar: drag to mark a range, drag its ends to adjust it, tap to seek.
 * Existing comments are segments on it.
 */
function RangeStrip({
  lengthMs,
  nowMs,
  range,
  segments,
  selectedId,
  canMark,
  onSeek,
  onRange,
  onSelect,
}: {
  lengthMs: number;
  nowMs: number;
  range: ClipRange | null;
  segments: ReadonlyArray<{
    readonly id: string;
    readonly number: number;
    readonly range: ClipRange;
    readonly resolved: boolean;
  }>;
  selectedId: string | null;
  canMark: boolean;
  onSeek: (ms: number) => void;
  onRange: (range: ClipRange) => void;
  onSelect: (id: string) => void;
}) {
  const gt = useGT();
  const [drag, setDrag] = useState<{
    readonly kind: "new" | "start" | "end";
    readonly fromMs: number;
    readonly fromX: number;
    readonly box: Box;
    readonly moved: boolean;
  } | null>(null);
  const timeAt = (clientX: number, box: Box) =>
    timeAtFraction(fractionInBox(clientX, box.top, box).x, lengthMs);
  const begin = (
    event: PointerEvent<HTMLElement>,
    kind: "new" | "start" | "end",
    strip: HTMLElement,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    capturePointer(strip, event.pointerId);
    const box = boxOf(strip);
    setDrag({ kind, fromMs: timeAt(event.clientX, box), fromX: event.clientX, box, moved: false });
  };
  const update = (clientX: number, final: boolean) => {
    if (drag === null) return;
    const moved = drag.moved || Math.abs(clientX - drag.fromX) >= REGION_TAP_PX;
    const at = timeAt(clientX, drag.box);
    if (drag.kind === "new") {
      if (moved && canMark) onRange(rangeFromTimes(drag.fromMs, at, lengthMs));
      else if (final) onSeek(at);
    } else if (range !== null) {
      onRange(moveRangeEnd(range, drag.kind, at, lengthMs));
    }
    setDrag(final ? null : { ...drag, moved });
  };
  return (
    <div
      role="group"
      aria-label={gt("Clip timeline")}
      className="relative h-9 w-full max-w-3xl cursor-pointer touch-none select-none"
      onPointerDown={(event) => begin(event, "new", event.currentTarget)}
      onPointerMove={(event) => update(event.clientX, false)}
      onPointerUp={(event) => update(event.clientX, true)}
      onPointerCancel={() => setDrag(null)}
    >
      <span aria-hidden className="absolute inset-x-0 top-3.5 h-2 rounded-full bg-white/20" />
      {segments.map((segment) => (
        <button
          key={segment.id}
          type="button"
          aria-label={gt("Comment {number} at {range}", {
            number: segment.number,
            range: formatClipRange(segment.range),
          })}
          aria-pressed={selectedId === segment.id}
          className={cn(
            "absolute top-0.5 h-2.5 min-w-2 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-inset",
            selectedId === segment.id
              ? "bg-warning"
              : segment.resolved
                ? "bg-white/35"
                : "bg-warning/60 hover:bg-warning/85",
          )}
          style={rangePercentages(segment.range, lengthMs)}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onSelect(segment.id)}
        />
      ))}
      {range === null ? null : (
        <span
          className="absolute top-3 h-3 rounded-sm bg-info/45 ring-1 ring-info"
          style={rangePercentages(range, lengthMs)}
        >
          {canMark
            ? (["start", "end"] as const).map((end) => (
                <span
                  key={end}
                  role="slider"
                  tabIndex={0}
                  aria-label={end === "start" ? gt("Range start") : gt("Range end")}
                  aria-valuemin={0}
                  aria-valuemax={lengthMs}
                  aria-valuenow={end === "start" ? range.startMs : range.endMs}
                  aria-valuetext={formatClipTime(end === "start" ? range.startMs : range.endMs)}
                  className={cn(
                    "absolute -top-1.5 h-6 w-3 cursor-ew-resize rounded-sm bg-info outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-inset",
                    end === "start" ? "-left-1.5" : "-right-1.5",
                  )}
                  onPointerDown={(event) => {
                    const strip = event.currentTarget.closest<HTMLElement>("[role=group]");
                    if (strip !== null) begin(event, end, strip);
                  }}
                  onKeyDown={(event) => {
                    const delta =
                      event.key === "ArrowLeft" ? -100 : event.key === "ArrowRight" ? 100 : 0;
                    if (delta === 0) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const current = end === "start" ? range.startMs : range.endMs;
                    onRange(moveRangeEnd(range, end, current + delta, lengthMs));
                  }}
                />
              ))
            : null}
        </span>
      )}
      <span
        aria-hidden
        className="pointer-events-none absolute top-1 bottom-1 w-0.5 rounded-full bg-white"
        style={{ left: `${lengthMs > 0 ? Math.min(1, nowMs / lengthMs) * 100 : 0}%` }}
      />
    </div>
  );
}
