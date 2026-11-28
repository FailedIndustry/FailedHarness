#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Command } from "effect/cli";

import {
  REVIEW_PACKET_JSON_SCHEMAS,
  renderReviewPacketJsonSchema,
} from "@t3tools/shared/reviewPacketJsonSchema";

const generate = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const outputDirectory = path.join(import.meta.dirname, "..", "packages", "contracts", "schemas");
  yield* fs.makeDirectory(outputDirectory, { recursive: true });
  for (const name of Object.keys(REVIEW_PACKET_JSON_SCHEMAS) as Array<
    keyof typeof REVIEW_PACKET_JSON_SCHEMAS
  >) {
    yield* fs.writeFileString(path.join(outputDirectory, name), renderReviewPacketJsonSchema(name));
  }
});

const command = Command.make("generate-review-packet-schemas", {}, () => generate).pipe(
  Command.withDescription("Write the review packet JSON Schemas to packages/contracts/schemas."),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
