# TikTok LIVE AI Host — Render-ready backend and dashboard

This build keeps the existing Perxona `sv-presenter` avatar integration and adds a hybrid TikTok LIVE workflow:

- **Primary input:** the backend listens to public TikTok LIVE chat, member/join and gift events with `tiktok-live-connector`.
- **Screen input:** the standalone Windows ScreenCapture/live-ocr app performs OCR locally and sends recognized text to a dedicated backend webhook. Groq text selects relevant events; no screenshots or vision models are used.
- **AI host:** Groq (`openai/gpt-oss-20b`) creates short spoken responses, with OpenAI as an optional fallback; the existing avatar presenter speaks them when Avatar Studio is open and the presenter has been initialized.
- **Knowledge:** custom facts/FAQs are stored in MongoDB through Mongoose and included in AI context.
- **Hosting:** the Render Blueprint deploys the Node 22.9+ Express service and serves the static dashboard; the frontend can also be hosted separately.

## 1. Deploy the backend to Render

This repository includes a Render Blueprint in `render.yaml`. It deploys the Node service, serves the dashboard from `public/`, and configures a public `/health` liveness endpoint.

1. Push this repository to GitHub, then in Render choose **New + → Blueprint** and select the repository.
2. Configure the Perxona Connect keys, Groq API key, MongoDB Atlas URI, `EULER_API_KEY`, and `FRONTEND_ORIGINS`. Render generates `LIVE_ADMIN_TOKEN` and `SCREEN_CAPTURE_WEBHOOK_TOKEN`; copy the latter from the service environment into the Screen Capture Setup page. The Euler key must have TikTok LIVE signature access or the websocket signing request may be rejected. Groq uses `GROQ_TEXT_MODEL=openai/gpt-oss-20b` for host replies and OCR text interpretation.
3. Set `FRONTEND_ORIGINS` to the exact HTTPS origin of the frontend. If using the dashboard served by this same Render service, use the service's `https://<service-name>.onrender.com` URL. For a separately hosted dashboard, use that dashboard's origin instead. Do not use `*` in production.
4. In MongoDB Atlas, allow network access from the Render service (or use an appropriately secured network policy). Keep all API keys and the MongoDB URI in Render's environment settings, never in source control.
5. Wait for the Render health check to pass, then open the service URL to use the bundled dashboard.

The Blueprint runs `npm ci` and `npm start` on Node.js 22.9 or newer. Render supplies `PORT`; do not set it yourself. For local development, copy `.env.example` to `.env` and run:

   ```bash
   npm run dev
   ```

The standalone screen-text webhook is authenticated by the separate `SCREEN_CAPTURE_WEBHOOK_TOKEN`; do not reuse `LIVE_ADMIN_TOKEN`.

The backend can also be deployed without the Blueprint by setting the same environment variables, using `npm ci` as the build command and `npm start` as the start command, and configuring `/health` as the health-check path.

## 2. Host the frontend separately

1. For the simplest setup, use the dashboard served at the backend's Render URL. To host the frontend separately, upload the **contents** of its `public` directory to any static host (Netlify, Cloudflare Pages, Vercel static hosting, or a web server).
2. Open the hosted frontend URL.
3. Enter the backend base URL (for example `https://api.example.com`) and the same `LIVE_ADMIN_TOKEN` configured on the backend, then click **Save connection**.
4. Enter the TikTok username without `@` and click **Connect to LIVE**.
5. Click **Open Avatar Studio**, choose the avatar, scene and voice, and launch the presenter. Keep the studio page open so it can speak queued event responses.
6. Open **Screen Capture Setup**, generate the webhook URL using `SCREEN_CAPTURE_WEBHOOK_TOKEN`, and paste it into the standalone ScreenCapture app under **Outputs → Webhook**. Select the TikTok LIVE Studio chat region in the desktop app and start OCR.

The frontend stores the backend URL and admin token in that browser's local storage. This is a simple single-admin deployment, not a multi-user account system. Keep the generated admin token private and restrict `FRONTEND_ORIGINS` to the dashboard origin.

## 3. Notes and limitations

- `tiktok-live-connector` is an unofficial, reverse-engineered integration, not a TikTok/ByteDance official API. TikTok can change or block the event protocol; the direct listener is not guaranteed to work for every account/region. The account generally needs to be LIVE for connection to succeed.
- The standalone ScreenCapture app performs OCR on the Windows PC and POSTs text to `/api/live/screen-text?token=...`. The backend uses Groq text (`openai/gpt-oss-20b`) to select viewer interactions and routes them into the same event/speech queue as direct TikTok events. It does not send screenshots to any AI vision service.
- Avatar speech is queued only in an open Avatar Studio tab with a successfully initialized presenter. This build does not automate TikTok Live Studio broadcasting or click the TikTok Go LIVE button.
- The existing Perxona sample contains other demo-grade routes without per-user authorization. Do not expose the API publicly without adding stronger authentication, rate limits and production review.
- The frontend is plain HTML/CSS/JS; there is no frontend build step.

## API endpoints added

- `GET /api/live/status`
- `POST /api/live/connect` `{ "username": "creator" }`
- `POST /api/live/disconnect`
- `GET /api/live/events?after=<ISO timestamp>`
- `GET /api/live/knowledge`
- `POST /api/live/knowledge` `{ "title": "...", "content": "..." }`
- `DELETE /api/live/knowledge/:id`
- `POST /api/live/screen-text?token=...` `{ "v": 1, "profile": "Default", "region": "TikTok Chat", "text": "Viewer123: Hello host" }`

Live control routes require `X-Admin-Token` matching `LIVE_ADMIN_TOKEN`. The standalone OCR webhook is the exception: it requires the separate `SCREEN_CAPTURE_WEBHOOK_TOKEN` in the `token` query parameter.
