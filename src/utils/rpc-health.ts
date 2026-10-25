import { parseUnits } from "viem";

export type RpcHealthStatus = "healthy" | "timeout" | "aborted" | "mismatched-chain" | "invalid-url" | "rpc-error" | "unreachable";

export interface RpcHealthCheckOptions {
  timeoutMs?: number;
  expectedChainId?: number;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}

export interface RpcHealthCheckResult {
  status: RpcHealthStatus;
  rpcUrl: string;
  latencyMs: number;
  chainId?: number;
  chainIdHex?: string;
  error?: string;
}

interface RpcResponsePayload {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
}

export const DEFAULT_RPC_HEALTH_TIMEOUT_MS = 1_500;

function isValidRpcUrl(rpcUrl: string): boolean {
  if (rpcUrl.startsWith("//")) return false;
  if (rpcUrl.startsWith("/")) return true;
  try {
    const parsed = new URL(rpcUrl);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function parseChainId(result: unknown): { chainId: number; chainIdHex: string } | null {
  if (typeof result !== "string" || !result.startsWith("0x")) {
    return null;
  }
  const numeric = Number.parseInt(result, 16);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    return null;
  }
  return { chainId: numeric, chainIdHex: result };
}

export async function rpcHealthCheck(rpcUrl: string, options: RpcHealthCheckOptions = {}): Promise<RpcHealthCheckResult> {
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  const { timeoutMs = DEFAULT_RPC_HEALTH_TIMEOUT_MS, expectedChainId, signal, fetcher = fetch } = options;

  if (!isValidRpcUrl(rpcUrl)) {
    return { status: "invalid-url", rpcUrl, latencyMs: elapsed(), error: "RPC URL must be an absolute http(s) URL or a relative path" };
  }

  if (signal?.aborted) {
    return { status: "aborted", rpcUrl, latencyMs: elapsed(), error: "Health check was aborted before it started" };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = () => controller.abort();
  signal?.addEventListener("abort", onCallerAbort);

  try {
    const fetchAndDecode = async (): Promise<{ response: Response; payload?: RpcResponsePayload }> => {
      const response = await fetcher(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_chainId",
          params: [],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        return { response };
      }

      const payload = (await response.json()) as RpcResponsePayload;
      return { response, payload };
    };

    const { response, payload } = await fetchAndDecode();

    if (!response.ok || !payload) {
      return { status: "unreachable", rpcUrl, latencyMs: elapsed(), error: `HTTP ${response.status}` };
    }
    if (payload.error) {
      return { status: "rpc-error", rpcUrl, latencyMs: elapsed(), error: payload.error.message ?? "RPC responded with an error" };
    }

    const parsed = parseChainId(payload.result);
    if (!parsed) {
      return { status: "rpc-error", rpcUrl, latencyMs: elapsed(), error: "Invalid eth_chainId response" };
    }

    if (expectedChainId !== undefined && parsed.chainId !== expectedChainId) {
      return {
        status: "mismatched-chain",
        rpcUrl,
        chainId: parsed.chainId,
        chainIdHex: parsed.chainIdHex,
        latencyMs: elapsed(),
        error: `Expected chain ${expectedChainId}, got ${parsed.chainId}`,
      };
    }

    return { status: "healthy", rpcUrl, chainId: parsed.chainId, chainIdHex: parsed.chainIdHex, latencyMs: elapsed() };
  } catch (error) {
    const status: RpcHealthStatus = timedOut ? "timeout" : signal?.aborted ? "aborted" : "unreachable";
    return {
      status,
      rpcUrl,
      latencyMs: elapsed(),
      error: timedOut ? `Timed out after ${timeoutMs}ms` : error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}
