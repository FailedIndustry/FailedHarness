import {
  HarnessDoctorOutput,
  HarnessError,
  HarnessFailureOutput,
  HarnessMarkOutput,
  HarnessPacketOutput,
  HarnessSessionId,
  HarnessSessionOutput,
  HarnessSessionStatusOutput,
  HarnessSessionStopOutput,
  isHarnessDoctorRowReady,
  T3_PROJECT_FILE_NAME,
  type HarnessAttach,
  type HarnessDescribeInput,
  type HarnessDescription,
  type HarnessDoctorResult,
  type HarnessDoctorRow,
  type HarnessMarkInput,
  type HarnessNetwork,
  type HarnessPacketOutcome,
  type HarnessSession,
  type HarnessSessionBy,
  type HarnessSetupState,
  type HarnessSnapshot,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Hex from "effect/encoding/Hex";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProcessRunner from "../processRunner.ts";
import { unsetInheritedRepositoryEnv } from "../vcs/VcsProcess.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";
import * as LayoutCommandApprovals from "../workspace/LayoutCommandApprovals.ts";
import type { ProjectCommands, ProjectCommandsNow } from "../workspace/TaskFolders.ts";

/** Where the stream proxy serves a session; the harness is told to serve Selkies under it. */
export const HARNESS_STREAM_ROUTE_PREFIX = "/api/harness/stream";

const HARNESS_SLOT_COUNT = 100;

const VERB_TIMEOUTS = {
  doctor: "1 minute",
  setup: "3 hours",
  prepare: "30 minutes",
  sessionStart: "5 minutes",
  sessionStop: "15 minutes",
  sessionStatus: "30 seconds",
  mark: "30 seconds",
  packet: "15 minutes",
} as const satisfies Record<string, Duration.Input>;

const STATUS_POLL_INTERVAL = "15 seconds";
const OUTPUT_MAX_BYTES = 1024 * 1024;

/** What the stream proxy needs for one viewer: the fixed target and the credential to add. */
export interface HarnessStreamTarget {
  readonly origin: string;
  /** Upstream path the stream page lives under, ending in `/`. */
  readonly basePath: string;
  readonly authorization: string | null;
  /** Completes when the viewer token stops being valid. */
  readonly revoked: Effect.Effect<void>;
}

export class HarnessService extends Context.Service<
  HarnessService,
  {
    readonly describe: (
      input: HarnessDescribeInput,
    ) => Effect.Effect<HarnessDescription, HarnessError>;
    readonly snapshot: Effect.Effect<HarnessSnapshot>;
    /** The snapshot now, then again after every change. */
    readonly changes: Stream.Stream<HarnessSnapshot>;
    readonly start: (input: {
      readonly projectId: ProjectId;
      /** The project folder when absent, as for a thread without its own worktree. */
      readonly worktreePath?: string | undefined;
      readonly threadId?: ThreadId | undefined;
      readonly by: HarnessSessionBy;
      readonly net?: HarnessNetwork | undefined;
      readonly projectCommands: ProjectCommandsNow;
    }) => Effect.Effect<HarnessSession, HarnessError>;
    readonly stop: (input: {
      readonly sessionId: HarnessSessionId;
    }) => Effect.Effect<HarnessSession, HarnessError>;
    readonly mark: (input: HarnessMarkInput) => Effect.Effect<HarnessSession, HarnessError>;
    /** Mints a viewer token for a streamed session, valid until `invalidated` or the session ends. */
    readonly viewer: (input: {
      readonly sessionId: HarnessSessionId;
      readonly invalidated: Effect.Effect<void>;
    }) => Effect.Effect<{ readonly path: string }, HarnessError>;
    /** The proxy's lookup; None for an unknown session or token. */
    readonly streamTarget: (
      sessionId: string,
      token: string,
    ) => Effect.Effect<Option.Option<HarnessStreamTarget>>;
    readonly doctor: (input: {
      readonly projectId: ProjectId;
      readonly projectCommands: ProjectCommandsNow;
    }) => Effect.Effect<HarnessDoctorResult, HarnessError>;
    /** Starts `setup` in the background; its progress is in the snapshot. */
    readonly setup: (input: {
      readonly projectId: ProjectId;
      readonly projectCommands: ProjectCommandsNow;
    }) => Effect.Effect<HarnessSetupState, HarnessError>;
    /** Runs `prepare` in the background, as for a new worktree; failures are only logged. */
    readonly prepareInBackground: (input: {
      readonly projectId: ProjectId;
      readonly worktreePath: string;
      readonly projectCommands: ProjectCommandsNow;
    }) => Effect.Effect<void>;
    /** Runs `packet` and answers with the folder it assembled. */
    readonly packet: (input: {
      readonly projectId: ProjectId;
      readonly worktreePath: string;
      readonly projectCommands: ProjectCommandsNow;
    }) => Effect.Effect<{ readonly directory: string }, HarnessError>;
    /**
     * The variables the session's verbs ran with, for an agent running the harness's own
     * commands against the same session. None for a session this server does not hold.
     */
    readonly commandEnv: (
      sessionId: HarnessSessionId,
    ) => Effect.Effect<Option.Option<Readonly<Record<string, string>>>>;
    /** Records what became of the packet collected after a session. */
    readonly notePacket: (
      sessionId: HarnessSessionId,
      outcome: HarnessPacketOutcome,
    ) => Effect.Effect<void>;
    /**
     * Before a checkout goes: stops the session this server started there, frees its slot and
     * deletes its output folder.
     */
    readonly releaseCheckout: (worktreePath: string) => Effect.Effect<void>;
  }
>()("t3/harness/HarnessService") {}

const refusals: Record<Exclude<HarnessDescription["blocked"], null>, string> = {
  "not-declared": `this checkout's ${T3_PROJECT_FILE_NAME} declares no harness.`,
  "not-found": "the executable its harness path names is not a file inside the checkout.",
  "not-approved":
    "nobody has approved the project's harness as it is declared now. Approve it in the project's settings in the web or desktop app.",
  policy: "your organization's policy turns project commands off.",
  "not-permitted":
    "an agent can only have it run from a thread in Full access, and this request may not run project commands.",
};

const refuse = (blocked: keyof typeof refusals, detail?: string) =>
  new HarnessError({
    reason: blocked,
    detail: `The project's harness cannot run: ${detail ?? refusals[blocked]}`,
  });

const unavailable = (detail: string) => new HarnessError({ reason: "unavailable", detail });

const decodeJson = (text: string): Option.Option<unknown> => {
  try {
    return Option.some(JSON.parse(text) as unknown);
  } catch {
    return Option.none();
  }
};

/** A verb prints one JSON document; a harness that also prints lines first is read by its last. */
export const parseVerbJson = (stdout: string): Option.Option<unknown> => {
  const whole = decodeJson(stdout.trim());
  if (Option.isSome(whole)) return whole;
  const lines = stdout.trim().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line === "") continue;
    return decodeJson(line);
  }
  return Option.none();
};

const lastLines = (text: string, count: number) =>
  text.trim().split("\n").slice(-count).join("\n").slice(-600);

const failureMessage = (stdout: string, stderr: string): string => {
  const parsed = parseVerbJson(stdout).pipe(
    Option.flatMap(Schema.decodeUnknownOption(HarnessFailureOutput)),
  );
  if (Option.isSome(parsed) && parsed.value.error !== undefined) {
    return typeof parsed.value.error === "string" ? parsed.value.error : parsed.value.error.message;
  }
  const tail = lastLines(stderr, 3);
  return tail === "" ? "it printed no reason." : tail;
};

interface CheckoutContext {
  readonly projectId: ProjectId;
  readonly projectRoot: string;
  readonly checkout: string;
  readonly executable: string;
}

interface LiveSession {
  session: HarnessSession;
  readonly context: CheckoutContext;
  readonly env: NodeJS.ProcessEnv;
  target: Omit<HarnessStreamTarget, "revoked"> | null;
  readonly viewers: Map<string, Deferred.Deferred<void>>;
  poller: Fiber.Fiber<void> | null;
}

const isLive = (session: HarnessSession) =>
  session.phase === "starting" || session.phase === "running" || session.phase === "stopping";

const basicAuthorization = (user: string, password: string) =>
  `Basic ${Base64.encode(new TextEncoder().encode(`${user}:${password}`))}`;

/** The loopback target of a streamed session: the port of its attach URL, on 127.0.0.1. */
export const streamTargetFor = (
  attach: HarnessAttach | null | undefined,
  slot: number,
): Omit<HarnessStreamTarget, "revoked"> | null => {
  if (attach === null || attach === undefined) return null;
  let port = attach.port ?? null;
  if (port === null && attach.url) {
    try {
      const url = new URL(attach.url);
      port = url.port === "" ? null : Number(url.port);
    } catch {
      port = null;
    }
  }
  port ??= 5900 + slot;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const raw = attach.path ?? "/";
  const basePath = `${raw.startsWith("/") ? "" : "/"}${raw}${raw.endsWith("/") ? "" : "/"}`;
  return {
    origin: `http://127.0.0.1:${port}`,
    basePath,
    authorization:
      attach.user && attach.password ? basicAuthorization(attach.user, attach.password) : null,
  };
};

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const digest = yield* Digest.Digest;
  const random = yield* SecureRandom.SecureRandom;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const approvals = yield* LayoutCommandApprovals.LayoutCommandApprovals;
  const managedPolicy = yield* ManagedPolicy.ManagedPolicy;
  const processes = yield* ProcessRunner.ProcessRunner;
  const hostEnvironment = yield* HostProcess.Environment;
  const hostPlatform = yield* HostProcess.Platform;
  const serviceScope = yield* Effect.scope;
  const commandsOffBy = ManagedPolicy.deniedBy(managedPolicy, "worktreeLayoutCommands");

  const live = new Map<string, LiveSession>();
  const claimed = new Set<string>();
  const setups = new Map<ProjectId, HarnessSetupState>();
  const checkoutLocks = yield* KeyedLock.make<string>();
  const slotLock = yield* Semaphore.make(1);
  const snapshotRef = yield* SubscriptionRef.make<HarnessSnapshot>({ sessions: [], setups: [] });

  const currentSnapshot = (): HarnessSnapshot => ({
    sessions: [...live.values()].map((entry) => entry.session),
    setups: [...setups.values()],
  });
  const publish = Effect.suspend(() => SubscriptionRef.set(snapshotRef, currentSnapshot()));
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const exists = (target: string) =>
    fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));
  const realPath = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));
  const harnessRoot = path.join(config.stateDir, "harness");
  const safeSegment = (value: string) => value.replace(/[^A-Za-z0-9_.-]/g, "_");
  const cachePathFor = (projectId: ProjectId) =>
    path.join(harnessRoot, "cache", safeSegment(projectId));
  const outputPathFor = (checkout: string) =>
    digest.digest(Digest.sha256, new TextEncoder().encode(path.resolve(checkout))).pipe(
      Effect.map((bytes) => path.join(harnessRoot, "output", Hex.encode(bytes).slice(0, 16))),
      Effect.orDie,
    );

  const readProjectRoot = Effect.fnUntraced(function* (projectId: ProjectId) {
    const row = yield* projects
      .get(projectId)
      .pipe(Effect.mapError(() => unavailable("Could not read the project.")));
    if (Option.isNone(row)) return yield* unavailable(`Project ${projectId} was not found.`);
    return path.resolve(row.value.workspaceRoot);
  });

  const declaredIn = (checkout: string) =>
    fileSystem.readFileString(path.join(checkout, T3_PROJECT_FILE_NAME)).pipe(
      Effect.map((contents) => parseT3ProjectFile(contents)?.harness ?? null),
      Effect.orElseSucceed(() => null),
    );

  const isApproved = (projectId: ProjectId, declared: string) =>
    approvals.isApproved({ projectId, kind: "harness", command: declared }).pipe(
      // An approval that cannot be read is not one.
      Effect.catch((cause) => Effect.logWarning(cause.detail, { cause }).pipe(Effect.as(false))),
    );

  /** The executable when it is a file inside the checkout, symlinks resolved. */
  const executableIn = Effect.fnUntraced(function* (checkout: string, declared: string) {
    const candidate = path.resolve(checkout, declared);
    if (!isWithinRoot(path, candidate, checkout)) return null;
    const [realCandidate, realCheckout] = [yield* realPath(candidate), yield* realPath(checkout)];
    if (!isWithinRoot(path, realCandidate, realCheckout)) return null;
    const info = yield* fileSystem.stat(realCandidate).pipe(Effect.option);
    return Option.exists(info, (stat) => stat.type === "File") ? candidate : null;
  });

  /**
   * Who asked, the checkout's `t3.json`, policy and the approval, read at every run so a file or
   * approval that changed is what counts. Fails with the reason it may not run.
   */
  const clear = Effect.fnUntraced(function* (input: {
    readonly projectId: ProjectId;
    readonly worktreePath?: string | undefined;
    readonly projectCommands: ProjectCommandsNow;
  }) {
    const projectRoot = yield* readProjectRoot(input.projectId);
    const checkout =
      input.worktreePath === undefined ? projectRoot : path.resolve(input.worktreePath);
    const declared = yield* declaredIn(checkout);
    if (declared === null) return yield* refuse("not-declared");
    const asked: ProjectCommands =
      typeof input.projectCommands === "string"
        ? input.projectCommands
        : yield* input.projectCommands;
    if (asked !== "permitted") return yield* refuse("not-permitted");
    if (commandsOffBy !== undefined)
      return yield* refuse(
        "policy",
        `${commandsOffBy}'s policy turns project commands off, the harness included.`,
      );
    if (!(yield* isApproved(input.projectId, declared))) return yield* refuse("not-approved");
    const executable = yield* executableIn(checkout, declared);
    if (executable === null) return yield* refuse("not-found");
    return { projectId: input.projectId, projectRoot, checkout, executable } as CheckoutContext;
  });

  const assignSlot = Effect.fn("HarnessService.assignSlot")(function* (
    projectId: ProjectId,
    checkout: string,
  ) {
    return yield* slotLock
      .withPermits(1)(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly worktreePath: string;
            readonly slot: number;
            readonly sessionId: string | null;
          }>`
          SELECT worktree_path AS "worktreePath", slot, session_id AS "sessionId"
          FROM harness_checkouts WHERE project_id = ${projectId}
        `;
          const own = rows.find((row) => row.worktreePath === checkout);
          if (own !== undefined) return own.slot;
          const used = new Set<number>();
          for (const row of rows) {
            // A checkout that is gone frees its slot, unless a session there is still ours to stop.
            if (row.sessionId === null && !(yield* exists(row.worktreePath))) {
              yield* sql`DELETE FROM harness_checkouts WHERE worktree_path = ${row.worktreePath}`;
            } else {
              used.add(row.slot);
            }
          }
          let slot = 0;
          while (used.has(slot)) slot += 1;
          if (slot >= HARNESS_SLOT_COUNT) {
            return yield* new HarnessError({
              reason: "slots-exhausted",
              detail: `All ${HARNESS_SLOT_COUNT} harness slots of this project are taken by live checkouts.`,
            });
          }
          const assignedAt = yield* nowIso;
          yield* sql`
          INSERT INTO harness_checkouts (worktree_path, project_id, slot, session_id, assigned_at)
          VALUES (${checkout}, ${projectId}, ${slot}, NULL, ${assignedAt})
          ON CONFLICT (worktree_path) DO UPDATE SET
            project_id = excluded.project_id, slot = excluded.slot, session_id = NULL,
            assigned_at = excluded.assigned_at
        `;
          return slot;
        }),
      )
      .pipe(
        Effect.catchTags({
          SqlError: () =>
            Effect.fail(unavailable("Could not read or record the checkout's harness slot.")),
        }),
      );
  });

  const recordSessionId = (checkout: string, sessionId: string | null) =>
    sql`UPDATE harness_checkouts SET session_id = ${sessionId} WHERE worktree_path = ${checkout}`.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("could not record the harness session", { cause }),
      ),
      Effect.asVoid,
    );

  const envFor = Effect.fnUntraced(function* (context: CheckoutContext, slot: number) {
    const cachePath = cachePathFor(context.projectId);
    const outputPath = yield* outputPathFor(context.checkout);
    yield* Effect.forEach([cachePath, outputPath], (folder) =>
      fileSystem
        .makeDirectory(folder, { recursive: true })
        .pipe(Effect.mapError(() => unavailable(`Could not create the harness folder ${folder}.`))),
    );
    return {
      ...hostEnvironment,
      // A `GIT_DIR` the server inherited would point the harness's Git at another repository.
      ...unsetInheritedRepositoryEnv(hostEnvironment, hostPlatform),
      T3CODE_PROJECT_ROOT: context.projectRoot,
      T3CODE_WORKTREE_PATH: context.checkout,
      T3CODE_CACHE_PATH: cachePath,
      T3CODE_OUTPUT_PATH: outputPath,
      T3CODE_SLOT: String(slot),
    } satisfies NodeJS.ProcessEnv;
  });

  /** Runs one verb and decodes its JSON answer with `schema`; exit codes other than 0 fail. */
  const runVerb = Effect.fn("HarnessService.runVerb")(function* <
    S extends Schema.Decoder<unknown>,
  >(input: {
    readonly context: CheckoutContext;
    readonly env: NodeJS.ProcessEnv;
    readonly args: ReadonlyArray<string>;
    readonly timeout: Duration.Input;
    readonly schema: S;
    /** Exit codes that still answer with a document, as `doctor` exits 1 when something is missing. */
    readonly acceptExitCodes?: ReadonlyArray<number>;
  }) {
    yield* Effect.annotateCurrentSpan({ verb: input.args.join(" ") });
    const verb = input.args.filter((arg) => !arg.startsWith("-")).join(" ");
    const result = yield* processes
      .run({
        command: input.context.executable,
        args: input.args,
        cwd: input.context.checkout,
        env: input.env,
        timeout: input.timeout,
        maxOutputBytes: OUTPUT_MAX_BYTES,
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new HarnessError({
              reason: "verb-failed",
              detail: `The harness's ${verb} could not run: ${cause.message}`,
            }),
        ),
      );
    if (result.timedOut) {
      return yield* new HarnessError({
        reason: "verb-failed",
        detail: `The harness's ${verb} did not finish in ${Duration.format(Duration.fromInputUnsafe(input.timeout))}.`,
      });
    }
    const code = Number(result.code ?? -1);
    if (code !== 0 && !(input.acceptExitCodes ?? []).includes(code)) {
      return yield* new HarnessError({
        reason: "verb-failed",
        detail: `The harness's ${verb} failed (exit ${code}): ${failureMessage(result.stdout, result.stderr)}`,
      });
    }
    const decoded = parseVerbJson(result.stdout).pipe(
      Option.flatMap(Schema.decodeUnknownOption(input.schema)),
    );
    if (Option.isNone(decoded)) {
      return yield* new HarnessError({
        reason: "invalid-output",
        detail: `The harness's ${verb} did not print the JSON document T3 Code reads.`,
      });
    }
    return decoded.value as S["Type"];
  });

  const describe: HarnessService["Service"]["describe"] = Effect.fn("HarnessService.describe")(
    function* (input) {
      const projectRoot = yield* readProjectRoot(input.projectId);
      const checkout =
        input.worktreePath === undefined ? projectRoot : path.resolve(input.worktreePath);
      const declared = yield* declaredIn(checkout);
      if (declared === null)
        return { declared, approved: false, blocked: "not-declared", policyBy: null } as const;
      const approved = yield* isApproved(input.projectId, declared);
      const blocked =
        commandsOffBy !== undefined
          ? ("policy" as const)
          : !approved
            ? ("not-approved" as const)
            : (yield* executableIn(checkout, declared)) === null
              ? ("not-found" as const)
              : null;
      return { declared, approved, blocked, policyBy: commandsOffBy ?? null };
    },
  );

  const update = (entry: LiveSession, patch: Partial<HarnessSession>) =>
    Effect.suspend(() => {
      entry.session = { ...entry.session, ...patch };
      return publish;
    });

  const endViewers = (entry: LiveSession) =>
    Effect.forEach(entry.viewers.values(), (revoked) => Deferred.succeed(revoked, undefined), {
      discard: true,
    }).pipe(Effect.andThen(Effect.sync(() => entry.viewers.clear())));

  const finish = Effect.fnUntraced(function* (
    entry: LiveSession,
    patch: Partial<HarnessSession> & Pick<HarnessSession, "phase">,
  ) {
    entry.target = null;
    yield* endViewers(entry);
    const poller = entry.poller;
    entry.poller = null;
    yield* update(entry, { ...patch, endedAt: yield* nowIso });
    yield* recordSessionId(entry.context.checkout, null);
    if (poller !== null) yield* Fiber.interrupt(poller).pipe(Effect.forkIn(serviceScope));
  });

  // A session can end on its own (the game quit); `session status` says so.
  const pollStatus = Effect.fn("HarnessService.pollStatus")(function* (entry: LiveSession) {
    while (true) {
      yield* Effect.sleep(STATUS_POLL_INTERVAL);
      if (entry.session.phase !== "running") return;
      const status = yield* runVerb({
        context: entry.context,
        env: entry.env,
        args: ["session", "status"],
        timeout: VERB_TIMEOUTS.sessionStatus,
        schema: HarnessSessionStatusOutput,
      }).pipe(Effect.option);
      if (Option.isNone(status) || entry.session.phase !== "running") continue;
      if (status.value.running === false) {
        yield* finish(entry, { phase: "stopped", error: "The session ended on its own." });
        return;
      }
      const markCount = status.value.markCount;
      if (typeof markCount === "number" && markCount !== entry.session.markCount) {
        yield* update(entry, { markCount: Math.max(0, Math.trunc(markCount)) });
      }
    }
  });

  const sessionEntry = (sessionId: string) => {
    for (const entry of live.values()) if (entry.session.id === sessionId) return entry;
    return undefined;
  };
  const requireEntry = (sessionId: string) =>
    Effect.suspend(() => {
      const entry = sessionEntry(sessionId);
      return entry === undefined
        ? Effect.fail(
            new HarnessError({
              reason: "session-not-found",
              detail: "T3 Code has no harness session with that id.",
            }),
          )
        : Effect.succeed(entry);
    });

  const start: HarnessService["Service"]["start"] = Effect.fn("HarnessService.start")(
    function* (input) {
      const context = yield* clear(input);
      const existing = live.get(context.checkout);
      // Checked and claimed in one step, so two starts of one checkout cannot both pass.
      if (claimed.has(context.checkout) || (existing !== undefined && isLive(existing.session))) {
        return yield* new HarnessError({
          reason: "session-running",
          detail: "This checkout already has a harness session. Stop it first.",
        });
      }
      claimed.add(context.checkout);
      return yield* startClaimed(input, context).pipe(
        Effect.ensuring(Effect.sync(() => claimed.delete(context.checkout))),
      );
    },
  );

  const startClaimed = Effect.fnUntraced(function* (
    input: Parameters<HarnessService["Service"]["start"]>[0],
    context: CheckoutContext,
  ) {
    const slot = yield* assignSlot(context.projectId, context.checkout);
    const id = HarnessSessionId.make(yield* random.uuidV4());
    const net = input.net ?? (input.by === "person" ? "direct" : "isolated");
    const streamed = input.by === "person";
    const env = {
      ...(yield* envFor(context, slot)),
      T3CODE_STREAM_PATH: `${HARNESS_STREAM_ROUTE_PREFIX}/${id}/`,
    };
    const entry: LiveSession = {
      session: {
        id,
        projectId: context.projectId,
        worktreePath: context.checkout,
        threadId: input.threadId ?? null,
        by: input.by,
        net,
        phase: "starting",
        outbound: net === "direct",
        streamed,
        viewable: false,
        recorded: false,
        recording: null,
        markCount: 0,
        slot,
        startedAt: yield* nowIso,
        endedAt: null,
        error: null,
        packet: null,
      },
      context,
      env,
      target: null,
      viewers: new Map(),
      poller: null,
    };
    live.set(context.checkout, entry);
    yield* publish;
    yield* recordSessionId(context.checkout, id);

    const started = yield* checkoutLocks
      .withLock(
        context.checkout,
        Effect.gen(function* () {
          // A branch that changed since the worktree was made is built before it is played.
          yield* runVerb({
            context,
            env,
            args: ["prepare"],
            timeout: VERB_TIMEOUTS.prepare,
            schema: Schema.Unknown,
          });
          return yield* runVerb({
            context,
            env,
            args: [
              "session",
              "start",
              "--by",
              input.by,
              ...(streamed ? ["--streamed"] : []),
              "--net",
              net,
            ],
            timeout: VERB_TIMEOUTS.sessionStart,
            schema: HarnessSessionOutput,
          });
        }),
      )
      .pipe(
        Effect.tapError((error) => finish(entry, { phase: "failed", error: error.detail })),
        Effect.onInterrupt(() =>
          finish(entry, { phase: "failed", error: "The start was cancelled." }),
        ),
      );
    if (started.ok === false) {
      yield* finish(entry, { phase: "failed", error: "The harness refused the session." });
      return entry.session;
    }
    entry.target = streamed ? streamTargetFor(started.attach, slot) : null;
    yield* update(entry, {
      phase: "running",
      net: started.net === "isolated" || started.net === "direct" ? started.net : net,
      outbound: started.outbound ?? net === "direct",
      streamed: started.streamed ?? streamed,
      viewable: entry.target !== null,
      recorded: started.recorded ?? false,
      recording: started.recording ?? null,
    });
    entry.poller = yield* pollStatus(entry).pipe(Effect.forkIn(serviceScope));
    return entry.session;
  });

  const stopEntry = Effect.fnUntraced(function* (entry: LiveSession) {
    if (!isLive(entry.session)) return entry.session;
    yield* update(entry, { phase: "stopping", viewable: false });
    entry.target = null;
    yield* endViewers(entry);
    const stopped = yield* checkoutLocks
      .withLock(
        entry.context.checkout,
        runVerb({
          context: entry.context,
          env: entry.env,
          args: ["session", "stop"],
          timeout: VERB_TIMEOUTS.sessionStop,
          schema: HarnessSessionStopOutput,
        }),
      )
      .pipe(Effect.tapError((error) => finish(entry, { phase: "failed", error: error.detail })));
    yield* finish(entry, {
      phase: "stopped",
      recorded: stopped.recorded ?? entry.session.recorded,
      recording: stopped.recording ?? entry.session.recording,
      markCount: Math.max(0, Math.trunc(stopped.markCount ?? entry.session.markCount)),
    });
    return entry.session;
  });

  const stop: HarnessService["Service"]["stop"] = Effect.fn("HarnessService.stop")(
    function* (input) {
      return yield* stopEntry(yield* requireEntry(input.sessionId));
    },
  );

  const mark: HarnessService["Service"]["mark"] = Effect.fn("HarnessService.mark")(
    function* (input) {
      const entry = yield* requireEntry(input.sessionId);
      if (entry.session.phase !== "running") {
        return yield* new HarnessError({
          reason: "session-not-found",
          detail: "The session is not running, so there is nothing to mark.",
        });
      }
      yield* runVerb({
        context: entry.context,
        env: entry.env,
        args: [
          "mark",
          ...(input.lastSeconds === undefined ? [] : ["--last", String(input.lastSeconds)]),
          "--",
          input.note,
        ],
        timeout: VERB_TIMEOUTS.mark,
        schema: HarnessMarkOutput,
      });
      yield* update(entry, { markCount: entry.session.markCount + 1 });
      return entry.session;
    },
  );

  const viewer: HarnessService["Service"]["viewer"] = Effect.fn("HarnessService.viewer")(
    function* (input) {
      const entry = yield* requireEntry(input.sessionId);
      if (entry.session.phase !== "running" || entry.target === null) {
        return yield* new HarnessError({
          reason: "not-streamed",
          detail: entry.session.streamed
            ? "The session's stream is not running."
            : "This session is not streamed.",
        });
      }
      const token = Hex.encode(yield* random.randomBytes(32));
      const revoked = yield* Deferred.make<void>();
      entry.viewers.set(token, revoked);
      yield* input.invalidated.pipe(
        Effect.raceFirst(Deferred.await(revoked)),
        Effect.andThen(
          Effect.sync(() => entry.viewers.delete(token)).pipe(
            Effect.andThen(Deferred.succeed(revoked, undefined)),
          ),
        ),
        Effect.forkIn(serviceScope),
      );
      return { path: `${HARNESS_STREAM_ROUTE_PREFIX}/${entry.session.id}/${token}/` };
    },
  );

  const streamTarget: HarnessService["Service"]["streamTarget"] = (sessionId, token) =>
    Effect.sync(() => {
      const entry = sessionEntry(sessionId);
      const revoked = entry?.viewers.get(token);
      if (entry === undefined || revoked === undefined || entry.target === null)
        return Option.none();
      return Option.some({ ...entry.target, revoked: Deferred.await(revoked) });
    });

  const doctor: HarnessService["Service"]["doctor"] = Effect.fn("HarnessService.doctor")(
    function* (input) {
      const context = yield* clear(input);
      const output = yield* runVerb({
        context,
        env: yield* envFor(context, yield* assignSlot(context.projectId, context.checkout)),
        args: ["doctor", "--json"],
        timeout: VERB_TIMEOUTS.doctor,
        schema: HarnessDoctorOutput,
        acceptExitCodes: [1],
      });
      const rows: ReadonlyArray<HarnessDoctorRow> = Array.isArray(output)
        ? output
        : "rows" in output
          ? (output as { readonly rows: ReadonlyArray<HarnessDoctorRow> }).rows
          : (output as { readonly dependencies: ReadonlyArray<HarnessDoctorRow> }).dependencies;
      return { rows, ready: rows.every(isHarnessDoctorRowReady) };
    },
  );

  const setup: HarnessService["Service"]["setup"] = Effect.fn("HarnessService.setup")(
    function* (input) {
      const context = yield* clear(input);
      const running = setups.get(context.projectId);
      if (running?.phase === "running") return running;
      const env = yield* envFor(context, yield* assignSlot(context.projectId, context.checkout));
      const state: HarnessSetupState = {
        projectId: context.projectId,
        phase: "running",
        startedAt: yield* nowIso,
        endedAt: null,
        error: null,
      };
      setups.set(context.projectId, state);
      yield* publish;
      const settle = Effect.fn("HarnessService.settleSetup")(function* (error: string | null) {
        setups.set(context.projectId, {
          ...state,
          phase: error === null ? "succeeded" : "failed",
          endedAt: yield* nowIso,
          error,
        });
        yield* publish;
      });
      yield* runVerb({
        context,
        env,
        args: ["setup"],
        timeout: VERB_TIMEOUTS.setup,
        schema: Schema.Unknown,
      }).pipe(
        Effect.matchEffect({
          onSuccess: () => settle(null),
          onFailure: (error) => settle(error.detail),
        }),
        Effect.onInterrupt(() => settle("The setup was interrupted.")),
        Effect.forkIn(serviceScope),
      );
      return state;
    },
  );

  const prepareNow = Effect.fn("HarnessService.prepare")(function* (
    input: Parameters<HarnessService["Service"]["prepareInBackground"]>[0],
  ) {
    const context = yield* clear(input);
    const env = yield* envFor(context, yield* assignSlot(context.projectId, context.checkout));
    yield* checkoutLocks.withLock(
      context.checkout,
      runVerb({
        context,
        env,
        args: ["prepare"],
        timeout: VERB_TIMEOUTS.prepare,
        schema: Schema.Unknown,
      }),
    );
  });
  const prepareInBackground: HarnessService["Service"]["prepareInBackground"] = (input) =>
    prepareNow(input).pipe(
      Effect.catchTags({
        HarnessError: (error) =>
          // A project without a harness, or one nobody approved, simply gets no prepare.
          error.reason === "not-declared" || error.reason === "not-approved"
            ? Effect.void
            : Effect.logWarning("the harness's prepare failed", { detail: error.detail }),
      }),
      Effect.forkIn(serviceScope),
      Effect.asVoid,
    );

  const packet: HarnessService["Service"]["packet"] = Effect.fn("HarnessService.packet")(
    function* (input) {
      const context = yield* clear(input);
      const env = yield* envFor(context, yield* assignSlot(context.projectId, context.checkout));
      const output = yield* checkoutLocks.withLock(
        context.checkout,
        runVerb({
          context,
          env,
          args: ["packet"],
          timeout: VERB_TIMEOUTS.packet,
          schema: HarnessPacketOutput,
        }),
      );
      const named = output.packet ?? output.directory ?? output.path ?? null;
      const outputPath = env.T3CODE_OUTPUT_PATH;
      // The harness may name packet.json itself rather than its folder.
      const resolved =
        named === null
          ? path.join(outputPath, "packet")
          : path.resolve(
              context.checkout,
              named.endsWith("packet.json") ? path.dirname(named) : named,
            );
      return { directory: resolved };
    },
  );

  const commandEnv: HarnessService["Service"]["commandEnv"] = (sessionId) =>
    Effect.sync(() => {
      const entry = sessionEntry(sessionId);
      if (entry === undefined) return Option.none();
      const vars: Record<string, string> = {};
      for (const [name, value] of Object.entries(entry.env)) {
        if (name.startsWith("T3CODE_") && value !== undefined) vars[name] = value;
      }
      return Option.some(vars);
    });

  const notePacket: HarnessService["Service"]["notePacket"] = (sessionId, outcome) =>
    Effect.suspend(() => {
      const entry = sessionEntry(sessionId);
      return entry === undefined ? Effect.void : update(entry, { packet: outcome });
    });

  const releaseCheckout: HarnessService["Service"]["releaseCheckout"] = Effect.fn(
    "HarnessService.releaseCheckout",
  )(function* (worktreePath) {
    const checkout = path.resolve(worktreePath);
    const entry = live.get(checkout);
    if (entry !== undefined) {
      yield* stopEntry(entry).pipe(
        Effect.catchTags({
          HarnessError: (error) =>
            Effect.logWarning("could not stop the harness session of a removed checkout", {
              detail: error.detail,
            }),
        }),
      );
      live.delete(checkout);
      yield* publish;
    }
    yield* sql`DELETE FROM harness_checkouts WHERE worktree_path = ${checkout}`.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("could not free the checkout's harness slot", { cause }),
      ),
    );
    const outputPath = yield* outputPathFor(checkout);
    yield* fileSystem.remove(outputPath, { recursive: true, force: true }).pipe(Effect.ignoreCause);
  });

  // Only sessions this server started: the ones it holds, then any a crash left recorded.
  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      [...live.values()].filter((entry) => isLive(entry.session)),
      (entry) => stopEntry(entry).pipe(Effect.ignore),
      { concurrency: "unbounded", discard: true },
    ),
  );
  yield* Effect.gen(function* () {
    const orphans = yield* sql<{
      readonly worktreePath: string;
      readonly projectId: ProjectId;
      readonly slot: number;
    }>`
      SELECT worktree_path AS "worktreePath", project_id AS "projectId", slot
      FROM harness_checkouts WHERE session_id IS NOT NULL
    `;
    yield* Effect.forEach(
      orphans,
      (orphan) =>
        Effect.gen(function* () {
          const context = yield* clear({
            projectId: orphan.projectId,
            worktreePath: orphan.worktreePath,
            projectCommands: "permitted",
          });
          yield* runVerb({
            context,
            env: yield* envFor(context, orphan.slot),
            args: ["session", "stop"],
            timeout: VERB_TIMEOUTS.sessionStop,
            schema: Schema.Unknown,
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("could not stop a harness session left by a previous run", {
              cause,
            }),
          ),
          Effect.andThen(recordSessionId(orphan.worktreePath, null)),
        ),
      { discard: true },
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("could not read harness sessions left by a previous run", { cause }),
    ),
    Effect.forkIn(serviceScope),
  );

  return HarnessService.of({
    describe,
    snapshot: Effect.sync(currentSnapshot),
    changes: SubscriptionRef.changes(snapshotRef),
    start,
    stop,
    mark,
    viewer,
    streamTarget,
    doctor,
    setup,
    prepareInBackground,
    packet,
    commandEnv,
    notePacket,
    releaseCheckout,
  });
});

export const layer = Layer.effect(HarnessService, make);

/**
 * One instance for the whole server: the worktree setup hook and the routes both use it, and
 * layer memoization shares it only when they name this same value.
 */
export const layerLive = layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      LayoutCommandApprovals.layer,
      ManagedPolicy.layer,
      ProjectStore.layer,
      ProcessRunner.layer,
    ),
  ),
);
