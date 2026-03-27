import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpWorker } from '../src/http.js';

describe('MCP HTTP worker', () => {
  const env = {
    MANIFEST_API_BASE_URL: 'https://api.manifestdocs.ai',
    WORKOS_AUTHKIT_DOMAIN: 'https://manifestdocs.authkit.app',
    WORKOS_CLIENT_ID: 'client_123',
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns protected resource metadata', async () => {
    const worker = createMcpWorker();

    const res = await worker.fetch(
      new Request('https://mcp.manifestdocs.ai/.well-known/oauth-protected-resource'),
      env,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      resource: 'https://mcp.manifestdocs.ai',
      authorization_servers: ['https://manifestdocs.authkit.app'],
      bearer_methods_supported: ['header'],
    });
  });

  it('proxies auth server metadata', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ issuer: 'https://manifestdocs.authkit.app' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const worker = createMcpWorker({ fetchImpl: fetchImpl as typeof fetch });

    const res = await worker.fetch(
      new Request('https://mcp.manifestdocs.ai/.well-known/oauth-authorization-server'),
      env,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      'https://manifestdocs.authkit.app/.well-known/oauth-authorization-server',
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ issuer: 'https://manifestdocs.authkit.app' });
  });

  it('rejects unauthenticated MCP requests with resource metadata challenge', async () => {
    const worker = createMcpWorker({
      verifyBearerToken: vi.fn().mockRejectedValue({
        name: 'UnauthorizedError',
        code: 'invalid_request',
        message: 'Missing bearer token.',
      }),
    });
    const request = new Request('https://mcp.manifestdocs.ai/', { method: 'POST' });

    const res = await worker.fetch(request, env);

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      'resource_metadata="https://mcp.manifestdocs.ai/.well-known/oauth-protected-resource"',
    );
    await expect(res.json()).resolves.toEqual({ error: 'Missing bearer token.' });
  });

  it('returns 500 when MCP auth is misconfigured', async () => {
    const verifyBearerToken = vi.fn().mockRejectedValue(
      {
        name: 'ConfigurationError',
        message: 'Server misconfigured: missing WORKOS_AUTHKIT_DOMAIN',
      },
    );
    const worker = createMcpWorker({
      verifyBearerToken: verifyBearerToken as any,
    });

    const res = await worker.fetch(
      new Request('https://mcp.manifestdocs.ai/', { method: 'POST' }),
      env,
    );

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: 'Server misconfigured: missing WORKOS_AUTHKIT_DOMAIN',
    });
  });

  it('creates a request-scoped MCP server using the caller bearer token', async () => {
    const server = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const createServer = vi.fn().mockReturnValue(server);
    const transport = {
      handleRequest: vi.fn().mockResolvedValue(new Response('ok', { status: 200 })),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const verifyBearerToken = vi.fn().mockResolvedValue('user-token');
    const worker = createMcpWorker({
      createServer: createServer as any,
      createTransport: () => transport as any,
      verifyBearerToken,
    });
    const request = new Request('https://mcp.manifestdocs.ai/', {
      method: 'POST',
      headers: {
        authorization: 'Bearer user-token',
        'x-manifest-request-id': 'req_123',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'initialize', params: {} }),
    });

    const res = await worker.fetch(request, env);

    expect(res.status).toBe(200);
    expect(createServer).toHaveBeenCalledWith({
      baseUrl: 'https://api.manifestdocs.ai',
      accessToken: 'user-token',
      enableSessionState: false,
      defaultHeaders: {
        'X-Manifest-Client': 'mcp-cloud',
        'X-Manifest-Request-Id': 'req_123',
      },
    });
    expect(server.connect).toHaveBeenCalledWith(transport);
    expect(transport.handleRequest).toHaveBeenCalledWith(request);
    expect(transport.close).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
    expect(res.headers.get('x-manifest-request-id')).toBe('req_123');
  });

  it('returns 404 for unknown paths', async () => {
    const worker = createMcpWorker();

    const res = await worker.fetch(
      new Request('https://mcp.manifestdocs.ai/unknown'),
      env,
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'Not found' });
  });
});
