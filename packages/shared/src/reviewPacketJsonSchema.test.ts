// @effect-diagnostics nodeBuiltinImport:off - Reads the committed schema files synchronously.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  REVIEW_PACKET_JSON_SCHEMAS,
  renderReviewPacketJsonSchema,
} from "./reviewPacketJsonSchema.ts";

const schemasDirectory = NodePath.join(import.meta.dirname, "../../contracts/schemas");
const names = Object.keys(REVIEW_PACKET_JSON_SCHEMAS) as Array<
  keyof typeof REVIEW_PACKET_JSON_SCHEMAS
>;

describe("review packet JSON Schemas", () => {
  it.each(names)("%s matches the Effect schema (run `vp run schemas:review-packet`)", (name) => {
    const committed = NodeFS.readFileSync(NodePath.join(schemasDirectory, name), "utf8");
    expect(committed).toBe(renderReviewPacketJsonSchema(name));
  });
});
