import { useAtomValue } from "@effect/atom-react";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";

import * as Dialog from "../../components/ui/Dialog";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";

/** Whether this device may open a coordinator in the environment; the server still decides. */
export function useCanOpenProjectCoordinator(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(projectEnvironment.openCoordinator.permissionAtom(environmentId));
}

/** Opens the project's coordinator thread, making one when the project has none live. */
export function useOpenProjectCoordinator(): (projectRef: ScopedProjectRef) => Promise<void> {
  const gt = useGT();
  const m = useMessages();
  const selectDetail = useSelectWorkspaceDetail();
  const openCoordinator = useAtomCommand(projectEnvironment.openCoordinator, {
    reportFailure: false,
  });
  return async (projectRef) => {
    const result = await openCoordinator({
      environmentId: projectRef.environmentId,
      input: { projectId: projectRef.projectId },
    });
    if (result._tag === "Success") {
      selectDetail({
        name: "Thread",
        params: {
          environmentId: String(projectRef.environmentId),
          threadId: String(result.value.threadId),
        },
      });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const cause = squashAtomCommandFailure(result);
    Dialog.alert(
      gt("Could not open the coordinator"),
      cause instanceof Error
        ? (errorDisplayMessage(cause, m) ?? cause.message)
        : gt("An error occurred."),
    );
  };
}
