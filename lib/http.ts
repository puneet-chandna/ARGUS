export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
}

export function configuredOrigin() {
  return process.env.ARGUS_PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL;
}

export function requestOrigin(request: Request) {
  const configured = configuredOrigin();
  if (configured) return new URL(configured).origin;

  const url = new URL(request.url);
  const host = request.headers.get("host");
  // Next can use the listener hostname in request.url. Only recover loopback aliases on the same port.
  if (host && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host) &&
      ["localhost", "127.0.0.1", "[::1]", "0.0.0.0", "[::]"].includes(url.hostname)) {
    const browser = URL.parse(`${url.protocol}//${host}`);
    if (browser && browser.port === url.port) return browser.origin;
  }
  return url.origin;
}

export function endpoint<Args extends unknown[]>(handler: (request: Request, ...args: Args) => Promise<Response>) {
  return async (request: Request, ...args: Args) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        if (request.headers.get("origin") !== requestOrigin(request)) throw new HttpError(403, "Origin rejected.");
      }
      return await handler(request, ...args);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      return json({ error: "The service could not complete the request." }, 503);
    }
  };
}

export async function readJson(request: Request, maxBytes = 8192): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    throw new HttpError(415, "Expected a JSON request.");
  }
  const reader = request.body?.getReader();
  try {
    if (!reader) throw new Error();
    let length = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) throw new HttpError(413, "Request too large.");
      chunks.push(value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid JSON object.");
  } finally {
    await reader?.cancel().catch(() => {});
  }
}
