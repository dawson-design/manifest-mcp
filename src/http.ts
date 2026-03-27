/// <reference types="@cloudflare/workers-types" />

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createServer } from './server.js';
import type { ManifestClientConfig } from './client.js';

export interface McpWorkerEnv {
  MANIFEST_API_BASE_URL?: string;
  WORKOS_AUTHKIT_DOMAIN?: string;
  WORKOS_CLIENT_ID?: string;
}

interface TransportLike {
  handleRequest(request: Request): Promise<Response>;
  close(): Promise<void>;
}

interface ServerLike {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
}

interface WorkerDependencies {
  createServer: (config?: ManifestClientConfig) => ServerLike;
  createTransport: () => TransportLike;
  fetchImpl: typeof fetch;
  verifyBearerToken: (request: Request, env: McpWorkerEnv) => Promise<string>;
}

class UnauthorizedError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_request' | 'invalid_token',
  ) {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function isUnauthorizedError(error: unknown): error is UnauthorizedError {
  return error instanceof UnauthorizedError
    || (
      typeof error === 'object'
      && error !== null
      && 'name' in error
      && 'message' in error
      && 'code' in error
      && (error as { name?: unknown }).name === 'UnauthorizedError'
      && ((error as { code?: unknown }).code === 'invalid_request'
        || (error as { code?: unknown }).code === 'invalid_token')
    );
}

function isConfigurationError(error: unknown): error is ConfigurationError {
  return error instanceof ConfigurationError
    || (
      typeof error === 'object'
      && error !== null
      && 'name' in error
      && 'message' in error
      && (error as { name?: unknown }).name === 'ConfigurationError'
    );
}

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

function normalizeBaseUrl(value: string | undefined, envVar: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new ConfigurationError(`Server misconfigured: missing ${envVar}`);
  }

  try {
    const url = new URL(trimmed);
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/+$/, '');
  } catch {
    throw new ConfigurationError(`Server misconfigured: invalid ${envVar}`);
  }
}

function getJwks(issuer: string) {
  const cached = jwksByIssuer.get(issuer);
  if (cached) return cached;

  const jwks = createRemoteJWKSet(new URL(`${issuer}/oauth2/jwks`));
  jwksByIssuer.set(issuer, jwks);
  return jwks;
}

function buildResourceMetadataUrl(request: Request): string {
  const url = new URL(request.url);
  return `${url.origin}/.well-known/oauth-protected-resource`;
}

function buildWwwAuthenticateHeader(
  request: Request,
  error: UnauthorizedError['code'],
  message: string,
): string {
  const escapedMessage = message.replace(/"/g, '\\"');
  return `Bearer realm="manifest-mcp", resource_metadata="${buildResourceMetadataUrl(request)}", error="${error}", error_description="${escapedMessage}"`;
}

export function buildProtectedResourceMetadata(resource: string, authkitDomain: string) {
  return {
    resource,
    authorization_servers: [authkitDomain],
    bearer_methods_supported: ['header'],
  };
}

async function defaultVerifyBearerToken(request: Request, env: McpWorkerEnv): Promise<string> {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw new UnauthorizedError('Missing bearer token.', 'invalid_request');
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    throw new UnauthorizedError('Missing bearer token.', 'invalid_request');
  }

  const issuer = normalizeBaseUrl(env.WORKOS_AUTHKIT_DOMAIN, 'WORKOS_AUTHKIT_DOMAIN');
  const verifyOptions: { issuer: string; audience?: string } = { issuer };
  if (env.WORKOS_CLIENT_ID?.trim()) {
    verifyOptions.audience = env.WORKOS_CLIENT_ID.trim();
  }

  try {
    await jwtVerify(token, getJwks(issuer), verifyOptions);
  } catch {
    throw new UnauthorizedError('Invalid bearer token.', 'invalid_token');
  }

  return token;
}

function unauthorizedResponse(request: Request, error: UnauthorizedError): Response {
  return jsonResponse(
    { error: error.message },
    401,
    { 'WWW-Authenticate': buildWwwAuthenticateHeader(request, error.code, error.message) },
  );
}

function withRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Manifest-Request-Id', requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function createMcpWorker(overrides: Partial<WorkerDependencies> = {}) {
  const deps: WorkerDependencies = {
    createServer,
    createTransport: () => new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    }),
    fetchImpl: fetch,
    verifyBearerToken: defaultVerifyBearerToken,
    ...overrides,
  };

  return {
    async fetch(request: Request, env: McpWorkerEnv): Promise<Response> {
      const url = new URL(request.url);

      if (url.pathname === '/.well-known/oauth-protected-resource') {
        let authkitDomain: string;
        try {
          authkitDomain = normalizeBaseUrl(env.WORKOS_AUTHKIT_DOMAIN, 'WORKOS_AUTHKIT_DOMAIN');
        } catch (error) {
          if (isConfigurationError(error)) {
            return jsonResponse({ error: error.message }, 500);
          }
          throw error;
        }
        return jsonResponse(buildProtectedResourceMetadata(url.origin, authkitDomain));
      }

      if (url.pathname === '/.well-known/oauth-authorization-server') {
        let authkitDomain: string;
        try {
          authkitDomain = normalizeBaseUrl(env.WORKOS_AUTHKIT_DOMAIN, 'WORKOS_AUTHKIT_DOMAIN');
        } catch (error) {
          if (isConfigurationError(error)) {
            return jsonResponse({ error: error.message }, 500);
          }
          throw error;
        }
        return deps.fetchImpl(new URL('/.well-known/oauth-authorization-server', `${authkitDomain}/`));
      }

      if (url.pathname !== '/') {
        return jsonResponse({ error: 'Not found' }, 404);
      }

      let bearerToken: string;
      try {
        bearerToken = await deps.verifyBearerToken(request, env);
      } catch (error) {
        if (isUnauthorizedError(error)) {
          return unauthorizedResponse(request, error);
        }
        if (isConfigurationError(error)) {
          return jsonResponse({ error: error.message }, 500);
        }
        throw error;
      }

      let apiBaseUrl: string;
      try {
        apiBaseUrl = normalizeBaseUrl(env.MANIFEST_API_BASE_URL, 'MANIFEST_API_BASE_URL');
      } catch (error) {
        if (isConfigurationError(error)) {
          return jsonResponse({ error: error.message }, 500);
        }
        throw error;
      }
      const requestId = request.headers.get('x-manifest-request-id')?.trim() || crypto.randomUUID();

      const server = deps.createServer({
        baseUrl: apiBaseUrl,
        accessToken: bearerToken,
        enableSessionState: false, // Worker is stateless per request
        defaultHeaders: {
          'X-Manifest-Client': 'mcp-cloud',
          'X-Manifest-Request-Id': requestId,
        },
      });
      const transport = deps.createTransport();
      const closeAsync = () => {
        void Promise.allSettled([transport.close(), server.close()]);
      };

      try {
        await server.connect(transport);
        const response = await transport.handleRequest(request);
        closeAsync();
        return withRequestId(response, requestId);
      } catch (error) {
        await Promise.allSettled([transport.close(), server.close()]);
        throw error;
      }
    },
  };
}
