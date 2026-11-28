import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type HarnessSessionId,
  type ManagedPolicyDocument,
  type TaskFolderError,
  ProjectId,
  T3_PROJECT_FILE_NAME,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as LayoutCommandApprovals from "../workspace/LayoutCommandApprovals.ts";
import * as LayoutCommandApprovalWrites from "../workspace/LayoutCommandApprovalWrites.ts";
import * as HarnessService from "./HarnessService.ts";

const projectId = ProjectId.make("project-harness");

/**
 * A harness that answers every verb with the documents the contract names, logs each call with
 * the variables T3 Code set, and keeps its session in the output folder. `FAKE_HARNESS_FAIL`
 * names a verb to fail the way a real harness does.
 */
const FAKE_HARNESS = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const out = process.env.T3CODE_OUTPUT_PATH;
const args = process.argv.slice(2);
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("T3CODE_")));
fs.appendFileSync(process.env.FAKE_HARNESS_LOG ?? path.join(out, "calls.jsonl"), JSON.stringify({ args, env, cwd: process.cwd() }) + "\\n");
const emit = (value, code = 0) => { process.stdout.write(JSON.stringify(value) + "\\n"); process.exit(code); };
const sessionFile = path.join(out, "session.json");
const session = fs.existsSync(sessionFile) ? JSON.parse(fs.readFileSync(sessionFile, "utf8")) : null;
const verb = args[0] === "session" ? "session " + args[1] : args[0];
if (process.env.FAKE_HARNESS_FAIL === verb) {
  process.stderr.write("progress line\\n");
  emit({ ok: false, error: "fake " + verb + " failure" }, 1);
}
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
switch (verb) {
  case "doctor":
    emit([
      { id: "server", state: "present", detail: "installed" },
      { id: "selkies", state: "missing", detail: "not installed", fix: "harness/gw setup" },
    ], 1);
  case "setup":
  case "prepare":
    emit({ ok: true, actions: [] });
  case "session start": {
    const net = flag("--net") ?? "isolated";
    const recorded = net === "isolated";
    const started = { id: "h-1", by: flag("--by"), net, recorded, marks: 0 };
    fs.writeFileSync(sessionFile, JSON.stringify(started));
    emit({
      ok: true, id: "h-1", slot: Number(process.env.T3CODE_SLOT), streamed: args.includes("--streamed"),
      net, outbound: net === "direct", recorded, recording: recorded ? path.join(out, "session.mkv") : null,
      attach: { protocol: "selkies", url: "http://100.64.0.1:" + (5900 + Number(process.env.T3CODE_SLOT)) + "/",
        path: process.env.T3CODE_STREAM_PATH, user: "player", password: "per-session-secret" },
    });
  }
  case "session status":
    emit({ ok: true, running: session !== null, markCount: session ? session.marks : 0 });
  case "session stop":
    if (session === null) emit({ ok: false, error: "this checkout has no session to stop" }, 1);
    fs.rmSync(sessionFile);
    emit({ ok: true, id: "h-1", recorded: session.recorded, markCount: session.marks });
  case "mark":
    if (session === null || !session.recorded) emit({ ok: false, error: "the session is not recorded" }, 1);
    session.marks += 1;
    fs.writeFileSync(sessionFile, JSON.stringify(session));
    emit({ ok: true, note: args[args.length - 1], atMs: 1200 });
  case "packet":
    emit({ ok: true, packet: path.join(out, "packet", "packet.json"), verdict: "pass" });
  default:
    emit({ ok: false, error: "bad usage" }, 2);
}
`;

interface Fixture {
  readonly root: string;
  readonly checkouts: ReadonlyArray<string>;
}

const makeCheckout = Effect.fn("test.makeCheckout")(function* (
  directory: string,
  declared = "harness/gw",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.join(directory, "harness"), { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(directory, T3_PROJECT_FILE_NAME),
    JSON.stringify({ harness: declared }),
  );
  const executable = path.join(directory, "harness", "gw");
  yield* fileSystem.writeFileString(executable, FAKE_HARNESS);
  yield* fileSystem.chmod(executable, 0o755);
  return directory;
});

const fixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-harness-" });
  const project = yield* makeCheckout(path.join(root, "project"));
  const first = yield* makeCheckout(path.join(root, "worktree-a"));
  const second = yield* makeCheckout(path.join(root, "worktree-b"));
  return { root: project, checkouts: [first, second] } satisfies Fixture;
});

const harnessLayer = (
  projectRoot: string,
  options: { readonly policy?: ManagedPolicyDocument; readonly env?: NodeJS.ProcessEnv } = {},
) =>
  HarnessService.layer.pipe(
    Layer.provideMerge(LayoutCommandApprovalWrites.layer),
    Layer.provide(LayoutCommandApprovals.layer),
    Layer.provide(ManagedPolicy.layerTest(options.policy)),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: (id) =>
          Effect.succeed(
            id === projectId
              ? Option.some({ workspaceRoot: projectRoot } as ProjectStore.ProjectRow)
              : Option.none(),
          ),
      }),
    ),
    Layer.provide(ProcessRunner.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-harness-state-" })),
    Layer.provide(
      Layer.succeed(HostProcess.Environment, { PATH: process.env.PATH, ...options.env }),
    ),
    Layer.provideMerge(NodeCrypto.layer),
  );

/** Runs `body` against a fresh service, as the client RPC sees it, and closes it after. */
const withHarness = <A, E>(
  body: (input: {
    readonly fixture: Fixture;
    readonly harness: HarnessService.HarnessService["Service"];
    readonly approve: (declared: string | null) => Effect.Effect<void, TaskFolderError>;
    readonly calls: (
      checkout: string,
    ) => Effect.Effect<ReadonlyArray<Call>, PlatformError.PlatformError>;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
  options?: { readonly policy?: ManagedPolicyDocument; readonly env?: NodeJS.ProcessEnv },
) =>
  Effect.gen(function* () {
    const made = yield* fixture;
    return yield* Effect.gen(function* () {
      const harness = yield* HarnessService.HarnessService;
      const writes = yield* LayoutCommandApprovalWrites.LayoutCommandApprovalWrites;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const calls = (checkout: string) =>
        Effect.gen(function* () {
          const outputs = path.join(stateDir, "harness", "output");
          const found: Array<Call> = [];
          for (const folder of yield* fileSystem.readDirectory(outputs)) {
            const log = path.join(outputs, folder, "calls.jsonl");
            if (!(yield* fileSystem.exists(log))) continue;
            for (const line of (yield* fileSystem.readFileString(log)).trim().split("\n")) {
              const call = JSON.parse(line) as Call;
              if (call.env.T3CODE_WORKTREE_PATH === checkout) found.push(call);
            }
          }
          return found;
        });
      return yield* body({
        fixture: made,
        harness,
        approve: (declared) => writes.set({ projectId, kind: "harness", command: declared }),
        calls,
      });
    }).pipe(Effect.provide(harnessLayer(made.root, options)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

interface Call {
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

const failureOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit)) : undefined;

describe("HarnessService", () => {
  it.effect(
    "runs nothing until a person approved the declared path, and asks again when it changes",
    () =>
      withHarness(({ fixture: { root }, harness, approve }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const refused = yield* harness
            .doctor({ projectId, projectCommands: "permitted" })
            .pipe(Effect.exit);
          expect(failureOf(refused)).toMatchObject({ reason: "not-approved" });
          expect((yield* harness.describe({ projectId })).blocked).toBe("not-approved");

          yield* approve("harness/gw");
          const doctor = yield* harness.doctor({ projectId, projectCommands: "permitted" });
          // `doctor` exits 1 when something is missing; its rows still count.
          expect(doctor.ready).toBe(false);
          expect(doctor.rows.map((row) => [row.id, row.state, row.fix ?? null])).toEqual([
            ["server", "present", null],
            ["selkies", "missing", "harness/gw setup"],
          ]);

          yield* fileSystem.writeFileString(
            path.join(root, T3_PROJECT_FILE_NAME),
            JSON.stringify({ harness: "harness/other" }),
          );
          const changed = yield* harness
            .doctor({ projectId, projectCommands: "permitted" })
            .pipe(Effect.exit);
          expect(failureOf(changed)).toMatchObject({ reason: "not-approved" });
          expect(yield* harness.describe({ projectId })).toMatchObject({
            declared: "harness/other",
            approved: false,
            blocked: "not-approved",
          });
        }),
      ),
  );

  it.effect(
    "refuses an agent below Full access, a path outside the checkout, and a policy that turns project commands off",
    () =>
      Effect.gen(function* () {
        yield* withHarness(({ harness, approve, fixture: { root } }) =>
          Effect.gen(function* () {
            yield* approve("harness/gw");
            const agent = yield* harness
              .doctor({ projectId, projectCommands: "agent-below-full-access" })
              .pipe(Effect.exit);
            expect(failureOf(agent)).toMatchObject({ reason: "not-permitted" });

            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            yield* fileSystem.writeFileString(
              path.join(root, T3_PROJECT_FILE_NAME),
              JSON.stringify({ harness: "../outside/gw" }),
            );
            yield* approve("../outside/gw");
            const outside = yield* harness
              .doctor({ projectId, projectCommands: "permitted" })
              .pipe(Effect.exit);
            expect(failureOf(outside)).toMatchObject({ reason: "not-found" });
          }),
        );
        yield* withHarness(
          ({ harness, approve }) =>
            Effect.gen(function* () {
              yield* approve("harness/gw");
              const off = yield* harness
                .doctor({ projectId, projectCommands: "permitted" })
                .pipe(Effect.exit);
              expect(failureOf(off)).toMatchObject({ reason: "policy" });
              expect((yield* harness.describe({ projectId })).blocked).toBe("policy");
            }),
          {
            policy: {
              schemaVersion: 1,
              organization: "Example Corp",
              limits: { worktreeLayoutCommands: false },
            },
          },
        );
      }),
  );

  it.effect(
    "gives each live checkout of a project its own slot, cache shared, output its own",
    () =>
      withHarness(({ fixture: { root, checkouts }, harness, approve, calls }) =>
        Effect.gen(function* () {
          yield* approve("harness/gw");
          const [first, second] = checkouts as [string, string];
          const a = yield* harness.start({
            projectId,
            worktreePath: first,
            by: "agent",
            projectCommands: "permitted",
          });
          const b = yield* harness.start({
            projectId,
            worktreePath: second,
            by: "agent",
            projectCommands: "permitted",
          });
          expect([a.slot, b.slot]).toEqual([0, 1]);
          const [startA] = (yield* calls(first)).filter((call) => call.args[0] === "session");
          const [startB] = (yield* calls(second)).filter((call) => call.args[0] === "session");
          expect(startA!.cwd).toBe(first);
          expect(startA!.env).toMatchObject({
            T3CODE_PROJECT_ROOT: root,
            T3CODE_WORKTREE_PATH: first,
            T3CODE_SLOT: "0",
            T3CODE_STREAM_PATH: `/api/harness/stream/${a.id}/`,
          });
          expect(startA!.env.T3CODE_CACHE_PATH).toBe(startB!.env.T3CODE_CACHE_PATH);
          expect(startA!.env.T3CODE_OUTPUT_PATH).not.toBe(startB!.env.T3CODE_OUTPUT_PATH);

          // A removed checkout stops its session and frees its slot for the next one.
          yield* harness.releaseCheckout(first);
          expect((yield* calls(first)).map((call) => call.args.join(" "))).toEqual([]);
          const fileSystem = yield* FileSystem.FileSystem;
          expect(yield* fileSystem.exists(startA!.env.T3CODE_OUTPUT_PATH!)).toBe(false);
          const again = yield* harness.start({
            projectId,
            worktreePath: root,
            by: "agent",
            projectCommands: "permitted",
          });
          expect(again.slot).toBe(0);
        }),
      ),
  );

  it.effect("runs prepare then a session, marks only a recorded one, and stops it", () =>
    withHarness(({ fixture: { checkouts }, harness, approve, calls }) =>
      Effect.gen(function* () {
        yield* approve("harness/gw");
        const [checkout] = checkouts as [string];
        const person = yield* harness.start({
          projectId,
          worktreePath: checkout,
          by: "person",
          net: "direct",
          projectCommands: "permitted",
        });
        expect(person).toMatchObject({
          phase: "running",
          by: "person",
          net: "direct",
          outbound: true,
          streamed: true,
          viewable: true,
          recorded: false,
        });
        expect((yield* calls(checkout)).map((call) => call.args.join(" "))).toEqual([
          "prepare",
          "session start --by person --streamed --net direct",
        ]);

        const twice = yield* harness
          .start({ projectId, worktreePath: checkout, by: "person", projectCommands: "permitted" })
          .pipe(Effect.exit);
        expect(failureOf(twice)).toMatchObject({ reason: "session-running" });

        const unrecorded = yield* harness
          .mark({ sessionId: person.id, note: "flicker" })
          .pipe(Effect.exit);
        expect(failureOf(unrecorded)?.detail).toContain("the session is not recorded");

        const stopped = yield* harness.stop({ sessionId: person.id });
        expect(stopped).toMatchObject({ phase: "stopped", viewable: false });
        expect(stopped.endedAt).not.toBeNull();

        const agent = yield* harness.start({
          projectId,
          worktreePath: checkout,
          by: "agent",
          projectCommands: "permitted",
        });
        expect(agent).toMatchObject({
          net: "isolated",
          outbound: false,
          streamed: false,
          recorded: true,
        });
        const marked = yield* harness.mark({
          sessionId: agent.id,
          note: "-starts with a dash",
          lastSeconds: 10,
        });
        expect(marked.markCount).toBe(1);
        expect((yield* calls(checkout)).at(-1)!.args).toEqual([
          "mark",
          "--last",
          "10",
          "--",
          "-starts with a dash",
        ]);
        const final = yield* harness.stop({ sessionId: agent.id });
        expect(final).toMatchObject({ phase: "stopped", markCount: 1 });
        expect((yield* harness.snapshot).sessions.map((session) => session.phase)).toEqual([
          "stopped",
        ]);
      }),
    ),
  );

  it.effect("records a failed start with the harness's own error, and a retry starts again", () =>
    withHarness(
      ({ fixture: { checkouts }, harness, approve }) =>
        Effect.gen(function* () {
          yield* approve("harness/gw");
          const [checkout] = checkouts as [string];
          const failed = yield* harness
            .start({ projectId, worktreePath: checkout, by: "agent", projectCommands: "permitted" })
            .pipe(Effect.exit);
          expect(failureOf(failed)?.detail).toContain("fake session start failure");
          const [session] = (yield* harness.snapshot).sessions;
          expect(session).toMatchObject({ phase: "failed" });
          expect(session!.error).toContain("fake session start failure");
        }),
      { env: { FAKE_HARNESS_FAIL: "session start" } },
    ),
  );

  it.effect(
    "gives a viewer the session's fixed stream target with its login, until the session stops",
    () =>
      withHarness(({ fixture: { checkouts }, harness, approve }) =>
        Effect.gen(function* () {
          yield* approve("harness/gw");
          const [checkout] = checkouts as [string];
          const session = yield* harness.start({
            projectId,
            worktreePath: checkout,
            by: "person",
            projectCommands: "permitted",
          });
          const { path } = yield* harness.viewer({
            sessionId: session.id,
            invalidated: Effect.never,
          });
          const [, , , , sessionId, token] = path.split("/");
          expect(sessionId).toBe(session.id);
          const target = yield* harness.streamTarget(sessionId!, token!);
          expect(Option.getOrThrow(target)).toMatchObject({
            origin: `http://127.0.0.1:${5900 + session.slot}`,
            basePath: `/api/harness/stream/${session.id}/`,
            authorization: `Basic ${btoa("player:per-session-secret")}`,
          });
          expect(Option.isNone(yield* harness.streamTarget(sessionId!, "f".repeat(64)))).toBe(true);
          // The password never reaches a client.
          expect(JSON.stringify(yield* harness.snapshot)).not.toContain("per-session-secret");

          yield* harness.stop({ sessionId: session.id });
          expect(Option.isNone(yield* harness.streamTarget(sessionId!, token!))).toBe(true);
          const ended = yield* harness
            .viewer({ sessionId: session.id as HarnessSessionId, invalidated: Effect.never })
            .pipe(Effect.exit);
          expect(failureOf(ended)).toMatchObject({ reason: "not-streamed" });
        }),
      ),
  );

  it.effect("stops the sessions it started when the server shuts down", () =>
    Effect.gen(function* () {
      const made = yield* fixture;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const log = path.join(made.root, "calls.jsonl");
      const [checkout] = made.checkouts as [string];
      yield* Effect.gen(function* () {
        const harness = yield* HarnessService.HarnessService;
        const writes = yield* LayoutCommandApprovalWrites.LayoutCommandApprovalWrites;
        yield* writes.set({ projectId, kind: "harness", command: "harness/gw" });
        yield* harness.start({
          projectId,
          worktreePath: checkout,
          by: "agent",
          projectCommands: "permitted",
        });
      }).pipe(Effect.provide(harnessLayer(made.root, { env: { FAKE_HARNESS_LOG: log } })));
      // The layer is closed by now: its finalizer stopped the session it started.
      const calls = (yield* fileSystem.readFileString(log))
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as Call).args.join(" "));
      expect(calls).toEqual(["prepare", "session start --by agent --net isolated", "session stop"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("reads the last JSON line of a verb that prints progress on stdout first", () => {
    expect(Option.getOrUndefined(HarnessService.parseVerbJson('{"ok":true}'))).toEqual({
      ok: true,
    });
    expect(
      Option.getOrUndefined(
        HarnessService.parseVerbJson('/tmp/packet/packet.json\n{"verdict":"pass"}\n'),
      ),
    ).toEqual({ verdict: "pass" });
    expect(Option.isNone(HarnessService.parseVerbJson("not json"))).toBe(true);
  });

  it("targets a streamed session on loopback at its attach port, falling back to 5900 + slot", () => {
    expect(
      HarnessService.streamTargetFor(
        { url: "http://100.64.0.1:5983/", path: "/x", user: "u", password: "p" },
        3,
      ),
    ).toEqual({
      origin: "http://127.0.0.1:5983",
      basePath: "/x/",
      authorization: `Basic ${btoa("u:p")}`,
    });
    expect(HarnessService.streamTargetFor({}, 7)).toEqual({
      origin: "http://127.0.0.1:5907",
      basePath: "/",
      authorization: null,
    });
    expect(HarnessService.streamTargetFor(null, 7)).toBeNull();
  });
});
