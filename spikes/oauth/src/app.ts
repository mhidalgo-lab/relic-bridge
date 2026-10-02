// SPDX-License-Identifier: Apache-2.0
// P0-08 spike: one runtime-agnostic fetch app that is both the OAuth 2.1 authorization server and the
// protected resource for N project slugs (/p/{slug}/mcp). Runs under workerd (worker.ts) and Node (node.ts).
import {
  AuthorizationError,
  type AuthRequest,
  OAuthAuthorizationServer,
  OAuthResourceServer,
} from '@cloudflare/workers-oauth-provider';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

export interface Env {
  OAUTH_KV: KVNamespace;
}

/** What /authorize stores with the grant; encrypted by the provider, handed back as ctx.props. */
export interface GrantProps {
  userId: string;
  projectSlug: string;
  grantId: string;
}

const SCOPES = ['mcp:read', 'offline_access'];

/**
 * Projects are dynamic in relic-bridge (created in the admin panel), but the provider fixes `resources`
 * at construction. The spike therefore builds the servers per request from the current project list —
 * the provider keeps all state in KV, so instances are cheap and interchangeable.
 */
const projects = new Set<string>(['a', 'b']);

export function addProject(slug: string): void {
  projects.add(slug);
}

function resourceUrl(origin: string, slug: string): string {
  return `${origin}/p/${slug}/mcp`;
}

export interface AppOptions {
  /** CIMD needs the Workers `global_fetch_strictly_public` flag (SSRF protection); off on Node unless shimmed. */
  cimd: boolean;
}

function buildAuthorizationServer(origin: string, options: AppOptions): OAuthAuthorizationServer<Env> {
  return new OAuthAuthorizationServer<Env>({
    issuer: origin,
    resources: [...projects].map((slug) => resourceUrl(origin, slug)),
    scopesSupported: SCOPES,
    clientIdMetadataDocumentEnabled: options.cimd,
    clientRegistrationEndpoint: '/oauth/register',
    accessTokenTTL: 3600,
  });
}

function buildMcpServer(props: GrantProps): McpServer {
  const server = new McpServer({ name: 'relic-bridge-spike', version: '0.0.0' });
  server.registerTool(
    'echo',
    {
      description: 'Echo a message, with the project and grant the token is bound to.',
      inputSchema: z.object({ message: z.string().max(200) }),
      annotations: { readOnlyHint: true },
    },
    async ({ message }) => ({
      content: [
        { type: 'text', text: JSON.stringify({ message, project: props.projectSlug, grant: props.grantId }) },
      ],
    }),
  );
  return server;
}

function buildResourceServer(
  origin: string,
  slug: string,
  as: OAuthAuthorizationServer<Env>,
): OAuthResourceServer<Env, GrantProps> {
  return new OAuthResourceServer<Env, GrantProps>({
    resourceMetadata: { resource: resourceUrl(origin, slug), authorization_servers: [origin] },
    requiredScopes: ['mcp:read'],
    validateToken: (env) => (resource, token) => as.validateToken(resource, token, env),
    handler: {
      async fetch(request, _env, ctx) {
        // Defence in depth: the provider already rejected tokens whose audience isn't this resource.
        if (ctx.props.projectSlug !== slug) return new Response('grant/project mismatch', { status: 403 });
        const mcp = createMcpHandler(() => buildMcpServer(ctx.props), { legacy: 'stateless' });
        return mcp.fetch(request, {
          authInfo: { token: ctx.auth.token, clientId: ctx.auth.clientId ?? '', scopes: ctx.auth.scope },
        });
      },
    },
  });
}

/** Fake consent: auto-approves and binds the grant to the project named by the RFC 8707 `resource`. */
async function authorize(request: Request, env: Env, as: OAuthAuthorizationServer<Env>): Promise<Response> {
  const oauth = as.getOAuthApi(env);
  let authRequest: AuthRequest;
  try {
    authRequest = await oauth.parseAuthRequest(request);
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
    return new Response(`authorization error: ${error.description ?? error.code}`, { status: 400 });
  }
  const resource = new URL(authRequest.resource ?? '');
  const slug = /^\/p\/([a-z0-9-]+)\/mcp$/.exec(resource.pathname)?.[1];
  if (!slug || !projects.has(slug)) return new Response('unknown project', { status: 400 });
  const userId = 'spike-user';
  const { redirectTo } = await oauth.completeAuthorization({
    request: authRequest,
    userId,
    metadata: { project: slug },
    scope: authRequest.scope.filter((s) => SCOPES.includes(s)),
    props: { userId, projectSlug: slug, grantId: `grant-${slug}-${crypto.randomUUID().slice(0, 8)}` },
  });
  return Response.redirect(redirectTo, 302);
}

/** A CIMD client metadata document (only usable by the provider when served over https — see RESULTS.md). */
function clientMetadataDocument(origin: string): Response {
  const clientId = `${origin}/clients/spike-cli.json`;
  return Response.json(
    {
      client_id: clientId,
      client_name: 'relic-bridge spike CLI',
      redirect_uris: ['http://127.0.0.1:53682/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    { headers: { 'cache-control': 'max-age=60' } },
  );
}

export async function handle(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  options: AppOptions = { cimd: true },
): Promise<Response> {
  const url = new URL(request.url);
  const origin = url.origin;
  const as = buildAuthorizationServer(origin, options);

  if (url.pathname === '/authorize') return authorize(request, env, as);
  if (url.pathname === '/clients/spike-cli.json') return clientMetadataDocument(origin);
  if (url.pathname === '/_spike/projects' && request.method === 'POST') {
    // Spike-only: simulate creating a project at runtime (admin panel). Not present in real code.
    const { slug } = (await request.json()) as { slug: string };
    if (!/^[a-z0-9-]{1,32}$/.test(slug)) return new Response('bad slug', { status: 400 });
    addProject(slug);
    return Response.json({ projects: [...projects] });
  }

  const m = /^(?:\/\.well-known\/oauth-protected-resource)?\/p\/([a-z0-9-]+)\/mcp(?:\/.*)?$/.exec(
    url.pathname,
  );
  if (m?.[1]) {
    // Unknown slug: same 401 shape as a bad token would get (THREAT_MODEL T19) is a follow-up; spike returns 404.
    if (!projects.has(m[1])) return new Response('not found', { status: 404 });
    return buildResourceServer(origin, m[1], as).fetch(request, env, ctx);
  }
  // Discovery (RFC 8414), token, registration (RFC 7591), revocation (RFC 7009).
  return as.fetch(request, env, ctx);
}
