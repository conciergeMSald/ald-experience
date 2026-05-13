/**
 * ALD — Cloudflare Worker
 * Secure proxy between the ALD website and Anthropic API.
 * Your API key lives here as an environment secret — never in the browser.
 *
 * DEPLOY STEPS:
 * 1. dash.cloudflare.com → Workers & Pages → Workers → Create Worker
 * 2. Name it: ald-agent
 * 3. Click Edit Code → delete everything → paste this entire file
 * 4. Click Deploy
 * 5. Go to Settings → Variables and Secrets → Add Secret
 *    Name:  ANTHROPIC_API_KEY
 *    Value: your sk-ant-... key from console.anthropic.com
 * 6. Save — your Worker URL is now live
 * 7. Copy the Worker URL (e.g. https://ald-agent.yourname.workers.dev)
 * 8. Paste it into index_v3.html where it says YOUR_WORKER_URL
 * 9. Re-upload index_v3.html to Cloudflare Pages
 *
 * POST-LAUNCH: tighten ALLOWED_ORIGIN to your real domain (see below)
 */

export default {
  async fetch(request, env) {

    // After launch, replace * with your real domain:
    // const ALLOWED_ORIGIN = 'https://aestheticleadersdinner.com';
    const ALLOWED_ORIGIN = '*';

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    // Only accept POST to /api/chat
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/api/chat') {
      return new Response('Not found.', { status: 404 });
    }

    // Parse request body
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('Bad request.', { status: 400 });
    }

    const { messages, system } = body;

    if (!messages || !Array.isArray(messages)) {
      return new Response('Invalid payload.', { status: 400 });
    }

    // Forward to Anthropic — API key stays server-side
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: system || '',
        messages: messages,
      }),
    });

    const data = await anthropicRes.json();

    return new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      },
    });
  }
};
