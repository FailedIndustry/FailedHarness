import type { EnvironmentId } from "@t3tools/contracts";
import { ImageOffIcon, MessageSquareIcon } from "lucide-react";
import { T, useGT, Var } from "gt-react";
import { useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";

import { MediaVideoPlayer } from "../../media/MediaVideoPlayer";
import { usePacketComments } from "./PacketComments";
import { reviewMediaResource } from "./PacketMediaViewer";
import { threadsUnder } from "./packetComments.logic";
import { PACKET_LEAD_MEDIA, type PacketVisual } from "./reviewPacket.logic";

const TILE_CLASS_NAME =
  "relative h-24 aspect-video shrink-0 overflow-hidden rounded-md border border-border/60 bg-muted/40";

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * One row of evidence that scrolls sideways instead of shrinking, with the rest behind a final
 * "more" tile. Every item opens in the packet's media viewer, where it can be commented on.
 */
export function PacketMediaRow({
  environmentId,
  visuals,
  name,
  claimId,
}: {
  environmentId: EnvironmentId;
  visuals: ReadonlyArray<PacketVisual>;
  name: string;
  claimId: string | null;
}) {
  const gt = useGT();
  const model = usePacketComments();
  const lead = visuals.length > PACKET_LEAD_MEDIA ? visuals.slice(0, PACKET_LEAD_MEDIA) : visuals;
  const more = visuals.length - lead.length;
  const open = (index: number) =>
    model.openViewer({ visuals, index, name, claimId, threadId: null });
  // The same screenshot can back several claims; each counts the comments written under it.
  const openCount = (mediaId: string) =>
    threadsUnder(model.layout.byMedia.get(mediaId) ?? [], claimId).filter(
      (thread) => thread.state !== "resolved",
    ).length;
  const hiddenCount = visuals
    .slice(lead.length)
    .reduce((total, visual) => total + openCount(visual.mediaId), 0);

  return (
    <ul className="-mx-1 flex min-w-0 gap-2 overflow-x-auto px-1 pb-1">
      {lead.map((visual, index) => (
        <li
          key={visual.evidenceId}
          className={TILE_CLASS_NAME}
          data-packet-evidence={visual.evidenceId}
          data-packet-media={visual.mediaId}
        >
          {visual.kind === "clip" ? (
            <PacketClipTile
              environmentId={environmentId}
              visual={visual}
              name={visual.caption ?? name}
              onOpen={() => open(index)}
            />
          ) : (
            <PacketImageTile
              environmentId={environmentId}
              visual={visual}
              name={visual.caption ?? name}
              onOpen={() => open(index)}
            />
          )}
          <CommentCountBadge count={openCount(visual.mediaId)} />
        </li>
      ))}
      {more > 0 ? (
        <li className={TILE_CLASS_NAME}>
          <button
            type="button"
            onClick={() => open(lead.length)}
            aria-label={gt(
              "{count, plural, one {Show {count} more item} other {Show {count} more items}}",
              { count: more },
            )}
            className="flex size-full flex-col items-center justify-center gap-0.5 text-muted-foreground outline-none hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            <span className="text-lg font-medium tabular-nums">+{more}</span>
            <span className="text-xs">
              <T context="tile that opens the rest of a claim's screenshots and clips">more</T>
            </span>
          </button>
          <CommentCountBadge count={hiddenCount} />
        </li>
      ) : null}
    </ul>
  );
}

function CommentCountBadge({ count }: { count: number }) {
  const gt = useGT();
  if (count === 0) return null;
  return (
    <span
      role="img"
      aria-label={gt("{count, plural, one {{count} open comment} other {{count} open comments}}", {
        count,
      })}
      className="pointer-events-none absolute top-1 left-1 flex items-center gap-0.5 rounded-sm bg-black/70 px-1 text-3xs font-medium text-white tabular-nums"
    >
      <MessageSquareIcon aria-hidden className="size-2.5" />
      {count}
    </span>
  );
}

function PacketClipTile({
  environmentId,
  visual,
  name,
  onOpen,
}: {
  environmentId: EnvironmentId;
  visual: PacketVisual;
  name: string;
  onOpen: () => void;
}) {
  const url = useAssetUrlState(environmentId, reviewMediaResource(visual.mediaId));
  const durationMs = visual.media?.durationMs;
  return (
    <>
      <MediaVideoPlayer
        src={url._tag === "Success" ? url.url : null}
        sourceFailed={url._tag === "Failure"}
        label={name}
        onOpen={onOpen}
        className="block size-full"
        videoClassName="h-full object-cover"
        stateClassName="aspect-auto h-full rounded-none"
      />
      {durationMs === undefined ? null : (
        <span className="pointer-events-none absolute right-1 bottom-1 rounded-sm bg-black/60 px-1 font-mono text-3xs text-white tabular-nums">
          {formatDuration(durationMs)}
        </span>
      )}
    </>
  );
}

function PacketImageTile({
  environmentId,
  visual,
  name,
  onOpen,
}: {
  environmentId: EnvironmentId;
  visual: PacketVisual;
  name: string;
  onOpen: () => void;
}) {
  const gt = useGT();
  const url = useAssetUrlState(environmentId, reviewMediaResource(visual.mediaId));
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = url._tag === "Success" ? url.url : null;
  const failed = url._tag === "Failure" || (src !== null && failedSrc === src);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={gt("Open {name}", { name })}
      className="block size-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      {failed ? (
        <span className="flex size-full flex-col items-center justify-center gap-1 p-2 text-center text-xs text-muted-foreground">
          <ImageOffIcon aria-hidden className="size-4" />
          <T>
            Could not load <Var>{name}</Var>
          </T>
        </span>
      ) : src === null ? null : (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-full object-cover"
          onError={() => setFailedSrc(src)}
        />
      )}
    </button>
  );
}
