import type { FastifyInstance } from 'fastify';
import type { AppContext } from './context.js';
import { getGatewayUpstreamBaseUrl } from '@heisenberg/shared';

/**
 * Transparent Ollama Gateway (data plane).
 *
 * Forwards Codex inference requests from /gateway/ollama/v1/* to the real
 * Ollama upstream (/v1/*) without buffering streaming responses. Chunks are
 * forwarded as they arrive; the gateway never modifies generated content and
 * never stores prompt/response text (metadata-only observation).
 *
 * Loop prevention: the upstream is validated at startup and must never point
 * back at the HCR origin.
 */

/** Hop-by-hop headers that must not be proxied verbatim. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

/** Non-streaming JSON responses where Ollama reports final usage inline. */
function extractInlineUsage(body: string): { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null {
  try {
    const parsed = JSON.parse(body) as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
    const usage = parsed.usage;
    if (!usage) return null;
    const out: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {};
    if (typeof usage.prompt_tokens === 'number') out.inputTokens = usage.prompt_tokens;
    if (typeof usage.completion_tokens === 'number') out.outputTokens = usage.completion_tokens;
    if (typeof usage.total_tokens === 'number') out.totalTokens = usage.total_tokens;
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Scan one SSE data line for OpenAI-compatible usage metadata. The final
 * chunk of a Responses-API stream carries usage; content is never retained.
 */
function extractStreamUsage(dataLine: string): { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null {
  if (!dataLine.startsWith('data:')) return null;
  const payload = dataLine.slice(5).trim();
  if (payload.length === 0 || payload === '[DONE]') return null;
  try {
    const parsed = JSON.parse(payload) as {
      response?: { usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } };
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; input_tokens?: number; output_tokens?: number };
    };
    const u1 = parsed.response?.usage;
    if (u1) {
      const out: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {};
      if (typeof u1.input_tokens === 'number') out.inputTokens = u1.input_tokens;
      if (typeof u1.output_tokens === 'number') out.outputTokens = u1.output_tokens;
      if (typeof u1.total_tokens === 'number') out.totalTokens = u1.total_tokens;
      return Object.keys(out).length > 0 ? out : null;
    }
    const u2 = parsed.usage;
    if (u2) {
      const out: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {};
      if (typeof u2.prompt_tokens === 'number') out.inputTokens = u2.prompt_tokens;
      if (typeof u2.completion_tokens === 'number') out.outputTokens = u2.completion_tokens;
      if (typeof u2.input_tokens === 'number') out.inputTokens = u2.input_tokens;
      if (typeof u2.output_tokens === 'number') out.outputTokens = u2.output_tokens;
      if (typeof u2.total_tokens === 'number') out.totalTokens = u2.total_tokens;
      return Object.keys(out).length > 0 ? out : null;
    }
    return null;
  } catch {
    return null;
  }
}

export async function registerGateway(app: FastifyInstance, context: AppContext): Promise<void> {
  const { gateway, ollama } = context;

  // Validate upstream once at registration: fail fast on a loop config.
  let upstreamBase: string;
  try {
    upstreamBase = getGatewayUpstreamBaseUrl();
  } catch (error) {
    // Do not register the gateway at all if it would loop.
    app.log.error(String(error));
    return;
  }

  app.all('/gateway/ollama/v1/*', async (request, reply) => {
    const upstreamPath = (request.params as { '*': string })['*'];
    const upstreamUrl = `${upstreamBase}/${upstreamPath}${request.url.includes('?') ? `?${request.url.split('?')[1]}` : ''}`;

    // Identify the requested model without retaining the body content.
    let requestedModel: string | null = null;
    try {
      const body = (request.body ?? {}) as { model?: string };
      if (typeof body?.model === 'string') requestedModel = body.model;
    } catch {
      requestedModel = null;
    }

    const acceptHeader = request.headers['accept'] ?? '';
    const isStream =
      acceptHeader.includes('text/event-stream') ||
      (typeof request.headers['content-type'] === 'string' &&
        request.headers['content-type'].includes('application/json') &&
        // Responses/Chat streams declare stream:true in the body.
        JSON.stringify(request.body ?? {}).includes('"stream":true'));

    const requestId = gateway.begin({
      model: requestedModel,
      client: null, // CLI vs VS Code is not reliably distinguishable here
      streaming: isStream,
    });

    const headers: Record<string, string | string[] | undefined> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (!HOP_BY_HOP.has(key.toLowerCase())) headers[key] = value;
    }

    // Body passthrough: Fastify parses JSON bodies to objects; strings and
    // buffers pass through unchanged. Re-serialize objects without touching
    // their content.
    let upstreamBody: string | Buffer | undefined;
    if (!['GET', 'HEAD'].includes(request.method)) {
      if (typeof request.body === 'string') upstreamBody = request.body;
      else if (Buffer.isBuffer(request.body)) upstreamBody = request.body;
      else if (request.body !== undefined && request.body !== null) upstreamBody = JSON.stringify(request.body);
    }

    let upstream: Response;
    gateway.forwarding(requestId);
    try {
      upstream = await fetch(upstreamUrl, {
        method: request.method,
        headers: headers as Record<string, string>,
        body: upstreamBody,
        // Node fetch (undici) streams the response body incrementally.
      });
    } catch (error) {
      // Upstream unavailable: clear error, HCR stays alive, attempt recorded.
      gateway.fail(requestId, `upstream unreachable: ${error instanceof Error ? error.message : 'unknown'}`, 502);
      return reply.code(502).send({
        error: {
          message: 'HCR gateway cannot reach the Ollama upstream. Is Ollama running?',
          type: 'upstream_unavailable',
        },
      });
    }

    if (!upstream.ok && upstream.status >= 400) {
      const text = await upstream.text();
      gateway.fail(requestId, `upstream error ${upstream.status}`, upstream.status);
      // Pass through the upstream error status/body shape.
      reply.code(upstream.status);
      reply.header('content-type', upstream.headers.get('content-type') ?? 'application/json');
      return reply.send(text);
    }

    gateway.firstResponse(requestId, upstream.status);

    const upstreamContentType = upstream.headers.get('content-type') ?? 'application/json';
    reply.code(upstream.status);
    reply.header('content-type', upstreamContentType);
    const upstreamStream = upstream.headers.get('transfer-encoding') === 'chunked' || upstream.body !== null;

    if (isStream || upstreamContentType.includes('text/event-stream')) {
      // STREAMING: forward chunks immediately as they arrive from upstream.
      reply.header('cache-control', 'no-cache');
      reply.header('connection', 'keep-alive');
      reply.raw.writeHead(upstream.status, {
        'content-type': upstreamContentType,
        'cache-control': 'no-cache',
        'access-control-allow-origin': '*',
      });

      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamUsage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null = null;

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          // Observe (metadata only) then immediately forward — in that order,
          // but never blocking the pipe longer than the copy itself.
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const found = extractStreamUsage(line);
            if (found) streamUsage = found;
          }
          reply.raw.write(Buffer.from(value));
        }
      } catch (error) {
        gateway.fail(requestId, `stream aborted: ${error instanceof Error ? error.message : 'unknown'}`);
        reply.raw.end();
        return;
      }

      if (streamUsage) gateway.usage(requestId, streamUsage);
      reply.raw.end();
      gateway.complete(requestId);
      return reply;
    }

    // NON-STREAMING: observe usage from the JSON body, then forward as-is.
    const text = await upstream.text();
    const inlineUsage = extractInlineUsage(text);
    if (inlineUsage) gateway.usage(requestId, inlineUsage);
    gateway.complete(requestId);
    return reply.send(text);
  });

  // Upstream reference kept for status/diagnostics without triggering loops.
  void ollama;
}
