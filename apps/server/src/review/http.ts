import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  EnvironmentHttpApi,
  ReviewPacketRejectedError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { traceLocalHandlerWork } from "../cloud/traceRelayRequest.ts";
import * as ReviewPacketService from "./ReviewPacketService.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "reviewPackets",
  Effect.fnUntraced(function* (handlers) {
    const reviewPackets = yield* ReviewPacketService.ReviewPacketService;
    return handlers.handle(
      "submit",
      Effect.fn("environment.reviewPackets.submit")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        // The server reads a folder the caller names and keeps what it finds there.
        yield* requireEnvironmentScope(AuthFilesystemReadScope);
        yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
        return yield* reviewPackets.submit(args.payload).pipe(
          traceLocalHandlerWork,
          Effect.catchTags({
            ReviewPacketStoreError: (cause) => failEnvironmentInternal("internal_error", cause),
          }),
          // The service's messages are built from its own attributes, so they are safe to send.
          Effect.mapError((rejection) =>
            rejection._tag === "EnvironmentInternalError"
              ? rejection
              : new ReviewPacketRejectedError({
                  problem: rejection._tag,
                  detail: rejection.message,
                }),
          ),
        );
      }),
    );
  }),
);
