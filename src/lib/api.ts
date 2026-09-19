export interface InvokeOptions {
  body?: unknown;
}

export interface InvokeResult<T = any> {
  data: T | null;
  error: Error | null;
}

const configuredBaseUrl = import.meta.env.VITE_API_URL?.replace(/\/$/, "") || "";

async function invoke<T = any>(name: string, options: InvokeOptions = {}): Promise<InvokeResult<T>> {
  try {
    const response = await fetch(
      `${configuredBaseUrl}/api/functions/v1/${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options.body ?? {}),
      },
    );
    const text = await response.text();
    const data = text ? JSON.parse(text) as T : null;
    if (!response.ok) {
      const message = data && typeof data === "object" && "error" in data
        ? String((data as Record<string, unknown>).error)
        : `API request failed (${response.status})`;
      return { data, error: new Error(message) };
    }
    return { data, error: null };
  } catch (error) {
    return {
      data: null,
      error: error instanceof Error ? error : new Error("No se pudo contactar la API"),
    };
  }
}

export const api = {
  functions: { invoke },
};
