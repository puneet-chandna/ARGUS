export class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...init });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new RequestError(typeof data?.error === "string" ? data.error : "The request could not be completed.", response.status);
  }
  return data as T;
}

export function json(method: string, value: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) };
}

export function message(error: unknown): string {
  return error instanceof RequestError ? error.message : "Could not connect to Argus. Try again.";
}
