import type { PacketVisual } from "@t3tools/client-runtime/review-packet";
import type { ReviewCommentState, ReviewPacket } from "@t3tools/contracts";
import { createContext, use } from "react";

import type { PacketCommentIntent } from "./PullRequestPacketCommentScreen";
import type {
  PacketChangeParams,
  PacketCommentsModel,
  useReviewCommentActions,
} from "./usePacketComments";

export interface PacketScreenModel {
  readonly change: PacketChangeParams;
  readonly packet: ReviewPacket;
  readonly comments: PacketCommentsModel;
  readonly actions: ReturnType<typeof useReviewCommentActions>;
  readonly filter: ReviewCommentState | null;
  readonly openComposer: (intent: PacketCommentIntent, context: string, clipMs?: number) => void;
  /** Shows a screenshot or clip full screen; images page through the ones beside it. */
  readonly openMedia: (visual: PacketVisual, row: ReadonlyArray<PacketVisual>) => void;
}

export const PacketScreenContext = createContext<PacketScreenModel | null>(null);

export function usePacketScreen(): PacketScreenModel {
  const model = use(PacketScreenContext);
  if (model === null) throw new Error("usePacketScreen needs a PacketScreenContext.");
  return model;
}
