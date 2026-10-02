// Anthropic proxy for Flow State Studio.
// Only signed-in Studio users can call it, only the approved model runs,
// request size is capped, and credits are checked and charged HERE, on the
// server, against the ai_credits table nobody can edit from the browser.
//
// Needs one environment variable in Vercel besides ANTHROPIC_API_KEY:
//   SUPABASE_SERVICE_ROLE_KEY  (Supabase > Project Settings > API > service_role)

// Supabase project URL and anon key are public by design (they already ship
// in index.html). Env vars win if you ever set them in Vercel.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cucxwgmsatzlsgzhwghy.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN1Y3h3Z21zYXR6bHNnemh3Z2h5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyODI2MjIsImV4cCI6MjA5NDg1ODYyMn0.X1wOXn8gWN5teYBqU2QIw8K1tW4EgAJSVjrM00vBmHA';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ALLOWED_MODELS = ['claude-sonnet-4-5'];
const DEFAULT_MODEL = 'claude-sonnet-4-5';
const MAX_TOKENS_CAP = 3200;      // longest skill (long article)
const MAX_MESSAGES = 100;         // long Director Chat threads
const MAX_SYSTEM_CHARS = 60000;
const MAX_TOTAL_CHARS = 400000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(res, status, message, extra) {
  return res.status(status).json(Object.assign({ error: { message } }, extra || {}));
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

// Calls one of the fss_* database functions as the service role.
async function rpc(name, args) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + name, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY
    },
    body: JSON.stringify(args)
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('credit service ' + name + ' failed: ' + r.status + ' ' + t.slice(0, 200));
  }
  return r.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return fail(res, 500, 'API key not configured');
  if (!SERVICE_KEY) return fail(res, 500, 'Credit service not configured');

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

  // 3. Credits. A valid pass (from a reply that is auto-continuing, or the
  //    library build) rides on the credit already charged for that action.
  //    Anything else is charged one credit up front and refunded on failure.
  let charged = false;
  let usedGrant = null;
  let credit = null;
  try {
    const grant = typeof body.fss_grant === 'string' && UUID_RE.test(body.fss_grant) ? body.fss_grant : null;
    if (grant) {
      const ok = await rpc('fss_use_grant', { p_user: user.id, p_grant: grant });
      if (ok === true) usedGrant = grant;
    }
    if (!usedGrant) {
      const rows = await rpc('fss_consume_credit', { p_user: user.id, p_anchor: user.created_at || null });
      credit = Array.isArray(rows) ? rows[0] : rows;
      if (!credit) throw new Error('credit service returned nothing');
      if (credit.plan === 'locked') {
        return fail(res, 403, 'Your plan is not active right now. Head to Settings to pick one back up', { code: 'locked' });
      }
      if (!credit.ok) {
        return fail(res, 402, 'You have used all your credits for this cycle', {
          code: 'out_of_credits',
          fss: { used: credit.used, limit: credit.credit_limit, cycle_start: credit.cycle_start, unlimited: false }
        });
      }
      charged = !credit.unlimited;
    }
  } catch (e) {
    // Fail closed: never hand out free AI because the credit check broke.
    return fail(res, 503, 'Credits could not be checked right now. Nothing was used, try again in a minute');
  }

  async function refund() {
    if (!charged) return null;
    charged = false;
    try { return await rpc('fss_refund_credit', { p_user: user.id }); } catch (e) { return null; }
  }

  // 4. Forward to Anthropic and pass the full response back (keeps
  //    stop_reason so the Studio can auto-continue cut-off replies)
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
    const text = Array.isArray(data.content)
      ? data.content.filter(c => c && c.type === 'text').map(c => c.text).join('')
      : '';

    if (!response.ok || !text) {
      const after = await refund();
      if (data && typeof data === 'object' && credit && !credit.unlimited && after !== null) {
        data.fss = { used: after, limit: credit.credit_limit, cycle_start: credit.cycle_start, unlimited: false };
      }
      return res.status(response.ok ? 502 : response.status).json(data);
    }

    // Hand back a pass when this action needs more calls on the same credit
    let nextGrant = usedGrant;
    try {
      if (data.stop_reason === 'max_tokens' && !nextGrant) {
        nextGrant = await rpc('fss_create_grant', { p_user: user.id, p_kind: 'continue', p_uses: 2, p_minutes: 5 });
      } else if (body.fss_want_grant === 'library' && !usedGrant) {
        nextGrant = await rpc('fss_create_grant', { p_user: user.id, p_kind: 'library', p_uses: 15, p_minutes: 10 });
      }
    } catch (e) { /* no pass: later calls just get charged normally */ }

    data.fss = credit
      ? { used: credit.unlimited ? 0 : credit.used, limit: credit.credit_limit, cycle_start: credit.cycle_start, unlimited: !!credit.unlimited, charged: !credit.unlimited, grant: nextGrant || null }
      : { charged: false, grant: nextGrant || null };
    return res.status(200).json(data);
  } catch (error) {
    await refund();
    return fail(res, 500, error.message || 'Something went wrong');
  }
}
