const DEFAULT_API_BASE = 'https://space.ai-builders.com/backend';

const normalizeBasePath = (pathname: string) => pathname.replace(/\/$/, '');

export async function onRequest({ request, env }: { request: Request; env: Record<string, string> }) {
  try {
    const apiBase =
      env.AI_BUILDER_BASE_URL || env.VITE_AI_BUILDER_BASE_URL || DEFAULT_API_BASE;
    const apiToken = env.AI_BUILDER_TOKEN || env.VITE_AI_BUILDER_TOKEN;

    const incomingUrl = new URL(request.url);
    const targetUrl = new URL(apiBase);
    const basePath = normalizeBasePath(targetUrl.pathname);
    const strippedPath = incomingUrl.pathname.replace(/^\/api/, '');
    targetUrl.pathname = `${basePath}${strippedPath}`;
    targetUrl.search = incomingUrl.search;

    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('connection');
    if (apiToken) {
      headers.set('authorization', `Bearer ${apiToken}`);
    }

    const method = request.method.toUpperCase();
    const body = method === 'GET' || method === 'HEAD' ? undefined : request.body;
    const upstream = await fetch(targetUrl.toString(), {
      method,
      headers,
      body,
    });

    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete('transfer-encoding');

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error('Proxy error', error);
    return new Response(
      JSON.stringify({ error: 'proxy_error', message: 'Failed to reach backend' }),
      {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }
}
