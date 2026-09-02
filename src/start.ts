import { createStart, createCsrfMiddleware, createMiddleware } from "@tanstack/react-start";

import { renderErrorPage } from "./lib/error-page";

const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error(error);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

/* Streaming agent endpoint — bypasses server function pipeline for SSE */
const streamMiddleware = createMiddleware().server(async ({ request, next }) => {
  const url = new URL(request.url);

  // Streaming agent
  if (url.pathname === "/api/agent-stream" && request.method === "POST") {
    const { handleAgentStream } = await import("./lib/agent-stream");
    return handleAgentStream(request);
  }

  // Revert last commit
  if (url.pathname === "/api/rollback" && request.method === "POST") {
    const { handleRollback } = await import("./lib/rollback");
    return handleRollback(request);
  }

  // Download repo as ZIP
  if (url.pathname === "/api/download-repo" && request.method === "POST") {
    const { handleDownloadRepo } = await import("./lib/download-repo");
    return handleDownloadRepo(request);
  }

  return next();
});

// Start installs this automatically when src/start.ts is absent; defining the
// file opts out, so re-add it explicitly to keep server functions protected
// from cross-site requests.
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

export const startInstance = createStart(() => ({
  requestMiddleware: [streamMiddleware, errorMiddleware, csrfMiddleware],
}));
