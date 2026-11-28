import { CommandId, type ProjectId, type ThreadId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "./ProjectService.ts";

const COORDINATOR_TITLE = "Coordinator";

export class ProjectCoordinatorError extends Schema.TaggedError<ProjectCoordinatorError>()(
  "ProjectCoordinatorError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.reason;
  }
}

export class ProjectCoordinator extends Context.Service<
  ProjectCoordinator,
  {
    /**
     * The project's coordinator: its live one, or a new one in the project's own checkout on the
     * owner's default model. Settling or archiving it lets the next open make another.
     */
    readonly open: (input: {
      readonly projectId: ProjectId;
    }) => Effect.Effect<
      { readonly threadId: ThreadId; readonly created: boolean },
      ProjectCoordinatorError
    >;
  }
>()("t3/project/ProjectCoordinator") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const launches = yield* ThreadLaunchService.ThreadLaunchService;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const random = yield* SecureRandom.SecureRandom;
  // One server makes every coordinator, so one lock keeps two opens from making two.
  const opening = yield* Semaphore.make(1);

  const fail = (reason: string) => (cause: unknown) =>
    new ProjectCoordinatorError({ reason, cause });

  const live = Effect.fn("ProjectCoordinator.live")(function* (projectId: ProjectId) {
    const listed = yield* threads
      .listProjectThreads({ projectId, includeSubagents: false })
      .pipe(Effect.mapError(fail("Could not read the project's threads.")));
    return listed.find(
      (thread) => thread.coordinator === true && thread.settledOverride !== "settled",
    );
  });

  /** With no default model set, the model of the latest thread here, else anywhere. */
  const lastUsedModel = Effect.fn("ProjectCoordinator.lastUsedModel")(
    function* (projectId: ProjectId) {
      const recent = yield* threads.listProjectThreads({ includeSubagents: false });
      const latest = recent.find((thread) => thread.projectId === projectId) ?? recent[0];
      if (latest === undefined) return null;
      const shell = yield* threads.getThreadShell(latest.id);
      return shell?.modelSelection ?? null;
    },
    Effect.mapError(fail("Could not read recent threads.")),
  );

  const create = Effect.fn("ProjectCoordinator.create")(function* (projectId: ProjectId) {
    const project = yield* projects.getById(projectId).pipe(
      Effect.mapError(fail("Could not read the project.")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new ProjectCoordinatorError({ reason: "Project not found." })),
          onSome: Effect.succeed,
        }),
      ),
    );
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(fail("Could not read settings.")),
    );
    const defaults = resolveProjectSettings(settings, projectId, project).settings;
    const { selection } = resolveNewThreadModelSelection({
      defaultSelection: defaults.defaultModelSelection,
      fallbackSelection: defaults.fallbackModelSelection,
      providers: yield* providers.getProviders,
      settings: defaults,
      projectId,
      now: DateTime.toEpochMillis(yield* DateTime.now),
    });
    const modelSelection = selection ?? (yield* lastUsedModel(projectId));
    if (modelSelection === null) {
      return yield* new ProjectCoordinatorError({
        reason: "Choose a default model for new threads in Settings first.",
      });
    }
    const commandId = CommandId.make(`coordinator:${yield* random.uuidV4()}`);
    const { threadId } = yield* launches
      .launch({
        commandId,
        projectId,
        title: COORDINATOR_TITLE,
        titleRenamed: true,
        modelSelection,
        runtimeMode: defaults.defaultRuntimeMode,
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        createdBy: "user",
        creationSource: "server",
        coordinator: true,
      })
      .pipe(Effect.mapError(fail("Could not start the coordinator.")));
    // Pinned leads its project, and a pinned thread never settles on its own.
    yield* threads
      .dispatch({ type: "thread.pin", commandId: CommandId.make(`${commandId}:pin`), threadId })
      .pipe(
        Effect.catch((cause) => Effect.logWarning("Could not pin the new coordinator.", cause)),
      );
    return threadId;
  });

  const open: ProjectCoordinator["Service"]["open"] = Effect.fn("ProjectCoordinator.open")(
    function* ({ projectId }) {
      return yield* opening.withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* live(projectId);
          if (existing !== undefined) return { threadId: existing.id, created: false };
          return { threadId: yield* create(projectId), created: true };
        }),
      );
    },
  );

  return ProjectCoordinator.of({ open });
});

export const layer = Layer.effect(ProjectCoordinator, make);
