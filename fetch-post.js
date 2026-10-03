// /api/fetch-post
// Reads a post from a link so the Studio's "Rebuild in my voice" tool does
// not need every slide typed in by hand.
//
// Two actions, both POST, both need a signed-in Studio user:
//   { url }                      -> finds the post. Instagram links go to
//                                   Apify, every other link is read directly.
//   { action:'read', images:[] } -> reads the words off Instagram slide images.
//
// Keys live in Vercel environment variables, never in index.html:
//   APIFY_TOKEN        (new, from apify.com)
//   ANTHROPIC_API_KEY  (already set, same one /api/generate uses)

export const config = { maxDuration: 60 };

const SUPABASE_URL = 'https://cucxwgmsatzlsgzhwghy.supabase.co';
const APIFY_ACTOR = 'apify~instagram-scraper';
const VISION_MODEL = 'claude-sonnet-5';
const MAX_SLIDES = 20;
const MAX_PAGE_BYTES = 1500000;
const MAX_TEXT_CHARS = 12000;
const MAX_IMAGE_BYTES = 4500000;

const IG_HOST = /(^|\.)instagram\.com$/i;
const IG_CDN = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;

function send(res, status, body) { return res.status(status).json(body); }
function fail(res, status, code, message) { return send(res, status, { error: { code: code, message: message } }); }

function timedFetch(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, Object.assign({}, options, { signal: controller.signal })).finally(() => clearTimeout(timer));
}

// Only real, public web addresses. Blocks localhost, private network ranges
// and bare IPs so this can never be pointed at something internal.
function isPublicHost(host) {
  host = String(host || '').toLowerCase();
  if (!host || host.indexOf('.') === -1) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (/^[0-9.]+$/.test(host)) return false;      // IPv4 literal
  if (host.indexOf(':') > -1 || host.startsWith('[')) return false; // IPv6 literal
  return true;
}
function parsePublicUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (e) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!isPublicHost(u.hostname)) return null;
  return u;
}

async function isSignedIn(req) {
  const auth = req.headers.authorization || '';
  const apikey = req.headers.apikey || '';
  if (!auth.startsWith('Bearer ') || !apikey) return false;
  try {
    const r = await timedFetch(SUPABASE_URL + '/auth/v1/user', { headers: { Authorization: auth, apikey: apikey } }, 8000);
    if (!r.ok) return false;
    const u = await r.json();
    return !!(u && u.id);
  } catch (e) { return false; }
}

/* ---------- Instagram ---------- */
function instagramShortcode(u) {
  const m = u.pathname.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : '';
}
async function fetchInstagram(u) {
  const code = instagramShortcode(u);
  if (!code) return { status: 400, code: 'not_a_post', message: 'That Instagram link is not a post. Open the post, tap the three dots, tap Copy link, and paste that.' };
  const token = (process.env.APIFY_TOKEN || '').trim();
  if (!token) return { status: 500, code: 'not_set_up', message: 'Instagram links are not set up yet. APIFY_TOKEN is missing in Vercel.' };
  const postUrl = 'https://www.instagram.com/p/' + code + '/';
  let r;
  try {
    r = await timedFetch('https://api.apify.com/v2/acts/' + APIFY_ACTOR + '/run-sync-get-dataset-items?timeout=45&limit=1&clean=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ directUrls: [postUrl], resultsType: 'posts', resultsLimit: 1, addParentData: false })
    }, 50000);
  } catch (e) {
    return { status: 504, code: 'slow', message: 'Instagram took too long to answer. Try again in a minute, or paste the words in the box.' };
  }
  if (r.status === 401 || r.status === 403) return { status: 500, code: 'not_set_up', message: 'The Apify token was rejected. Check APIFY_TOKEN in Vercel.' };
  if (r.status === 402) return { status: 500, code: 'no_balance', message: 'The Apify account is out of credit.' };
  if (!r.ok) return { status: 502, code: 'blocked', message: 'Instagram did not hand over that post. Paste the words in the box instead.' };
  const items = await r.json().catch(() => []);
  const post = Array.isArray(items) ? items[0] : null;
  if (!post || post.error || (!post.caption && !post.displayUrl && !(post.childPosts || []).length)) {
    return { status: 404, code: 'not_found', message: 'Could not read that post. It may be private, deleted, or from an account that blocks this. Paste the words in the box instead.' };
  }
  const isVideo = post.type === 'Video';
  let slides = [];
  if (!isVideo) {
    const kids = Array.isArray(post.childPosts) ? post.childPosts : [];
    if (kids.length) slides = kids.map(k => k && k.displayUrl).filter(Boolean);
    else if (Array.isArray(post.images) && post.images.length) slides = post.images.slice();
    else if (post.displayUrl) slides = [post.displayUrl];
  }
  slides = slides.filter(s => { const su = parsePublicUrl(s); return su && su.protocol === 'https:' && IG_CDN.test(su.hostname); }).slice(0, MAX_SLIDES);
  return {
    status: 200,
    body: {
      kind: 'instagram',
      author: post.ownerUsername || '',
      caption: String(post.caption || '').slice(0, MAX_TEXT_CHARS),
      isVideo: isVideo,
      slides: slides
    }
  };
}

/* ---------- Any other web page ---------- */
function decodeEntities(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&rsquo;|&lsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;|&ndash;/g, ', ').replace(/&hellip;/g, '...')
    .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(parseInt(n, 10)); } catch (e) { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch (e) { return ''; } });
}
function metaContent(html, key) {
  const re = new RegExp('<meta[^>]+(?:property|name)=["\']' + key + '["\'][^>]*>', 'i');
  const tag = (html.match(re) || [])[0] || '';
  const c = tag.match(/content=(?:"([^"]*)"|'([^']*)')/i);
  return c ? decodeEntities(c[1] || c[2] || '').trim() : '';
}
function htmlToText(html) {
  let h = html.replace(/<!--[\s\S]*?-->/g, ' ');
  h = h.replace(/<(script|style|noscript|svg|nav|header|footer|form|aside|iframe|template)\b[\s\S]*?<\/\1>/gi, ' ');
  const article = h.match(/<article\b[\s\S]*<\/article>/i) || h.match(/<main\b[\s\S]*<\/main>/i) || h.match(/<body\b[\s\S]*<\/body>/i);
  if (article) h = article[0];
  h = h.replace(/<\/(p|div|h[1-6]|li|blockquote|section|tr)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<li\b[^>]*>/gi, '- ');
  h = h.replace(/<[^>]+>/g, ' ');
  return decodeEntities(h).replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
async function fetchPage(u) {
  let r;
  try {
    r = await timedFetch(u.toString(), {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FlowStateStudio/1.0; +https://flowstatestudio.co)', Accept: 'text/html,text/plain' }
    }, 12000);
  } catch (e) {
    return { status: 504, code: 'slow', message: 'That page took too long to load. Paste the words in the box instead.' };
  }
  // A redirect must not land somewhere private either.
  const finalUrl = parsePublicUrl(r.url || u.toString());
  if (!finalUrl) return { status: 400, code: 'bad_link', message: 'That link cannot be read.' };
  if (!r.ok) return { status: 502, code: 'blocked', message: 'That page would not open (it may need a login). Paste the words in the box instead.' };
  const type = (r.headers.get('content-type') || '').toLowerCase();
  if (type.indexOf('text/html') === -1 && type.indexOf('text/plain') === -1) {
    return { status: 415, code: 'not_text', message: 'That link is not a page of text. Paste the words in the box instead.' };
  }
  const buf = Buffer.from(await r.arrayBuffer());
  const raw = buf.slice(0, MAX_PAGE_BYTES).toString('utf8');
  const title = metaContent(raw, 'og:title') || decodeEntities(((raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '')).trim();
  let text = type.indexOf('text/plain') > -1 ? raw.trim() : htmlToText(raw);
  if (text.length < 200) {
    const desc = metaContent(raw, 'og:description') || metaContent(raw, 'description');
    if (desc.length > text.length) text = desc;
  }
  if (text.length < 40) return { status: 422, code: 'empty', message: 'There were no readable words on that page (it may need a login). Paste the words in the box instead.' };
  return { status: 200, body: { kind: 'page', title: title.slice(0, 200), text: text.slice(0, MAX_TEXT_CHARS) } };
}

/* ---------- Read the words off slide images ---------- */
async function readSlides(images) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) return { status: 500, code: 'not_set_up', message: 'ANTHROPIC_API_KEY is not set in Vercel.' };
  const urls = (Array.isArray(images) ? images : []).map(parsePublicUrl)
    .filter(su => su && su.protocol === 'https:' && IG_CDN.test(su.hostname)).slice(0, MAX_SLIDES);
  if (!urls.length) return { status: 400, code: 'no_slides', message: 'There were no slides to read.' };
  const loaded = await Promise.all(urls.map(async su => {
    try {
      const r = await timedFetch(su.toString(), {}, 12000);
      if (!r.ok) return null;
      const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (['image/jpeg', 'image/png', 'image/webp', 'image/gif'].indexOf(type) === -1) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
      return { type: type, data: buf.toString('base64') };
    } catch (e) { return null; }
  }));
  const content = [];
  let n = 0;
  loaded.forEach((img, i) => {
    if (!img) return;
    n++;
    content.push({ type: 'text', text: 'Slide ' + (i + 1) + ':' });
    content.push({ type: 'image', source: { type: 'base64', media_type: img.type, data: img.data } });
  });
  if (!n) return { status: 502, code: 'blocked', message: 'The slide images would not load.' };
  content.push({ type: 'text', text: 'Copy out the words written on each slide, exactly as they are written. One line per slide, in order, in this shape: "Slide 1: the words". Join the words on a slide into one line. If a slide has no words, write "Slide N: (no words)". Do not describe the pictures. Do not add anything of your own.' });
  let r;
  try {
    r = await timedFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: VISION_MODEL, max_tokens: 3000, messages: [{ role: 'user', content: content }] })
    }, 50000);
  } catch (e) {
    return { status: 504, code: 'slow', message: 'Reading the slides took too long.' };
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { status: 502, code: 'ai_error', message: (data && data.error && data.error.message) || 'The slides could not be read.' };
  const text = (data.content || []).filter(c => c && c.type === 'text').map(c => c.text).join('').trim();
  if (!text) return { status: 502, code: 'ai_error', message: 'The slides could not be read.' };
  return { status: 200, body: { kind: 'slides', text: text.slice(0, MAX_TEXT_CHARS), read: n, total: urls.length } };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return fail(res, 405, 'method', 'Method not allowed');
  try {
    if (!(await isSignedIn(req))) return fail(res, 401, 'signed_out', 'Your session expired. Refresh the page and log back in.');
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    let out;
    if (body.action === 'read') {
      out = await readSlides(body.images);
    } else {
      const u = parsePublicUrl(body.url);
      if (!u) return fail(res, 400, 'bad_link', 'That does not look like a link. It should start with https://');
      out = IG_HOST.test(u.hostname) ? await fetchInstagram(u) : await fetchPage(u);
    }
    if (out.status === 200) return send(res, 200, out.body);
    return fail(res, out.status, out.code, out.message);
  } catch (err) {
    return fail(res, 500, 'server', 'Something went wrong reading that link.');
  }
}
