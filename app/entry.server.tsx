import { PassThrough } from "node:stream";
import type { AppLoadContext, EntryContext } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { ServerRouter } from "react-router";
import { isbot } from "isbot";
import type { RenderToPipeableStreamOptions } from "react-dom/server";
import { renderToPipeableStream } from "react-dom/server";

// How long the server will wait for deferred/streamed loader data before it
// aborts the stream. The default (5s) is far too short for the forecasting
// page, whose live Shopify/ShipHero pulls can take longer on a cold cache —
// when the stream aborted, the page rendered its "Couldn't load" error. The
// forecasting loader caps each integration well under this, so the deferred
// data always resolves in time.
export const streamTimeout = 30_000;

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: AppLoadContext
) {
  return new Promise((resolve, reject) => {
    let shellRendered = false;
    const userAgent = request.headers.get("user-agent");

    // Bots and SPA-mode requests need the full document; interactive requests
    // can start streaming as soon as the shell is ready.
    const readyOption: keyof RenderToPipeableStreamOptions =
      (userAgent && isbot(userAgent)) || routerContext.isSpaMode
        ? "onAllReady"
        : "onShellReady";

    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={routerContext} url={request.url} />,
      {
        [readyOption]() {
          shellRendered = true;
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");

          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            })
          );

          pipe(body);
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          responseStatusCode = 500;
          // Log streaming errors once the shell has already been sent.
          if (shellRendered) {
            console.error(error);
          }
        },
      }
    );

    // Abort a little after the timeout so any in-flight deferred data has a
    // chance to settle first.
    setTimeout(abort, streamTimeout + 1000);
  });
}
