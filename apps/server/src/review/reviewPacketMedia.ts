// @effect-diagnostics nodeBuiltinImport:off - hashing and copying stream from the descriptor
// openMediaFile validated, which FileSystem cannot read from.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { OpenMediaFile } from "../assets/MediaFile.ts";

export class ReviewMediaReadError extends Schema.TaggedError<ReviewMediaReadError>()(
  "ReviewMediaReadError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to read or copy review media '${this.path}'.`;
  }
}

/**
 * Reads the first `bytes` bytes of an open file, hashing them and, with `copyTo`, writing them to
 * a new file there. Returns the hex digest and how many bytes were actually read.
 */
export const hashMediaFile = (input: {
  readonly path: string;
  readonly file: OpenMediaFile;
  readonly bytes: number;
  readonly copyTo?: string;
}) =>
  Effect.tryPromise({
    try: async () => {
      const hash = NodeCrypto.createHash("sha256");
      let read = 0;
      const source =
        input.bytes === 0
          ? NodeStream.Readable.from([])
          : input.file.handle.createReadStream({
              autoClose: false,
              start: 0,
              end: input.bytes - 1,
            });
      const tap = new NodeStream.Transform({
        transform(chunk: Buffer, _encoding, done) {
          read += chunk.byteLength;
          hash.update(chunk);
          done(null, chunk);
        },
      });
      const sink =
        input.copyTo === undefined
          ? new NodeStream.Writable({ write: (_chunk, _encoding, done) => done() })
          : NodeFS.createWriteStream(input.copyTo, { flags: "wx", mode: 0o600 });
      await NodeStreamPromises.pipeline(source, tap, sink);
      return { sha256: hash.digest("hex"), read };
    },
    catch: (cause) => new ReviewMediaReadError({ path: input.path, cause }),
  });
