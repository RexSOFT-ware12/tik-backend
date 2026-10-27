# TikTok LIVE AI Host — Render-ready backend and dashboard

This build keeps the existing Perxona `sv-presenter` avatar integration and adds a hybrid TikTok LIVE workflow:

- **Primary input:** the backend listens to public TikTok LIVE chat, member/join and gift events with `tiktok-live-connector`.
- **Screen input:** the standalone ScreenCapture/live-ocr desktop app performs local OCR and sends text-only webhook events to the backend. Groq text (`GROQ_TEXT_MODEL`) selects relevant viewer interactions; no screenshot or vision-model call is required.
- **AI host:** Groq (`openai/gpt-oss-20b`) creates short spoken responses, with OpenAI as an optional fallback; the existing avatar presenter speaks them when Avatar Studio is open and the presenter has been initialized.
- **Knowledge:** custom facts/FAQs are stored in MongoDB through Mongoose and included in AI context.\n- **Viewer memory:** viewers are saved by TikTok user ID where available, otherwise by normalized username; recent conversation turns are reused for continuity and returning-viewer greetings. The dashboard includes a Viewer memory panel.
- **Hosting:** the Render Blueprint deploys the Node 22.9+ Express service and serves the static dashboard; the frontend can also be hosted separately.

For Render deployment steps and required environment variables, see [README-HOSTING.md](./README-HOSTING.md).

## 1. Deploy the backend to Render

This repository includes a Render Blueprint in `render.yaml`. It deploys the Node service, serves the dashboard from `public/`, and configures a public `/health` liveness endpoint.

1. Push this repository to GitHub, then in Render choose **New + → Blueprint** and select the repository.
2. Configure the Perxona Connect keys, `GROQ_API_KEY`, `GROQ_TEXT_MODEL=openai/gpt-oss-20b`, `SCREEN_CAPTURE_WEBHOOK_TOKEN`, MongoDB Atlas URI, `EULER_API_KEY`, and `FRONTEND_ORIGINS` in the Render environment. The Euler key must have TikTok LIVE signature access; otherwise Euler may reject the websocket signing request. `LIVE_ADMIN_TOKEN` protects the control room; `SCREEN_CAPTURE_WEBHOOK_TOKEN` is a separate secret used only by the desktop OCR webhook.
3. Set `FRONTEND_ORIGINS` to the exact HTTPS origin of the frontend. If using the dashboard served by this same Render service, use the service's `https://<service-name>.onrender.com` URL. For a separately hosted dashboard, use that dashboard's origin instead. Do not use `*` in production.
4. In MongoDB Atlas, allow network access from the Render service (or use an appropriately secured network policy). Keep all API keys and the MongoDB URI in Render's environment settings, never in source control.
5. Wait for the Render health check to pass, then open the service URL to use the bundled dashboard.

The Blueprint runs `npm ci` and `npm start` on Node.js 22.9 or newer. Render supplies `PORT`; do not set it yourself. For local development, copy `.env.example` to `.env` and run:

   ```bash
   npm run dev
   ```

The backend can also be deployed without the Blueprint by setting the same environment variables, using `npm ci` as the build command and `npm start` as the start command, and configuring `/health` as the health-check path.

## 2. Host the frontend separately

1. For the simplest setup, use the dashboard served at the backend's Render URL. To host the frontend separately, upload the **contents** of its `public` directory to any static host (Netlify, Cloudflare Pages, Vercel static hosting, or a web server).
2. Open the hosted frontend URL.
3. Enter the backend base URL (for example `https://api.example.com`) and the same `LIVE_ADMIN_TOKEN` configured on the backend, then click **Save connection**.
4. Enter the TikTok username without `@` and click **Connect to LIVE**.
5. Click **Open Avatar Studio**, choose the avatar, scene and voice, and launch the presenter. Keep the studio page open so it can speak queued event responses.
6. Open **Screen Capture Setup**, generate the webhook URL using `SCREEN_CAPTURE_WEBHOOK_TOKEN`, and paste it into the standalone ScreenCapture app under **Outputs → Webhook**.

The frontend stores the backend URL and admin token in that browser's local storage. This is a simple single-admin deployment, not a multi-user account system. Keep the generated admin token private and restrict `FRONTEND_ORIGINS` to the dashboard origin.

## 3. Notes and limitations

- `tiktok-live-connector` is an unofficial, reverse-engineered integration, not a TikTok/ByteDance official API. TikTok can change or block the event protocol; the direct listener is not guaranteed to work for every account/region. The account generally needs to be LIVE for connection to succeed.
- Install the standalone `ScreenCapture.zip`/live-ocr app on the Windows streaming PC. It captures selected TikTok LIVE Studio regions and performs OCR locally, then POSTs text to `https://tik-backend.onrender.com/api/live/screen-text?token=YOUR_SCREEN_CAPTURE_WEBHOOK_TOKEN`. The backend uses Groq text (`GROQ_TEXT_MODEL=openai/gpt-oss-20b`) to select relevant interactions and sends them through the existing event queue to Avatar Studio. No screen image is sent to Groq, Gemini, or OpenAI.
- Avatar speech is queued only in an open Avatar Studio tab with a successfully initialized presenter. This build does not automate TikTok Live Studio broadcasting or click the TikTok Go LIVE button.
- The existing Perxona sample contains other demo-grade routes without per-user authorization. Do not expose the API publicly without adding stronger authentication, rate limits and production review.
- The frontend is plain HTML/CSS/JS; there is no frontend build step.

## API endpoints added

- `GET /api/live/status`
- `POST /api/live/connect` `{ "username": "creator" }`
- `POST /api/live/disconnect`
- `GET /api/live/events?after=<ISO timestamp>`
- `GET /api/live/viewers?limit=30` (authenticated viewer-memory list)
- `GET /api/live/knowledge`
- `POST /api/live/knowledge` `{ "title": "...", "content": "..." }`
- `DELETE /api/live/knowledge/:id`
- `POST /api/live/screen-text?token=...` `{ "v": 1, "profile": "Default", "region": "TikTok Chat", "text": "Viewer123: Hello host" }`

Live control routes require `X-Admin-Token` matching `LIVE_ADMIN_TOKEN`.

## Engagement features (keep viewers watching, thank gifters)

All of these routes need `X-Admin-Token`. The logic lives in `live-engage.mjs` (no dependencies, unit-testable); `live-host.mjs` wires it to MongoDB, the LLM and the TikTok connector.

| Feature | What it does |
| --- | --- |
| Regulars and streaks | Counts one visit per calendar day, keeps a day streak, and gives badges: Newcomer, Regular (3+ visits or 3-day streak), Super Fan (10+ visits, 7-day streak or 500+ diamonds). The host mentions streaks when someone joins. |
| Chat games | `trivia`, `riddle`, `guess_number`, `word_chain`. Viewers answer in chat; the first correct answer wins points (speed bonus). Game answers do not get normal AI chat replies, so the host does not spam. Trivia and riddles are written by the AI (with a built-in bank as fallback). |
| Show clock | Timed segments (games, announcements, leaderboard, finale) plus teasers such as "in 3 minutes: Guess the number". Runs while a show is running (starts automatically when you connect). |
| Idle engagement | After N quiet seconds the host asks a question, tells a joke, shouts out a regular, mentions goal progress or the crown holder, or teases the next segment. |
| Languages | The host replies in the language of each comment, limited to a list you control. Use a voice in Avatar Studio that speaks those languages. |
| Gift tiers and combos | Gift streaks are merged into ONE reaction at the end (x20 Rose is one thank-you, not twenty). Tier comes from the real diamond value; bigger tiers get longer reactions, a bigger motion and a bigger on-screen moment. |
| Gift goals | Progress bar plus a reward the host performs when the goal is reached. Goals can count gifts or diamonds, one gift type or any, and can repeat. |
| Crown | The top gifter of the show wears the crown; the host announces changes. |
| Gifter perks | A gifter's comments are spoken first and get a fuller answer for a few minutes. `!pick <request>` lets them choose a joke, shout-out or topic (one per qualifying gift). |
| Overlay + analytics | `GET /api/live/overlay` feeds the HUD in Avatar Studio. `GET /api/live/analytics` shows viewers over time, activity, and which segment keeps people watching. |

The host only thanks and rewards. Its prompts forbid asking viewers to send gifts.

### Speech safety (nothing talks over anything)

- The server knows what the avatar is doing: Avatar Studio reports "speaking" and "lines waiting" with every poll. Idle chatter, teasers and show-clock announcements only start when the avatar is quiet. Without a Studio report, the server estimates speaking time from the text length.
- A filler line that was being written while chat, a gift or a game spoke is discarded instead of being read late.
- Only one game can start at a time (a scheduled game and an admin-started game can no longer collide), announcements wait for a running game to finish, and the answer timer starts after the question is ready.
- `GET /api/live/events?client=<id>` grants a speaker lease to one Avatar Studio window; other windows receive no lines. Pages that only display activity send no `client` and always see events.
- `GET /api/live/session` includes `studio: true|false`, so the Show clock page can warn you when no Studio window is open.

### Routes

- `GET /api/live/overlay` live HUD state (goals, crown, leaderboards, running game, next segment, combos, viewer count)
- `GET|PUT /api/live/config` tiers, gifter perks, crown, show clock, idle, games, languages
- `POST /api/live/goals`, `PUT|DELETE /api/live/goals/:id`, `POST /api/live/goals/:id/reset`
- `GET /api/live/session`, `POST /api/live/session/start` `{ "resetGoals": false }`, `POST /api/live/session/stop`
- `GET /api/live/games`, `POST /api/live/games/start` `{ "type": "trivia", "topic": "space" }`, `POST /api/live/games/stop`
- `GET /api/live/leaderboard` this show and all time
- `GET /api/live/analytics?hours=6` or `?scope=session`
- `POST /api/live/simulate` `{ "kind": "gift|chat|join|follow", ... }` test without TikTok; excluded from analytics

### New environment variable

- `LIVE_TIMEZONE` (optional, default `UTC`), for example `Africa/Accra`. Decides where "a new day" starts for visit streaks.

### Tests

Run `node tests/live-engage.test.mjs` to check games, gift tiers, combos, goals, crown, perks, show clock, idle chatter and analytics (no database or network needed).

### Notes

- Goal progress and settings are saved in MongoDB (collection `liveconfigs`), so a restart does not lose them.
- Viewer count samples are stored every 30 seconds while a show runs (collection `livesamples`) for the analytics charts.
- Word chain checks the starting letter, repeats and obvious nonsense; it has no dictionary.
- The `public/` folder still holds the older bundled dashboard. The new pages (show clock, games, gift goals, analytics) and the HUD are in the separate frontend project.

## Host personality and returning-viewer memory

Set `LIVE_HOST_NAME` and `LIVE_BRAND_NAME` in the backend environment. The built-in system prompt defines the TikTok LIVE entertainment host role, short speech-friendly replies, reliable join/gift behavior, trusted knowledge-base rules, safety, privacy, and no fabricated business facts. The OpenAI key remains backend-only.

Viewer records and up to 12 recent message turns per viewer are stored in MongoDB. The dashboard shows recent snippets through the authenticated `GET /api/live/viewers` endpoint. This is conversation continuity, not perfect identity recognition: TikTok user IDs are preferred; when unavailable (such as screen-reading fallback), the normalized username is used and may be ambiguous. Configure an appropriate retention/deletion policy before using this with a large audience.

## LIVE reaction classification

LIVE events now include a `reactionType` value (`welcome`, `follow`, `gift`, `like`, `funny`, `surprise`, `thinking`, or `neutral`) alongside the existing event and reply fields. Event types are classified directly; comments use conservative keyword/emoji matching. This is a hint for the frontend motion mapper, not a guarantee about the viewer's intent. Existing stored events without this field remain compatible because the frontend falls back to classifying from the event type and text.


## Live safety and health updates

- Viewer chat is filtered before it is queued for the host: obvious profanity, prompt-injection attempts, oversized comments and repeated comments are dropped. URLs, email addresses, phone numbers and @handles are redacted so the host does not read them aloud.
- TikTok connection errors trigger exponential-backoff reconnect attempts (up to 30 seconds). Manually disconnecting disables reconnect; connecting again enables it.
- `GET /api/live/health` (admin token required) reports TikTok connection, Avatar Studio speaker lease, host-speech age and chat rate. `POST /api/live/reconnect-setting` accepts `{ "enabled": true|false }`.
- The Show clock page polls the health endpoint every 15 seconds and displays alerts.

The Avatar Studio signal is based on its active speaker lease, not browser-process inspection; a browser that is open but disconnected will correctly be reported as unavailable. Health alerts are dashboard warnings, not external notifications.
