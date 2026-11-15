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

export function endpoint<Args extends unknown[]>(handler: (request: Request, ...args: Args) => Promise<Response>) {
  return async (request: Request, ...args: Args) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        const origin = configuredOrigin() || new URL(request.url).origin;
        if (request.headers.get("origin") !== origin) throw new HttpError(403, "Origin rejected.");
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
