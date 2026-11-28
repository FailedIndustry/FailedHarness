import { afterEach, describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/http";

import * as HarnessService from "./HarnessService.ts";
import * as HarnessStreamProxy from "./HarnessStreamProxy.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const SESSION = "11111111-2222-3333-4444-555555555555";
const TOKEN = "a".repeat(64);

const fixture = () => {
  const requests: Array<{ url: string; headers: Readonly<Record<string, string>> }> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push({ url: request.url, headers: request.headers });
      return HttpClientResponse.fromWeb(
        request,
        new Response("<html>selkies</html>", {
          headers: {
            "content-type": "text/html",
            "set-cookie": "selkies=1",
            "www-authenticate": 'Basic realm="selkies"',
            "x-frame-options": "DENY",
          },
        }),
      );
    }),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    HarnessStreamProxy.routeLayer.pipe(
      Layer.provideMerge(
        Layer.mock(HarnessService.HarnessService)({
          streamTarget: (sessionId, token) =>
            Effect.succeed(
              sessionId === SESSION && token === TOKEN
                ? Option.some({
                    origin: "http://127.0.0.1:5983",
                    basePath: `/api/harness/stream/${SESSION}/`,
                    authorization: "Basic cGxheWVyOnNlY3JldA==",
                    revoked: Effect.never,
                  })
                : Option.none(),
            ),
        }),
      ),
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, requests };
};

describe("harness stream proxy", () => {
  it("forwards to the session's fixed loopback target with its login, never the browser's", async () => {
    const { handler, requests } = fixture();
    const response = await handler(
      new Request(`http://t3.test/api/harness/stream/${SESSION}/${TOKEN}/assets/app.js?x=1`, {
        headers: {
          cookie: "t3_session=secret",
          authorization: "Bearer t3-token",
          origin: "http://t3.test",
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>selkies</html>");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(
      `http://127.0.0.1:5983/api/harness/stream/${SESSION}/assets/app.js?x=1`,
    );
    expect(requests[0]!.headers.authorization).toBe("Basic cGxheWVyOnNlY3JldA==");
    expect(requests[0]!.headers.cookie).toBeUndefined();
    expect(requests[0]!.headers.origin).toBe("http://127.0.0.1:5983");
    // Selkies refuses a websocket whose Origin does not match its Host.
    expect(requests[0]!.headers.host).toBe("127.0.0.1:5983");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("answers an unknown session or viewer token with 404 and contacts nothing", async () => {
    const { handler, requests } = fixture();
    for (const path of [
      `/api/harness/stream/${SESSION}/${"b".repeat(64)}/`,
      `/api/harness/stream/other/${TOKEN}/`,
      `/api/harness/stream/${SESSION}/`,
    ]) {
      const response = await handler(new Request(`http://t3.test${path}`));
      expect(response.status).toBe(404);
    }
    expect(requests).toEqual([]);
  });

  it("sends the page's own folder to its trailing slash, so its relative URLs resolve", async () => {
    const { handler, requests } = fixture();
    const response = await handler(
      new Request(`http://t3.test/api/harness/stream/${SESSION}/${TOKEN}`),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/api/harness/stream/${SESSION}/${TOKEN}/`);
    expect(requests).toEqual([]);
  });

  it("sends websocket upgrades the loopback target as both Host and Origin, with the login", () => {
    expect(
      HarnessStreamProxy.targetHeaders({
        origin: "http://127.0.0.1:5983",
        authorization: "Basic cGxheWVyOnNlY3JldA==",
      }),
    ).toEqual({
      host: "127.0.0.1:5983",
      origin: "http://127.0.0.1:5983",
      authorization: "Basic cGxheWVyOnNlY3JldA==",
    });
  });

  it("splits a stream path into session, token and the rest", () => {
    expect(HarnessStreamProxy.parseStreamPath(`/api/harness/stream/s/t/a/b`)).toEqual({
      sessionId: "s",
      token: "t",
      rest: "a/b",
    });
    expect(HarnessStreamProxy.parseStreamPath(`/api/harness/stream/s/t/`)).toEqual({
      sessionId: "s",
      token: "t",
      rest: "",
    });
    expect(HarnessStreamProxy.parseStreamPath(`/api/harness/stream/s`)).toBeNull();
    expect(HarnessStreamProxy.parseStreamPath(`/api/other/s/t/`)).toBeNull();
  });
});
