// Anthropic proxy for Flow State Studio.
// Only signed-in Studio users can call it, only the approved model runs,
// and request size is capped so nobody can run up the bill.

// Supabase project URL and anon key are public by design (they already ship
// in index.html). Env vars win if you ever set them in Vercel.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cucxwgmsatzlsgzhwghy.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN1Y3h3Z21zYXR6bHNnemh3Z2h5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyODI2MjIsImV4cCI6MjA5NDg1ODYyMn0.X1wOXn8gWN5teYBqU2QIw8K1tW4EgAJSVjrM00vBmHA';

const ALLOWED_MODELS = ['claude-sonnet-4-5'];
const DEFAULT_MODEL = 'claude-sonnet-4-5';
const MAX_TOKENS_CAP = 3200;      // longest skill (long article)
const MAX_MESSAGES = 100;         // long Director Chat threads
const MAX_SYSTEM_CHARS = 60000;
const MAX_TOTAL_CHARS = 400000;

function fail(res, status, message) {
  return res.status(status).json({ error: { message } });
}

async function getUser(token) {
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token }
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u : null;
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return fail(res, 500, 'API key not configured');

  // 1. Must be signed in
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return fail(res, 401, 'Please log in to use AI tools');
  const user = await getUser(token);
  if (!user) return fail(res, 401, 'Your session expired. Refresh the page and log back in');

  // 2. Only accept the fields the Studio actually sends
  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || !messages.length || messages.length > MAX_MESSAGES) {
    return fail(res, 400, 'Invalid request');
  }
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return fail(res, 400, 'Invalid request');
    if (typeof m.content !== 'string' && !Array.isArray(m.content)) return fail(res, 400, 'Invalid request');
  }
  const system = typeof body.system === 'string' ? body.system : undefined;
  if (system && system.length > MAX_SYSTEM_CHARS) return fail(res, 413, 'Request too large');
  if (JSON.stringify(messages).length + (system ? system.length : 0) > MAX_TOTAL_CHARS) {
    return fail(res, 413, 'This is too long to send in one go. Try a new chat or a shorter paste');
  }

  const model = ALLOWED_MODELS.includes(body.model) ? body.model : DEFAULT_MODEL;
  const requested = parseInt(body.max_tokens, 10);
  const max_tokens = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 1000, MAX_TOKENS_CAP);

  const clean = { model, max_tokens, messages };
  if (system) clean.system = system;

  // 3. Forward to Anthropic and pass the full response back (keeps stop_reason
  //    so the Studio can auto-continue cut-off replies)
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(clean)
    });
    const data = await response.json();
    return res.status(response.ok ? 200 : response.status).json(data);
  } catch (error) {
    return fail(res, 500, error.message || 'Something went wrong');
  }
}
