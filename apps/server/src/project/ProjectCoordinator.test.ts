import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ActiveThreadListEntry } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectCoordinator from "./ProjectCoordinator.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("project-1");
const otherProjectId = ProjectId.make("project-2");
const modelSelection = { instanceId: ProviderInstanceId.make("claude"), model: "claude-haiku-5-5" };

interface World {
  readonly threads: Array<ActiveThreadListEntry>;
  readonly launches: Array<ThreadLaunchService.ThreadLaunchInput>;
  readonly dispatched: Array<OrchestrationV2ServerCommand>;
}

const harness = (world: World) =>
  ProjectCoordinator.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          listProjectThreads: (input) =>
            Effect.sync(() =>
              world.threads.filter(
                (thread) => input.projectId === undefined || thread.projectId === input.projectId,
              ),
            ),
          getThreadShell: () => Effect.succeed(null),
          dispatch: (command) =>
            Effect.sync(() => {
              world.dispatched.push(command);
              return {} as never;
            }),
        }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) =>
            Effect.gen(function* () {
              // Another open waits on the lock while this one is still launching.
              yield* Effect.yieldNow;
              world.launches.push(input);
              const threadId = ThreadId.make(`thread-${world.launches.length}`);
              world.threads.push({
                id: threadId,
                projectId: input.projectId,
                title: input.title,
                lineage: {
                  parentThreadId: null,
                  relationshipToParent: null,
                  rootThreadId: threadId,
                },
                settledOverride: null,
                settledAt: null,
                snoozedUntil: null,
                updatedAt: yield* DateTime.now,
                ...(input.coordinator === true ? { coordinator: true } : {}),
              });
              return { threadId } as ThreadLaunchService.ThreadLaunchResult;
            }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) => Effect.succeedSome({ id } as never),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        ServerSettings.layerTest({ defaultModelSelection: modelSelection }),
        NodeCrypto.layer,
      ),
    ),
  );

const makeWorld = (): World => ({ threads: [], launches: [], dispatched: [] });

describe("ProjectCoordinator", () => {
  it.effect(
    "opens the project's live coordinator, and makes a new one only when it has none",
    () => {
      const world = makeWorld();
      return Effect.gen(function* () {
        const coordinator = yield* ProjectCoordinator.ProjectCoordinator;
        const first = yield* coordinator.open({ projectId });
        expect(first.created).toBe(true);
        expect(world.launches).toMatchObject([
          {
            projectId,
            title: "Coordinator",
            titleRenamed: true,
            modelSelection,
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            coordinator: true,
          },
        ]);
        expect(world.dispatched).toMatchObject([{ type: "thread.pin", threadId: first.threadId }]);

        expect(yield* coordinator.open({ projectId })).toEqual({
          threadId: first.threadId,
          created: false,
        });
        // Another project's coordinator is its own.
        const other = yield* coordinator.open({ projectId: otherProjectId });
        expect(other.created).toBe(true);
        expect(other.threadId).not.toBe(first.threadId);

        const index = world.threads.findIndex((thread) => thread.id === first.threadId);
        world.threads[index] = {
          ...world.threads[index]!,
          settledOverride: "settled",
          settledAt: yield* DateTime.now,
        };
        const afterSettle = yield* coordinator.open({ projectId });
        expect(afterSettle.created).toBe(true);
        expect(afterSettle.threadId).not.toBe(first.threadId);

        // An archived one is gone from the active list, as the projection leaves it out.
        world.threads.splice(
          world.threads.findIndex((thread) => thread.id === afterSettle.threadId),
          1,
        );
        expect((yield* coordinator.open({ projectId })).created).toBe(true);
        expect(world.launches).toHaveLength(4);
      }).pipe(Effect.provide(harness(world)));
    },
  );

  it.effect("makes one coordinator when two clients open it at once", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const coordinator = yield* ProjectCoordinator.ProjectCoordinator;
      const opened = yield* Effect.all(
        [coordinator.open({ projectId }), coordinator.open({ projectId })],
        { concurrency: "unbounded" },
      );
      expect(world.launches).toHaveLength(1);
      expect(opened.map((result) => result.threadId)).toEqual([
        opened[0]!.threadId,
        opened[0]!.threadId,
      ]);
      expect(opened.map((result) => result.created).toSorted()).toEqual([false, true]);
    }).pipe(Effect.provide(harness(world)));
  });

  it.effect("never takes an ordinary thread for the coordinator", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const ordinary = ThreadId.make("ordinary");
      world.threads.push({
        id: ordinary,
        projectId,
        title: "Coordinator",
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ordinary },
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        updatedAt: yield* DateTime.now,
      });
      const coordinator = yield* ProjectCoordinator.ProjectCoordinator;
      const opened = yield* coordinator.open({ projectId });
      expect(opened.created).toBe(true);
      expect(opened.threadId).not.toBe(ordinary);
    }).pipe(Effect.provide(harness(world)));
  });
});
