export type FunctionHandler = (request: Request) => Promise<Response> | Response;

/**
 * Compatibility wrapper for the former edge-function modules. It only returns
 * the handler; the Node HTTP server owns the actual listener.
 */
export function serve(handler: FunctionHandler): FunctionHandler {
  return handler;
}

declare global {
  const Deno: {
    env: {
      get(name: string): string | undefined;
    };
  };
}

Object.defineProperty(globalThis, "Deno", {
  configurable: false,
  enumerable: false,
  writable: false,
  value: {
    env: {
      get(name: string) {
        return process.env[name];
      },
    },
  },
});
