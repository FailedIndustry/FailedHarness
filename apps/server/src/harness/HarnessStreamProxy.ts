// A streamed harness session's page and signalling, same-origin: the browser gets HTTPS whenever
// T3 Code is served over it, and never sees the session's password. WebRTC media does not pass
// here; it goes over UDP straight to the address the stream offers.
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  HttpClient,
  HttpClientRequest,
  HttpMethod,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as Socket from "effect/socket/Socket";

import { upstreamWebSocketConstructor } from "../device/DeviceHubProxy.ts";
import { requestUrl } from "../requestUrl.ts";
import * as HarnessService from "./HarnessService.ts";

const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "cookie",
  "authorization",
  "dpop",
  "content-length",
  "accept-encoding",
  "referer",
  "x-forwarded-proto",
  "x-forwarded-for",
  "x-forwarded-host",
]);

// Upstream cookies and auth challenges would land on T3 Code's origin; frame rules would stop
// the app from embedding the page.
const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "set-cookie",
  "clear-site-data",
  "www-authenticate",
  "x-frame-options",
]);

/** `/api/harness/stream/<session>/<viewer token>/<rest>`, split; null when it is not that shape. */
export const parseStreamPath = (pathname: string) => {
  const prefix = `${HarnessService.HARNESS_STREAM_ROUTE_PREFIX}/`;
  if (!pathname.startsWith(prefix)) return null;
  const [sessionId, token, ...rest] = pathname.slice(prefix.length).split("/");
  if (!sessionId || !token) return null;
  return { sessionId, token, rest: rest.length === 0 ? null : rest.join("/") };
};

/**
 * Selkies accepts a websocket only from an Origin matching the Host it was sent to, so both name
 * the loopback target, whatever the browser's were.
 */
export const targetHeaders = (
  target: Pick<HarnessService.HarnessStreamTarget, "origin" | "authorization">,
) => ({
  host: new URL(target.origin).host,
  origin: target.origin,
  ...(target.authorization === null ? {} : { authorization: target.authorization }),
});

const forwardHeaders = (
  request: HttpServerRequest.HttpServerRequest,
  target: HarnessService.HarnessStreamTarget,
) => {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (DROPPED_REQUEST_HEADERS.has(name) || value === undefined) continue;
    headers[name] = value;
  }
  const fixed = targetHeaders(target);
  // A request without an Origin keeps none, as the browser sent it.
  return request.headers.origin === undefined
    ? {
        ...headers,
        host: fixed.host,
        ...(fixed.authorization ? { authorization: fixed.authorization } : {}),
      }
    : { ...headers, ...fixed };
};

const pumpFrames =
  /* Frame pumping runs continuously; a span per frame stream adds no diagnostic value. */
  Effect.fnUntraced(function* (source: Socket.Socket, sink: Socket.Writer) {
    const { pull } = yield* source.reader;
    while (true) {
      yield* sink.writeAll(yield* pull);
    }
  });

const proxyWebSocket = Effect.fn("HarnessStreamProxy.proxyWebSocket")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
  target: HarnessService.HarnessStreamTarget,
) {
  const transport = NodeHttpServerRequest.toIncomingMessage(request).socket;
  const protocols = (request.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol !== "");
  const client = yield* request.upgrade;
  const upstream = yield* Socket.makeWebSocket(upstreamUrl, {
    openTimeout: "10 seconds",
    ...(protocols.length > 0 ? { protocols } : {}),
    headers: targetHeaders(target),
  }).pipe(Effect.provide(upstreamWebSocketConstructor));
  yield* Effect.scoped(
    Effect.gen(function* () {
      const writeToClient = yield* client.writer;
      const writeToUpstream = yield* upstream.writer;
      return yield* Effect.raceFirst(
        pumpFrames(upstream, writeToClient),
        pumpFrames(client, writeToUpstream),
      );
    }),
  ).pipe(
    Effect.raceFirst(target.revoked),
    Effect.ensuring(Effect.sync(() => transport.destroy())),
    Effect.ignoreCause,
  );
  return HttpServerResponse.empty();
});

const proxyHttp = Effect.fn("HarnessStreamProxy.proxyHttp")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
  target: HarnessService.HarnessStreamTarget,
) {
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const method = request.method;
  if (!HttpMethod.isHttpMethod(method)) {
    return HttpServerResponse.text("Method Not Allowed", { status: 405 });
  }
  const upstreamRequest = HttpClientRequest.make(method)(upstreamUrl).pipe(
    HttpClientRequest.setHeaders(forwardHeaders(request, target)),
    method === "GET" || method === "HEAD"
      ? (self) => self
      : HttpClientRequest.bodyStream(request.stream, {
          contentType: request.headers["content-type"],
        }),
  );
  const response = yield* httpClient
    .execute(upstreamRequest)
    .pipe(Effect.orElseSucceed(() => null));
  if (response === null) {
    return HttpServerResponse.text("The session's stream is not answering", { status: 502 });
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (DROPPED_RESPONSE_HEADERS.has(name) || value === undefined) continue;
    headers[name] = value;
  }
  headers["cache-control"] = "no-store, no-transform";
  // The page's URL holds the viewer token; no request from it may carry that elsewhere.
  headers["referrer-policy"] = "no-referrer";
  return HttpServerResponse.stream(response.stream.pipe(Stream.interruptWhen(target.revoked)), {
    status: response.status,
    headers,
    ...(headers["content-type"] ? { contentType: headers["content-type"] } : {}),
  });
});

const handler = Effect.fn("HarnessStreamProxy.handle")(function* (
  harness: HarnessService.HarnessService["Service"],
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = requestUrl(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  const parsed = parseStreamPath(url.value.pathname);
  if (parsed === null) return HttpServerResponse.text("Not Found", { status: 404 });
  // The viewer token is the credential: only a client session allowed to operate this
  // environment is given one, and it ends with that session or the harness session.
  const target = yield* harness.streamTarget(parsed.sessionId, parsed.token);
  if (Option.isNone(target)) return HttpServerResponse.text("Not Found", { status: 404 });
  // The page resolves its assets and signalling against its own folder.
  if (parsed.rest === null) {
    return HttpServerResponse.redirect(`${url.value.pathname}/${url.value.search}`, {
      status: 302,
      headers: { "referrer-policy": "no-referrer", "cache-control": "no-store" },
    });
  }
  const upstreamUrl = `${target.value.origin}${target.value.basePath}${parsed.rest}${url.value.search}`;
  if (request.headers.upgrade?.toLowerCase() === "websocket") {
    return yield* proxyWebSocket(request, upstreamUrl.replace(/^http/, "ws"), target.value);
  }
  return yield* proxyHttp(request, upstreamUrl, target.value);
});

// The service is the one the routes are given, not looked up per request.
export const routeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const harness = yield* HarnessService.HarnessService;
    return HttpRouter.add("*", `${HarnessService.HARNESS_STREAM_ROUTE_PREFIX}/*`, handler(harness));
  }),
);
