import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react";
import { Gamepad2Icon } from "lucide-react";

import { useProject } from "../../state/entities";
import { useFilesystemReadAccess } from "../../state/filesystem";
import { harnessEnvironment } from "../../state/harness";
import { useEnvironmentQuery } from "../../state/query";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../CommandPalette.logic";
import { offersHarness, playDisabledReason } from "./harnessPlay.logic";
import { openHarnessPlay } from "./harnessPlayStore";

/** "Play this branch" for the open thread, when its checkout declares a harness. */
export function useHarnessPaletteItem(
  thread: {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  } | null,
): CommandPaletteActionItem | null {
  const gt = useGT();
  const resolve = useMessages();
  const checkoutPath = thread?.worktreePath ?? null;
  const { canReadFiles } = useFilesystemReadAccess(thread?.environmentId ?? null);
  const description = useEnvironmentQuery(
    thread === null || checkoutPath === null || !canReadFiles
      ? null
      : harnessEnvironment.describe({
          environmentId: thread.environmentId,
          input: { projectId: thread.projectId, worktreePath: checkoutPath },
        }),
  ).data;
  const canOperate = useAtomValue(
    harnessEnvironment.start.permissionAtom(thread?.environmentId ?? ("" as EnvironmentId)),
  );
  const project = useProject(
    thread === null ? null : scopeProjectRef(thread.environmentId, thread.projectId),
  );
  if (thread === null || checkoutPath === null || !offersHarness(description)) return null;
  const reason = playDisabledReason({ description, hasCheckout: true, canOperate }, resolve);
  return {
    kind: "action",
    value: "action:harness-play",
    searchTerms: ["play", "harness", "game", "playtest", "stream"],
    title: gt("Play this branch"),
    icon: <Gamepad2Icon className={ITEM_ICON_CLASS} />,
    ...(reason === null ? {} : { description: reason, disabled: true }),
    run: async () =>
      openHarnessPlay({
        environmentId: thread.environmentId,
        projectId: thread.projectId,
        projectTitle: project?.title ?? "",
        worktreePath: checkoutPath,
        threadId: thread.id,
      }),
  };
}
