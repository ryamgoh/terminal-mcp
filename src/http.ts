import { timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler, localhostAllowedHostnames, OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpExpressApp, requireBearerAuth } from '@modelcontextprotocol/express';
import { SERVER_NAME, SERVER_VERSION } from './config.js';
import { log } from './audit.js';

export interface HttpOptions {
  host: string;
  port: number;
  /** Static bearer token. null disables auth (only allowed on loopback binds). */
  token: string | null;
  /** Extra Host header names to accept, e.g. a tunnel hostname such as my-box.ngrok-free.dev. */
  allowedHosts: string[];
  /** Origin hostnames to accept from browser-based clients (requests without Origin always pass). */
  allowedOrigins: string[];
  /** Accept any Host header (token auth still applies). */
  allowAnyHost: boolean;
  /** Also accept the token as a secret path (/mcp/<token>) for clients that can only be given a URL. */
  urlToken: boolean;
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Everything security-related here is the official SDK: createMcpExpressApp applies Host/Origin
 * validation (DNS-rebinding protection), requireBearerAuth answers 401 with a proper
 * WWW-Authenticate challenge, and createMcpHandler serves both 2025-era and 2026-07-28 clients.
 */
export function startHttp(buildServer: () => McpServer, opts: HttpOptions): Promise<Server> {
  const app = createMcpExpressApp({
    host: opts.allowAnyHost ? '0.0.0.0' : opts.host,
    allowedHosts: opts.allowAnyHost || opts.allowedHosts.length === 0 ? undefined : [...localhostAllowedHostnames(), ...opts.allowedHosts],
    allowedOrigins: opts.allowedOrigins.length ? [...localhostAllowedHostnames(), ...opts.allowedOrigins] : undefined,
    jsonLimit: '4mb',
  });

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, name: SERVER_NAME, version: SERVER_VERSION });
  });

  const handler = toNodeHandler(createMcpHandler(buildServer, { responseMode: 'json' }), {
    onerror: (err) => log.error({ err }, 'MCP HTTP handler error'),
  });

  if (opts.token && opts.urlToken) {
    const token = opts.token;
    // Registered before the bearer middleware, which would otherwise claim every /mcp/* path.
    app.all('/mcp/:secret', (req, res) => {
      if (!sameToken(String(req.params.secret), token)) {
        res.status(404).end();
        return;
      }
      void handler(req, res, req.body);
    });
  }

  if (opts.token) {
    const token = opts.token;
    app.use(
      '/mcp',
      requireBearerAuth({
        verifier: {
          async verifyAccessToken(candidate: string) {
            if (!sameToken(candidate, token)) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid bearer token');
            // The SDK requires an expiry; a static token is valid until the server restarts with a new one.
            return { token: candidate, clientId: 'static-token', scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 3600 };
          },
        },
      }),
    );
  }

  app.all('/mcp', (req, res) => {
    void handler(req, res, req.body);
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(opts.port, opts.host, () => resolve(server));
    server.on('error', reject);
  });
}
