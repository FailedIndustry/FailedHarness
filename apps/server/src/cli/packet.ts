import { AuthFilesystemReadScope, AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import { Argument, Command, GlobalFlag } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ReviewPackets from "../persistence/ReviewPackets.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ReviewPacketService from "../review/ReviewPacketService.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import * as RunningServer from "./runningServer.ts";
import { jsonFlag, printJson } from "./thread.ts";

class PacketSubmitFailedError extends Schema.TaggedError<PacketSubmitFailedError>()(
  "PacketSubmitFailedError",
  { detail: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return this.detail;
  }
}

const firstLine = (error: { readonly _tag: string; readonly message?: unknown }) =>
  (typeof error.message === "string" && error.message.trim() !== ""
    ? error.message
    : error._tag
  ).split("\n", 1)[0] ?? error._tag;

const packetSubmitCommand = Command.make("submit", {
  ...projectLocationFlags,
  directory: Argument.String("dir").pipe(
    Argument.withDescription("The packet folder: packet.json and the media it lists."),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Store a review packet a project's harness wrote, so T3 Code can show the change's claims and evidence. Submitting the same revision again replaces it.",
  ),
  Command.withHandler(
    Effect.fn("cli.packet.submit")(
      function* (flags) {
        const cliLogLevel = yield* GlobalFlag.LogLevel;
        const config = yield* resolveCliAuthConfig(flags, cliLogLevel, { quietLogs: true });
        // Logs share stdout with --json, so migrations and the like stay quiet unless asked for.
        const minimumLogLevel = Layer.succeed(
          References.MinimumLogLevel,
          Option.getOrElse(cliLogLevel, () => "Warn" as const),
        );
        const path = yield* Path.Path;
        const directory = path.resolve(
          expandHomePath(flags.directory, yield* HostProcess.HomeDirectory),
        );
        const result = yield* RunningServer.changeState({
          scopes: [AuthFilesystemReadScope, AuthOrchestrationOperateScope],
          viaServer: (client) =>
            client.reviewPackets.submit({ headers: {}, payload: { directory } }),
          // Built only after changeState holds the ownership lock, so no server opens the database meanwhile.
          locally: ReviewPacketService.ReviewPacketService.pipe(
            Effect.flatMap((service) => service.submit({ directory })),
            Effect.provide(
              ReviewPacketService.layer.pipe(
                Layer.provide(ReviewPackets.layer),
                Layer.provide(RepositoryIdentityResolver.layer),
                Layer.provide(SqlitePersistence.layerConfig),
                Layer.provide(ServerConfig.layer(config)),
                Layer.provide(minimumLogLevel),
              ),
            ),
          ),
        }).pipe(
          Effect.scoped,
          Effect.provide(
            EnvironmentAuth.layerRuntime.pipe(
              Layer.provideMerge(FetchHttpClient.layer),
              Layer.provideMerge(ServerConfig.layer(config)),
              Layer.provide(minimumLogLevel),
            ),
          ),
        );
        if (flags.json) return yield* printJson(result);
        const { change, media } = result;
        const claims = change.claims.seen + change.claims.notSeen + change.claims.untested;
        yield* Console.log(
          `${result.replaced ? "Replaced" : "Stored"} ${change.repository} ${change.branch} at ${change.head.slice(0, 12)} (${change.verdict}): ${claims} claims, ${media.copied + media.reused} media (${media.copied} copied).`,
        );
      },
      // Every failure is one line on stderr; the runtime does not log it again.
      Effect.catch((error) => {
        const detail = firstLine(error);
        return Console.error(detail).pipe(
          Effect.andThen(Effect.fail(new PacketSubmitFailedError({ detail }))),
        );
      }),
    ),
  ),
);

export const packetCommand = Command.make("packet").pipe(
  Command.withDescription("Review packets: a change's claims and the evidence for each."),
  Command.withSubcommands([packetSubmitCommand]),
);
