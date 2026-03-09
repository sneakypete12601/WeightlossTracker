/**
 * Fitbit API CORS Proxy — Cloudflare Worker
 *
 * Deploy this to Cloudflare Workers (free tier: 100,000 req/day).
 * Paste the worker URL into Profile → Fitbit Integration → "CORS Proxy URL".
 *
 * SETUP (5 minutes):
 *  1. Go to https://workers.cloudflare.com → sign up free → "Create a Worker"
 *  2. Replace the default code with the contents of this file
 *  3. Click "Save and Deploy"
 *  4. Copy the worker URL (e.g. https://your-worker.workers.dev)
 *  5. Paste it into the app: Profile → Fitbit Integration → CORS Proxy URL → Save Profile
 *
 * HOW IT WORKS:
 *  The browser cannot call api.fitbit.com directly because Fitbit's data endpoints
 *  don't allow CORS preflight from browser origins. This worker sits in between:
 *    Browser → Worker (adds CORS headers) → api.fitbit.com → Worker → Browser
 *
 * SECURITY:
 *  Your Fitbit access token travels in the Authorization header just as it would
 *  in a direct call. The worker doesn't log or store tokens — it only forwards
 *  the request and adds Access-Control headers to the response.
 */

export default {
  async fetch(request) {
    // Handle CORS preflight (OPTIONS)
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    // Forward everything under this worker's origin to api.fitbit.com
    const fitbitUrl = 'https://api.fitbit.com' + url.pathname + url.search;

    let fitbitResponse;
    try {
      fitbitResponse = await fetch(fitbitUrl, {
        method:  request.method,
        headers: request.headers,
        body:    ['POST', 'PUT', 'PATCH'].includes(request.method) ? request.body : undefined,
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status:  502,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }

    // Copy Fitbit's response, adding CORS headers so the browser accepts it
    const responseHeaders = new Headers(fitbitResponse.headers);
    Object.entries(corsHeaders()).forEach(([k, v]) => responseHeaders.set(k, v));

    return new Response(fitbitResponse.body, {
      status:     fitbitResponse.status,
      statusText: fitbitResponse.statusText,
      headers:    responseHeaders,
    });
  },
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}
