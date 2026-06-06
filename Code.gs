/**
 * Morning Email Recap — Google Apps Script backend
 * ------------------------------------------------------------
 * A daily email that recaps yesterday's inbox, sorted by importance,
 * and learns from your feedback over time.
 *
 * Flow each morning:
 *   trigger (iOS Shortcut or built-in time trigger)
 *     -> reads yesterday's emails (GmailApp)
 *     -> loads your saved IMPORTANCE_RULES + FEEDBACK_LOG
 *     -> sends them to the Anthropic API
 *     -> gets back a ranked recap
 *     -> emails (or drafts) the recap to you
 *
 * SECRETS live in Script Properties, never in this file:
 *   ANTHROPIC_API_KEY  - your key from console.anthropic.com
 *   SHARED_SECRET      - a random token the Shortcut must send
 *
 * First-time setup: run setup() once from the editor, then read the
 * Logs for the values to paste into Script Properties. See README.md.
 */

// ============================================================
//  CONFIG — edit these to fit your life
// ============================================================

/** Anthropic model. Opus is most capable; swap for a cheaper model if you like:
 *   "claude-opus-4-8"   - most capable (default)
 *   "claude-sonnet-4-6" - cheaper, very good
 *   "claude-haiku-4-5"  - cheapest, fastest
 */
var MODEL = 'claude-opus-4-8';

/** Where to send the recap. Leave '' to use the account you're signed in as. */
var RECIPIENT = '';

/** Start in draft-only mode for ~1 week so you can sanity-check before trusting it.
 *  true  = creates a Gmail draft (you review/send manually)
 *  false = sends the email automatically
 */
var DRAFT_ONLY = true;

/** Always-🔴 senders. Email addresses or names. Matched case-insensitively as substrings.
 *  e.g. ['boss@company.com', 'Jane Doe', '@keyclient.com']
 */
var VIP_SENDERS = [];

/** Senders/topics to always push down to "skip". Substrings of sender or subject.
 *  e.g. ['noreply@', 'newsletter', 'promotions@', 'notifications@']
 */
var ALWAYS_SKIP = [];

/** Cap how many of yesterday's messages we send to the API (controls cost/latency). */
var MAX_MESSAGES = 80;

/** Max characters of each email body we include (keeps token use sane). */
var SNIPPET_CHARS = 400;

// ============================================================
//  WEB APP ENTRY POINT (called by the iOS Shortcut)
// ============================================================

/**
 * Deployed as a web app. The Shortcut calls:
 *   <web-app-url>?token=<SHARED_SECRET>&action=recap
 * To log feedback from anywhere:
 *   <web-app-url>?token=<SHARED_SECRET>&action=feedback&note=<your+note>
 */
function doGet(e) {
  var params = (e && e.parameter) || {};
  var expected = props().getProperty('SHARED_SECRET');

  if (!expected || params.token !== expected) {
    return text_('Unauthorized', 401);
  }

  try {
    if (params.action === 'feedback') {
      var note = params.note || '';
      if (!note) return text_('Missing "note" parameter.', 400);
      logFeedback(note);
      return text_('Feedback saved: ' + note);
    }
    // default action: run the recap
    var result = runDailyRecap();
    return text_(result);
  } catch (err) {
    return text_('Error: ' + (err && err.message ? err.message : err), 500);
  }
}

// ============================================================
//  MAIN
// ============================================================

/** Build and send (or draft) the recap for yesterday. Returns a status string. */
function runDailyRecap() {
  var apiKey = props().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set in Script Properties. Run setup().');

  var recipient = RECIPIENT || Session.getActiveUser().getEmail();
  if (!recipient) throw new Error('Could not determine a recipient. Set RECIPIENT in the config.');

  var range = yesterdayRange_();
  var messages = getMessagesInRange_(range.start, range.end);
  var subject = '☀️ Your Morning Recap — ' + formatHuman_(range.start);

  if (messages.length === 0) {
    var emptyHtml = '<p>Good morning. Nothing landed in your inbox yesterday — enjoy the quiet. ☀️</p>';
    deliver_(recipient, subject, emptyHtml);
    return 'No emails yesterday. ' + (DRAFT_ONLY ? 'Draft created.' : 'Recap sent.');
  }

  var recapHtml = callAnthropic_(apiKey, messages);
  deliver_(recipient, subject, recapHtml);

  return (DRAFT_ONLY ? 'Draft created' : 'Recap sent') +
         ' for ' + messages.length + ' message(s) to ' + recipient + '.';
}

// ============================================================
//  GMAIL
// ============================================================

/** Returns {start, end} Date objects bounding "yesterday" in the script's timezone. */
function yesterdayRange_() {
  var tz = Session.getScriptTimeZone();
  var now = new Date();
  // Midnight today, in the script timezone, then step back one day.
  var todayStr = Utilities.formatDate(now, tz, 'yyyy/MM/dd');
  var todayMidnight = new Date(todayStr + ' 00:00:00');
  var start = new Date(todayMidnight.getTime() - 24 * 60 * 60 * 1000);
  return { start: start, end: todayMidnight };
}

/** Search Gmail for messages received in [start, end) and return a normalized list. */
function getMessagesInRange_(start, end) {
  var tz = Session.getScriptTimeZone();
  var afterStr = Utilities.formatDate(start, tz, 'yyyy/MM/dd');
  var beforeStr = Utilities.formatDate(end, tz, 'yyyy/MM/dd');
  // Gmail's date search is day-granular; we refine by exact timestamp below.
  var query = 'in:inbox after:' + afterStr + ' before:' + beforeStr;

  var threads = GmailApp.search(query, 0, 100);
  var out = [];

  for (var t = 0; t < threads.length && out.length < MAX_MESSAGES; t++) {
    var msgs = threads[t].getMessages();
    for (var m = 0; m < msgs.length && out.length < MAX_MESSAGES; m++) {
      var msg = msgs[m];
      var d = msg.getDate();
      if (d >= start && d < end) {
        out.push({
          from: msg.getFrom(),
          subject: msg.getSubject() || '(no subject)',
          date: Utilities.formatDate(d, tz, 'EEE h:mm a'),
          snippet: cleanSnippet_(msg.getPlainBody())
        });
      }
    }
  }
  return out;
}

/** Collapse whitespace and trim an email body down to a short snippet. */
function cleanSnippet_(body) {
  if (!body) return '';
  var s = body.replace(/\s+/g, ' ').trim();
  return s.length > SNIPPET_CHARS ? s.slice(0, SNIPPET_CHARS) + '…' : s;
}

// ============================================================
//  ANTHROPIC API
// ============================================================

/** Send the messages + rules + feedback to Claude; return the recap as HTML. */
function callAnthropic_(apiKey, messages) {
  var system = buildSystemPrompt_();
  var userContent = buildUserContent_(messages);

  var payload = {
    model: MODEL,
    max_tokens: 4000,
    // Email triage is a judgment task — let the model reason adaptively.
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' }, // low | medium | high | max
    system: system,
    messages: [{ role: 'user', content: userContent }]
  };

  var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  var bodyText = resp.getContentText();
  if (code !== 200) {
    throw new Error('Anthropic API ' + code + ': ' + bodyText);
  }

  var data = JSON.parse(bodyText);
  var html = '';
  (data.content || []).forEach(function (block) {
    if (block.type === 'text') html += block.text;
  });
  html = html.trim();
  if (!html) throw new Error('Anthropic returned no text content.');

  // Strip a stray ```html fence if the model wrapped its output.
  html = html.replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/i, '').trim();
  return html;
}

/** The instructions + your saved rules + your accumulated feedback. */
function buildSystemPrompt_() {
  var rules = getRules_();
  var feedback = props().getProperty('FEEDBACK_LOG') || '(none yet)';

  var vip = VIP_SENDERS.length ? VIP_SENDERS.join(', ') : '(none configured)';
  var skip = ALWAYS_SKIP.length ? ALWAYS_SKIP.join(', ') : '(none configured)';

  return [
    'You are a sharp executive assistant. You receive a list of the emails that',
    'arrived in the user\'s inbox YESTERDAY and produce a single morning recap,',
    'sorted by what needs the user most.',
    '',
    'Sort every email into exactly one of three sections:',
    '  🔴 Needs you / time-sensitive',
    '  🟡 Worth knowing',
    '  ⚪ Skim or skip',
    '',
    'For 🔴 and 🟡 items, write one line each: bold the sender, then a short',
    'plain-language note on what it is and any action/deadline. For ⚪, summarize in',
    'aggregate (e.g. "3 newsletters", "2 promotions") rather than listing each.',
    '',
    'IMPORTANCE RULES (the user\'s definition of what matters):',
    rules,
    '',
    'VIP senders (always 🔴): ' + vip,
    'Always skip (force to ⚪): ' + skip,
    '',
    'FEEDBACK from the user on past recaps (apply these corrections):',
    feedback,
    '',
    'OUTPUT: return ONLY the HTML body of the email — no <html>/<head>/<body>',
    'wrapper, no markdown, no code fences. Use <h3> for the three section headers',
    'and <ul>/<li> for items. Start with a one-line "Good morning" greeting. End with',
    'one italic line inviting the user to reply with anything you missed or mis-ranked.',
    'If a section has no items, omit that section entirely.'
  ].join('\n');
}

/** The data turn: yesterday's emails as a compact, numbered list. */
function buildUserContent_(messages) {
  var lines = ['Here are yesterday\'s ' + messages.length + ' emails:\n'];
  messages.forEach(function (m, i) {
    lines.push(
      (i + 1) + '. From: ' + m.from +
      ' | Received: ' + m.date +
      ' | Subject: ' + m.subject +
      '\n   Preview: ' + m.snippet
    );
  });
  return lines.join('\n');
}

// ============================================================
//  DELIVERY
// ============================================================

/** Send or draft the recap depending on DRAFT_ONLY. */
function deliver_(recipient, subject, html) {
  var plain = htmlToPlain_(html);
  if (DRAFT_ONLY) {
    GmailApp.createDraft(recipient, subject, plain, { htmlBody: html });
  } else {
    GmailApp.sendEmail(recipient, subject, plain, { htmlBody: html });
  }
}

/** Very small HTML-to-plaintext fallback for email clients that ignore htmlBody. */
function htmlToPlain_(html) {
  return html
    .replace(/<\/(h3|li|p|ul)>/gi, '\n')
    .replace(/<li>/gi, ' • ')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ============================================================
//  STATE: importance rules + feedback log
// ============================================================

/** The starting importance rules (from the plan). Stored in Script Properties so
 *  you can tune them without editing code. */
var DEFAULT_RULES = [
  '🔴 Needs you / time-sensitive:',
  '- Direct messages from real people asking a question or requesting action',
  '- Anything with a stated deadline, due date, or "EOD/EOW"',
  '- Money: invoices, failed payments, billing changes, anything financial',
  '- Messages from VIP senders (manager, key clients, family)',
  '- Security alerts, account access, legal',
  '',
  '🟡 Worth knowing:',
  '- FYI updates from people you know, no action needed',
  '- Confirmations (appointments, orders, bookings)',
  '- Replies on threads you\'re part of but not driving',
  '',
  '⚪ Skim or skip:',
  '- Newsletters, digests, marketing, promotions',
  '- Automated notifications (social, app updates)',
  '- Receipts for routine/expected purchases'
].join('\n');

function getRules_() {
  return props().getProperty('IMPORTANCE_RULES') || DEFAULT_RULES;
}

/** Overwrite the importance rules. Call from the editor: setRules('...'). */
function setRules(rulesText) {
  props().setProperty('IMPORTANCE_RULES', rulesText);
  Logger.log('Importance rules updated.');
}

/** Append a line to the feedback log (capped so it never grows unbounded). */
function logFeedback(note) {
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var existing = props().getProperty('FEEDBACK_LOG') || '';
  var updated = (existing + '\n- [' + stamp + '] ' + note).trim();

  // Keep only the most recent ~40 feedback lines.
  var linesArr = updated.split('\n');
  if (linesArr.length > 40) linesArr = linesArr.slice(linesArr.length - 40);
  props().setProperty('FEEDBACK_LOG', linesArr.join('\n'));
  Logger.log('Feedback saved.');
}

// ============================================================
//  SETUP HELPERS
// ============================================================

/**
 * Run this once from the editor. It:
 *   - generates a SHARED_SECRET if you don't have one
 *   - seeds the default importance rules
 *   - reminds you to paste your ANTHROPIC_API_KEY
 * Then read the Logs (View > Logs) for what to do next.
 */
function setup() {
  var p = props();

  if (!p.getProperty('SHARED_SECRET')) {
    p.setProperty('SHARED_SECRET', Utilities.getUuid());
  }
  if (!p.getProperty('IMPORTANCE_RULES')) {
    p.setProperty('IMPORTANCE_RULES', DEFAULT_RULES);
  }

  var hasKey = !!p.getProperty('ANTHROPIC_API_KEY');

  Logger.log('--- Morning Recap setup ---');
  Logger.log('SHARED_SECRET: ' + p.getProperty('SHARED_SECRET'));
  Logger.log('ANTHROPIC_API_KEY set: ' + hasKey);
  if (!hasKey) {
    Logger.log('ACTION: set your key by running setApiKey("sk-ant-...") once, then delete the call.');
  }
  Logger.log('Importance rules seeded. Next: run runDailyRecap() to test.');
}

/** One-time: store your Anthropic API key in Script Properties (then remove the call). */
function setApiKey(key) {
  props().setProperty('ANTHROPIC_API_KEY', key);
  Logger.log('ANTHROPIC_API_KEY stored.');
}

/** Create the built-in 7am backup trigger (server-side, runs even if your phone is off). */
function createTimeTrigger() {
  // Remove any existing triggers for runDailyRecap to avoid duplicates.
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (tr.getHandlerFunction() === 'runDailyRecap') ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('runDailyRecap')
    .timeBased()
    .atHour(7)
    .everyDays(1)
    .create();
  Logger.log('Daily 7am trigger created (in the script timezone).');
}

// ============================================================
//  small utilities
// ============================================================

function props() {
  return PropertiesService.getScriptProperties();
}

function formatHuman_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'EEEE, MMMM d');
}

function text_(message, code) {
  // ContentService can't set HTTP status codes, so we prefix errors instead.
  var prefix = (code && code >= 400) ? '[' + code + '] ' : '';
  return ContentService.createTextOutput(prefix + message)
    .setMimeType(ContentService.MimeType.TEXT);
}
