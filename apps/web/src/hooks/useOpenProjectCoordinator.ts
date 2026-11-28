import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";

import { toastManager } from "../components/ui/toast";
import { m } from "../i18n/messages";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";

/** Whether this client may open a coordinator in the environment; the server still decides. */
export const canOpenProjectCoordinator = (projectRef: ScopedProjectRef) =>
  appAtomRegistry.get(projectEnvironment.openCoordinator.permissionAtom(projectRef.environmentId));

/** Opens the project's coordinator thread, making one when the project has none live. */
export function useOpenProjectCoordinator(): (projectRef: ScopedProjectRef) => Promise<void> {
  const gt = useGT();
  const navigate = useNavigate();
  const openCoordinator = useAtomCommand(projectEnvironment.openCoordinator, {
    reportFailure: false,
  });
  return async (projectRef) => {
    const result = await openCoordinator({
      environmentId: projectRef.environmentId,
      input: { projectId: projectRef.projectId },
    });
    if (result._tag === "Success") {
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(
          scopeThreadRef(projectRef.environmentId, result.value.threadId),
        ),
      });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    toastManager.add({
      type: "error",
      title: gt("Could not open the coordinator"),
      description:
        thrownErrorMessage(squashAtomCommandFailure(result), m) ?? gt("An error occurred."),
    });
  };
}
