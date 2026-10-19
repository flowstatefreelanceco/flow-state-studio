// Sends the "you're posting tomorrow" and "today's the day" reminder emails
// from the server, once a day, so nobody has to open the Studio for them to go.
//
// Vercel runs this on the schedule in vercel.json (13:00 UTC, which is 9am
// Eastern in summer and 8am in winter). For every Studio user it looks at
// content cards with the reminder switched on:
//   - a card dated TOMORROW gets the heads up email
//   - a card dated TODAY gets the post day email
// and hands each email to the existing hyper-action function (the one that
// already talks to Brevo), so no new email service is needed.
//
// Needs in Vercel:
//   SUPABASE_SERVICE_ROLE_KEY  (already set for /api/generate)
//   CRON_SECRET                (any long random string you make up; Vercel
//                               sends it with each scheduled run)

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cucxwgmsatzlsgzhwghy.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN1Y3h3Z21zYXR6bHNnemh3Z2h5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyODI2MjIsImV4cCI6MjA5NDg1ODYyMn0.X1wOXn8gWN5teYBqU2QIw8K1tW4EgAJSVjrM00vBmHA';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EDGE_URL = SUPABASE_URL + '/functions/v1/hyper-action';

export const config = { maxDuration: 60 };

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

function dayString(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

function buildEmail(kind, idea, firstName) {
  const platform = idea.platform ? cap(idea.platform) : 'your platform';
  const caption = idea.ownContent || idea.notes || '';
  const snip = caption.length > 200 ? caption.slice(0, 200) + '...' : caption;
  const box = (color) => snip
    ? '<div style="background:#F5EFE3;border-left:3px solid ' + color + ';padding:14px 16px;border-radius:6px;margin:16px 0;font-size:13px;line-height:1.7;color:#4A3728">' + esc(snip).replace(/\n/g, '<br>') + '</div>'
    : '';
  if (kind === 'before') {
    return {
      subject: "Heads up, you're posting tomorrow on " + platform + ' 📅',
      htmlContent: '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#2A1A0E">'
        + '<div style="font-size:22px;font-weight:700;margin-bottom:6px">Flow State Studio ✦</div>'
        + '<div style="font-size:15px;color:#7A6555;margin-bottom:20px">Your content reminder</div>'
        + '<p>Hey ' + esc(firstName) + ',</p>'
        + '<p>Just a heads up that you planned to post <strong>' + esc(idea.title) + '</strong> tomorrow on <strong>' + esc(platform) + '</strong>.</p>'
        + box('#B5512A')
        + '<p>Head to the Studio to review your content and get ready to post.</p>'
        + '<a href="https://flowstatestudio.co" style="display:inline-block;background:#B5512A;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:8px">Open Flow State Studio →</a>'
        + '<p style="font-size:11px;color:#9A8A7A;margin-top:24px">You set this reminder in Flow State Studio. Reply to this email if you have any questions.</p>'
        + '</div>'
    };
  }
  return {
    subject: "Today's the day, time to post on " + platform + ' 🚀',
    htmlContent: '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#2A1A0E">'
      + '<div style="font-size:22px;font-weight:700;margin-bottom:6px">Flow State Studio ✦</div>'
      + '<div style="font-size:15px;color:#7A6555;margin-bottom:20px">Post day reminder</div>'
      + '<p>Hey ' + esc(firstName) + ',</p>'
      + "<p>Today is the day you planned to post <strong>" + esc(idea.title) + '</strong> on <strong>' + esc(platform) + "</strong>. You've got this.</p>"
      + box('#3A8C8C')
      + '<a href="https://flowstatestudio.co" style="display:inline-block;background:#3A8C8C;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:8px">Open Flow State Studio →</a>'
      + '<p style="font-size:11px;color:#9A8A7A;margin-top:24px">You set this reminder in Flow State Studio.</p>'
      + '</div>'
  };
}

async function sbGet(path) {
  const r = await fetch(SUPABASE_URL + path, {
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
  });
  if (!r.ok) throw new Error(path + ' ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 200));
  return r.json();
}

async function sendEmail(to, toName, mail) {
  // The scheduledAt a minute from now keeps the same request shape the
  // Studio itself has always used with hyper-action.
  const r = await fetch(EDGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SUPABASE_ANON_KEY },
    body: JSON.stringify({
      to, toName, subject: mail.subject, htmlContent: mail.htmlContent,
      scheduledAt: new Date(Date.now() + 90 * 1000).toISOString()
    })
  });
  if (!r.ok) throw new Error('hyper-action ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 200));
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(500).json({ error: 'CRON_SECRET is not set in Vercel' });
  if (req.headers.authorization !== 'Bearer ' + secret) return res.status(401).json({ error: 'Unauthorized' });
  if (!SERVICE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not set in Vercel' });

  const today = dayString(0);
  const tomorrow = dayString(1);
  const summary = { today, tomorrow, users: 0, sent: 0, failed: 0, errors: [] };

  try {
    const PAGE = 100;
    for (let from = 0; ; from += PAGE) {
      const rows = await sbGet('/rest/v1/user_data?select=user_id,data&order=user_id&limit=' + PAGE + '&offset=' + from);
      if (!rows.length) break;
      for (const row of rows) {
        let data = row.data;
        if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { continue; } }
        const ideas = (data && Array.isArray(data.ideas)) ? data.ideas : [];
        const due = [];
        for (const i of ideas) {
          if (!i || !i.reminder || !i.date || i.status === 'published') continue;
          if (i.date === tomorrow) due.push(['before', i]);
          else if (i.date === today) due.push(['day', i]);
        }
        if (!due.length) continue;
        summary.users++;
        let user;
        try { user = await sbGet('/auth/v1/admin/users/' + row.user_id); } catch (e) { summary.errors.push('user ' + row.user_id + ': ' + e.message); continue; }
        if (!user || !user.email) continue;
        const firstName = (user.user_metadata && user.user_metadata.first_name) || 'there';
        for (const [kind, idea] of due) {
          try { await sendEmail(user.email, firstName, buildEmail(kind, idea, firstName)); summary.sent++; }
          catch (e) { summary.failed++; summary.errors.push(e.message); }
        }
      }
      if (rows.length < PAGE) break;
    }
  } catch (e) {
    summary.errors.push(e.message);
    return res.status(500).json(summary);
  }
  return res.status(200).json(summary);
}
