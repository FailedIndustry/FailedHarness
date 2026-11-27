import * as Schema from "effect/Schema";

import { ReviewClaimsFile, ReviewPacketStrict } from "@t3tools/contracts";

const buildJsonSchema = (title: string, schema: Schema.Top): Record<string, unknown> => {
  const document = Schema.toJsonSchemaDocument(schema);
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title,
    ...document.schema,
  };
  if (Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
};

/** Committed under `packages/contracts/schemas` for harnesses outside this repo. */
export const REVIEW_PACKET_JSON_SCHEMAS = {
  "claims.schema.json": () => buildJsonSchema("T3 Code review claims file", ReviewClaimsFile),
  "packet.schema.json": () => buildJsonSchema("T3 Code review packet", ReviewPacketStrict),
} as const;

export const renderReviewPacketJsonSchema = (name: keyof typeof REVIEW_PACKET_JSON_SCHEMAS) =>
  `${JSON.stringify(REVIEW_PACKET_JSON_SCHEMAS[name](), null, 2)}\n`;
