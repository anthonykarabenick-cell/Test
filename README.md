# Morning Email Recap

A daily automated email that recaps **yesterday's inbox, sorted by importance**, and
learns from your feedback over time.

It runs on **Google Apps Script** (no server, no Gmail OAuth setup) and uses the
**Anthropic API** to rank and summarize. An **iOS Shortcut** fires it each morning,
with a built-in time trigger as a backup so a recap never silently goes missing.

```
7:00am  iOS Shortcut (or built-in trigger) fires
   │  hits the Apps Script web-app URL with a secret token
   ▼
Apps Script
   1. reads yesterday's emails (GmailApp)
   2. loads your IMPORTANCE_RULES + FEEDBACK_LOG
   3. sends emails + rules to the Anthropic API
   4. gets back a ranked recap
   5. emails (or drafts) the recap to you
```

## Files

| File              | What it is                                                        |
|-------------------|------------------------------------------------------------------|
| `Code.gs`         | The full Apps Script. Paste into your project.                   |
| `appsscript.json` | The project manifest (timezone + OAuth scopes). Optional.        |

## What you'll need

| Item                 | Cost          | Notes                                            |
|----------------------|---------------|--------------------------------------------------|
| Google account       | free          | Apps Script runs inside it — no OAuth setup.     |
| Anthropic API key    | ~pennies/day  | From console.anthropic.com. Billed by usage.     |
| iPhone Shortcuts app | free          | Pre-installed.                                    |

> The Anthropic API key is **separate** from a Claude subscription and is billed by use.

---

## Setup — step by step

### 1. Get your Anthropic API key
Create one at **console.anthropic.com** (Settings → API Keys). Copy it (`sk-ant-...`).

### 2. Create the Apps Script project
1. Go to **script.google.com → New project**.
2. Delete the starter code, paste in **`Code.gs`**.
3. (Optional) Set the project timezone: **Project Settings → Time zone**. The recap
   uses this timezone to decide what "yesterday" means and when 7am is.

### 3. Store your secrets (not in the code)
In the editor, run **`setup`** once (select `setup` in the function dropdown → **Run**).
The first run will ask you to authorize Gmail access — approve it.

Then open **View → Logs**. You'll see a generated `SHARED_SECRET` — copy it, you'll
need it for the Shortcut.

Now store your API key. In the function dropdown pick **`setApiKey`**… or simplest:
temporarily add a one-line call, run it, then delete the line:

```js
function tmp() { setApiKey('sk-ant-YOUR-KEY-HERE'); }
```

Run `tmp`, confirm the log says "ANTHROPIC_API_KEY stored", then delete `tmp`.

> Secrets live in **Project Settings → Script Properties** (`ANTHROPIC_API_KEY`,
> `SHARED_SECRET`). You can view/edit them there too.

### 4. Customize the config (top of `Code.gs`)
- `DRAFT_ONLY` — leave `true` for the first week (creates a draft you review).
- `VIP_SENDERS` — your always-🔴 people, e.g. `['boss@co.com', 'Jane Doe']`.
- `ALWAYS_SKIP` — senders/topics to force to ⚪, e.g. `['noreply@', 'newsletter']`.
- `RECIPIENT` — leave `''` to send to yourself.
- `MODEL` — `claude-opus-4-8` (default), or `claude-sonnet-4-6` / `claude-haiku-4-5`
  to spend less.

### 5. Test it
Run **`runDailyRecap`**. Check your Gmail — you should see a **draft** recap of
yesterday's mail. Tune `VIP_SENDERS` / `ALWAYS_SKIP` / the rules until it looks right.

### 6. Deploy as a web app (gives the Shortcut a URL)
1. **Deploy → New deployment → Web app**.
2. **Execute as:** Me. **Who has access:** Anyone.
   (The `SHARED_SECRET` token is what actually protects it — see below.)
3. Copy the **Web app URL**.

Your endpoint is:
```
<WEB_APP_URL>?token=<SHARED_SECRET>&action=recap
```

### 7. Build the iOS Shortcut + 7am automation
1. **Shortcuts app → new Shortcut → add "Get Contents of URL".**
2. Paste the endpoint URL above (with your token).
3. (Optional) add "Show Notification" with the response so you see success/errors.
4. **Automation tab → Personal Automation → Time of Day → 7:00 AM, Daily.**
   Run the Shortcut. Turn **off** "Ask Before Running".

### 8. (Recommended) Add the built-in backup trigger
Run **`createTimeTrigger`** once. This adds a server-side 7am daily trigger that runs
even if your phone is off — so you get a recap regardless of the Shortcut.

> Running both is fine, but you'll get two recaps. Options: use only the built-in
> trigger; or skip step 8 and rely on the Shortcut; or set the built-in trigger to a
> later hour as a safety net.

### 9. Run draft-only for ~1 week, then flip to auto-send
Give feedback as you go (below). When the rankings feel trustworthy, set
`DRAFT_ONLY = false` and re-deploy (**Deploy → Manage deployments → Edit → New version**).

---

## The "learning over time" loop

Two pieces of saved state live in Script Properties:

- **`IMPORTANCE_RULES`** — your definition of what matters. Seeded with a sensible
  default; edit with `setRules('...')` or directly in Script Properties.
- **`FEEDBACK_LOG`** — a running list of your corrections, included in every recap.

Add feedback any time, two ways:

**From the editor:**
```js
logFeedback('Missed the invoice from Acme — always flag billing from @acme.com');
logFeedback('Stop flagging the Stratechery newsletter as important');
```

**From anywhere (phone, browser):**
```
<WEB_APP_URL>?token=<SHARED_SECRET>&action=feedback&note=Flag+anything+from+my+lawyer
```

The next recap reflects it. Over time the rules sharpen and the miss rate drops.

> No system guarantees zero misses on day one — that's what draft-only mode and the
> feedback loop are for.

---

## Notes & tuning

- **Cost:** one short call per day. `MAX_MESSAGES` (default 80) and `SNIPPET_CHARS`
  (default 400) cap how much inbox content is sent, which caps token use. Lower them,
  or switch `MODEL` to Sonnet/Haiku, to spend less.
- **Quality:** the script uses adaptive thinking at `medium` effort — a good balance
  for triage judgment. Bump `output_config.effort` to `high` in `callAnthropic_` if
  you want more careful ranking, or `low` to save tokens.
- **Privacy:** email content is sent to the Anthropic API to produce the recap. The
  script sends sender, subject, time, and a truncated body preview per message.
- **Re-deploy after code/config edits:** changing `Code.gs` or config requires
  **Manage deployments → Edit → New version** for the web-app URL to pick it up.
  (The built-in time trigger always runs the latest code.)
