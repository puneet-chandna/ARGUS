import { useEffect, useState } from "react";
import type { CacheCheck } from "../lib/progress";
import { api, RequestError } from "./client-api";

export const unknownCache: CacheCheck = { cache: "miss", pagesTotal: null, pagesCached: 0 };

export function useCachePreflight(file: File | null, onUnauthorized: React.RefObject<() => void>) {
  const [checked, setChecked] = useState<{ file: File; check: CacheCheck }>();
  useEffect(() => {
    if (!file) return;
    const controller = new AbortController();
    let worker: Worker | undefined;
    const timer = setTimeout(() => {
      controller.abort();
      worker?.terminate();
      setChecked({ file, check: unknownCache });
    }, 1500);
    async function check(file: File) {
      try {
        const hash = file.size > 5 * 1024 * 1024
          ? await new Promise<string>((resolve, reject) => {
            worker = new Worker(new URL("./hash.worker.ts", import.meta.url));
            controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
            worker.onmessage = ({ data }) => typeof data === "string" ? resolve(data) : reject(new Error("Hash failed"));
            worker.onerror = reject;
            worker.postMessage(file);
          })
          : Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), byte => byte.toString(16).padStart(2, "0")).join("");
        if (controller.signal.aborted) return;
        const check = await api<CacheCheck>(`/api/cache/check?hash=${hash}`, { signal: controller.signal });
        if (!controller.signal.aborted) setChecked({ file, check });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof RequestError && error.status === 401) onUnauthorized.current();
        else setChecked({ file, check: unknownCache });
      } finally {
        clearTimeout(timer);
        worker?.terminate();
      }
    }
    void check(file);
    return () => { clearTimeout(timer); controller.abort(); worker?.terminate(); };
  }, [file, onUnauthorized]);
  return checked?.file === file ? checked?.check : undefined;
}
