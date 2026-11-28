import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthTerminalOperateScope,
  isHarnessDoctorRowReady,
  type HarnessDoctorResult,
} from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";
import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";

import { m } from "../../i18n/messages";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { useEnvironments } from "../../state/environments";
import { filesystemEnvironment, useFilesystemReadAccess } from "../../state/filesystem";
import { harnessEnvironment, harnessSnapshotAtom } from "../../state/harness";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { harnessBlockReason, offersHarness } from "../harness/harnessPlay.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** The harness each checkout's `t3.json` declares, whether it may run, and its dependencies. */
export function ProjectHarnessSettings({
  members,
}: {
  members: ReadonlyArray<SidebarProjectGroupMember>;
}) {
  const checkouts = members.filter((member) => !member.isScratch);
  return checkouts.map((member) => (
    <CheckoutHarness
      key={member.physicalProjectKey}
      member={member}
      showCheckout={checkouts.length > 1}
    />
  ));
}

function CheckoutHarness({
  member,
  showCheckout,
}: {
  member: SidebarProjectGroupMember;
  showCheckout: boolean;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const environmentId = member.environmentId;
  const projectId = member.id;
  const { environments } = useEnvironments();
  const isConnected =
    environments.find((entry) => entry.environmentId === environmentId)?.connection.phase ===
    "connected";
  const { canReadFiles } = useFilesystemReadAccess(environmentId);
  const describe = useEnvironmentQuery(
    canReadFiles ? harnessEnvironment.describe({ environmentId, input: { projectId } }) : null,
  );
  const snapshot = useEnvironmentQuery(harnessSnapshotAtom(environmentId)).data;
  const canApprove = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const canRun = useAtomValue(harnessEnvironment.doctor.permissionAtom(environmentId));
  const approve = useAtomCommand(filesystemEnvironment.approveLayoutCommands, {
    reportFailure: false,
  });
  const runDoctor = useAtomCommand(harnessEnvironment.doctor, { reportFailure: false });
  const runSetup = useAtomCommand(harnessEnvironment.setup, { reportFailure: false });
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [doctor, setDoctor] = useState<HarnessDoctorResult | null>(null);
  const [doctorError, setDoctorError] = useState<string | null>(null);
  const setup = snapshot?.setups.find((entry) => entry.projectId === projectId) ?? null;
  const setupRunning = setup?.phase === "running";

  const check = async () => {
    setChecking(true);
    setDoctorError(null);
    const result = await runDoctor({ environmentId, input: { projectId } });
    setChecking(false);
    if (result._tag === "Failure") {
      setDoctorError(
        thrownErrorMessage(squashAtomCommandFailure(result), m) ??
          m(msg("The harness check failed.")),
      );
      return;
    }
    setDoctor(result.value);
  };

  const checkAfterSetup = useStableCallback(() => {
    if (canRun) void check();
  });
  const lastSetupPhase = useRef(setup?.phase ?? null);
  const setupPhase = setup?.phase ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a setup that finishes on the server changes what the project's doctor reports, so it runs again
  useEffect(() => {
    const previous = lastSetupPhase.current;
    lastSetupPhase.current = setupPhase;
    if (previous === "running" && setupPhase !== "running" && setupPhase !== null)
      checkAfterSetup();
  }, [setupPhase, checkAfterSetup]);

  const description = describe.data;
  if (!offersHarness(description)) return null;
  const declared = description.declared ?? "";
  const policyOff = description.blocked === "policy";
  const blockReason = harnessBlockReason(description, resolve);

  // Approving sends the path on screen, so a file that changed since is not approved unseen.
  const save = async (approved: boolean) => {
    setSaving(true);
    const result = await approve({
      environmentId,
      input: { projectId, approvals: [{ kind: "harness", command: approved ? declared : null }] },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: approved ? gt("Could not approve the harness") : gt("Could not revoke the approval"),
        ...(error instanceof Error ? { description: error.message } : {}),
      });
    }
    describe.refresh();
  };

  const startSetup = async () => {
    const result = await runSetup({ environmentId, input: { projectId } });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: gt("Could not start the harness setup"),
        description: thrownErrorMessage(squashAtomCommandFailure(result), m) ?? undefined,
      });
    }
  };

  return (
    <SettingsSection title={gt("Harness")}>
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        <T>
          This project's <code>t3.json</code> names a harness: an executable that builds and runs
          the project so you can play a branch and agents can run playtests. It runs on this
          environment's machine with your permissions, and only as approved here. Each checkout gets
          its own slot of ports and an output folder outside the checkout.
        </T>
        {showCheckout ? (
          <span className="mt-1 block truncate">
            {member.environmentLabel ?? gt("Environment")} · {member.workspaceRoot}
          </span>
        ) : null}
      </p>
      <SettingsRow
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate">
              <T>Harness path</T>
            </span>
            {policyOff ? (
              <Badge size="sm" variant="outline">
                <T>Off</T>
              </Badge>
            ) : description.approved ? (
              <Badge size="sm" variant="success">
                <T>Approved</T>
              </Badge>
            ) : (
              <Badge size="sm" variant="warning">
                <T>Needs approval</T>
              </Badge>
            )}
          </span>
        }
        description={blockReason ?? undefined}
        control={
          <Button
            size="xs"
            variant={description.approved ? "ghost" : "outline"}
            disabled={
              !canApprove ||
              !isConnected ||
              saving ||
              describe.isPending ||
              (!description.approved && policyOff)
            }
            aria-label={
              description.approved
                ? gt("Revoke approval of the harness")
                : gt("Approve the harness")
            }
            onClick={() => void save(!description.approved)}
          >
            {description.approved ? <T>Revoke</T> : <T>Approve</T>}
          </Button>
        }
      >
        <pre className="mb-2 max-h-48 overflow-auto whitespace-pre-wrap wrap-anywhere rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs">
          {declared}
        </pre>
      </SettingsRow>
      <HarnessCacheFolder
        environmentId={environmentId}
        projectId={projectId}
        cachePath={description.cachePath}
        defaultCachePath={description.defaultCachePath}
        disabled={!isConnected}
        onSaved={describe.refresh}
      />
      <SettingsRow
        title={gt("Dependencies")}
        description={
          setupRunning
            ? gt("Setup is running on the environment's machine.")
            : setup?.phase === "failed"
              ? (setup.error ?? gt("The last setup failed."))
              : setup?.phase === "succeeded"
                ? gt("The last setup finished.")
                : gt("Check runs the harness's doctor; Run setup installs what it reports missing.")
        }
        control={
          <span className="flex items-center gap-1.5">
            <Button
              size="xs"
              variant="outline"
              disabled={!canRun || !isConnected || checking || blockReason !== null}
              onClick={() => void check()}
            >
              {checking ? <Spinner /> : null}
              <T context="verb, checks the harness dependencies">Check</T>
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={!canRun || !isConnected || setupRunning || blockReason !== null}
              onClick={() => void startSetup()}
            >
              {setupRunning ? <Spinner /> : null}
              <T>Run setup</T>
            </Button>
          </span>
        }
      >
        {doctorError ? (
          <p role="alert" className="mb-2 text-xs text-warning-foreground">
            {doctorError}
          </p>
        ) : null}
        {doctor ? (
          <ul className="mb-2 flex flex-col gap-2">
            {doctor.rows.map((row) => {
              const ready = isHarnessDoctorRowReady(row);
              const help = [row.fix, row.instructions].filter(Boolean).join("\n");
              return (
                <li key={row.id} className="flex min-w-0 flex-col gap-1 text-xs">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate font-medium">{row.name ?? row.id}</span>
                    <Badge size="sm" variant={ready ? "success" : "warning"}>
                      {row.state}
                    </Badge>
                  </span>
                  {row.detail ? (
                    <span className="text-muted-foreground wrap-anywhere">{row.detail}</span>
                  ) : null}
                  {!ready && help ? (
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap wrap-anywhere rounded-md border bg-muted/40 px-3 py-2 font-mono">
                      {help}
                    </pre>
                  ) : null}
                </li>
              );
            })}
            {doctor.rows.length === 0 ? (
              <li className="text-xs text-muted-foreground">
                <T>The doctor reported no dependencies.</T>
              </li>
            ) : null}
          </ul>
        ) : null}
      </SettingsRow>
      {!canApprove ? (
        <p className="px-3 py-2 text-xs text-muted-foreground sm:px-4">
          <T>This connection cannot approve the harness. Use a client that can use the terminal.</T>
        </p>
      ) : null}
    </SettingsSection>
  );
}

/**
 * Where the harness keeps installed tools and downloads for this project. A folder it already
 * filled outside T3 Code saves a fresh download; reset goes back to T3 Code's own folder.
 */
function HarnessCacheFolder(props: {
  environmentId: SidebarProjectGroupMember["environmentId"];
  projectId: SidebarProjectGroupMember["id"];
  cachePath: string | null;
  defaultCachePath: string;
  disabled: boolean;
  onSaved: () => void;
}) {
  const gt = useGT();
  const canSave = useAtomValue(harnessEnvironment.setCachePath.permissionAtom(props.environmentId));
  const save = useAtomCommand(harnessEnvironment.setCachePath, { reportFailure: false });
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const value = draft ?? props.cachePath ?? "";

  const apply = async (cachePath: string | null) => {
    setSaving(true);
    const result = await save({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, cachePath },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: gt("Could not save the harness cache folder"),
        description: thrownErrorMessage(squashAtomCommandFailure(result), m) ?? undefined,
      });
      return;
    }
    setDraft(null);
    props.onSaved();
  };

  const trimmed = value.trim();
  const unchanged = trimmed === (props.cachePath ?? "");
  return (
    <SettingsRow
      title={gt("Harness cache folder")}
      description={
        props.cachePath === null
          ? gt("Installed tools and downloads go to T3 Code's own folder: {path}", {
              path: props.defaultCachePath,
            })
          : gt(
              "Installed tools and downloads go to this folder, shared by the project's checkouts.",
            )
      }
      control={
        <span className="flex items-center gap-1.5">
          <Button
            size="xs"
            variant="outline"
            disabled={!canSave || props.disabled || saving || unchanged || trimmed === ""}
            onClick={() => void apply(trimmed)}
          >
            {saving ? <Spinner /> : null}
            <T>Save</T>
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={!canSave || props.disabled || saving || props.cachePath === null}
            onClick={() => void apply(null)}
          >
            <T context="verb, goes back to the default folder">Reset</T>
          </Button>
        </span>
      }
    >
      <Input
        className="mb-2"
        size="sm"
        value={value}
        placeholder={props.defaultCachePath}
        disabled={!canSave || props.disabled || saving}
        aria-label={gt("Harness cache folder")}
        onChange={(event) => setDraft(event.target.value)}
      />
    </SettingsRow>
  );
}
