# TikTok LIVE AI Host — Render-ready backend and dashboard

This build keeps the existing Perxona `sv-presenter` avatar integration and adds a hybrid TikTok LIVE workflow:

- **Primary input:** the backend listens to public TikTok LIVE chat, member/join and gift events with `tiktok-live-connector`.
- **Fallback input:** the browser can share a TikTok LIVE Studio window and periodically send reduced-resolution screenshots to the backend for Groq-first vision extraction.
- **AI host:** Groq (`openai/gpt-oss-20b`) creates short spoken responses, with OpenAI as an optional fallback; the existing avatar presenter speaks them when Avatar Studio is open and the presenter has been initialized.
- **Knowledge:** custom facts/FAQs are stored in MongoDB through Mongoose and included in AI context.
- **Hosting:** the Render Blueprint deploys the Node 22.9+ Express service and serves the static dashboard; the frontend can also be hosted separately.

## 1. Deploy the backend to Render

This repository includes a Render Blueprint in `render.yaml`. It deploys the Node service, serves the dashboard from `public/`, and configures a public `/health` liveness endpoint.

1. Push this repository to GitHub, then in Render choose **New + → Blueprint** and select the repository.
2. Enter the Perxona Connect secret and publishable keys, Groq API key, MongoDB Atlas URI, and `FRONTEND_ORIGINS` when prompted. The defaults use `GROQ_TEXT_MODEL=openai/gpt-oss-20b` for host replies and `GROQ_VISION_MODEL` for screen captures; OpenAI is optional as a fallback; Render generates `LIVE_ADMIN_TOKEN`, whose value you can view in the service environment after creation.
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
6. If direct events are missing, use **Start screen fallback** and choose the TikTok LIVE Studio window in the browser share dialog.

The frontend stores the backend URL and admin token in that browser's local storage. This is a simple single-admin deployment, not a multi-user account system. Keep the generated admin token private and restrict `FRONTEND_ORIGINS` to the dashboard origin.

## 3. Notes and limitations

- `tiktok-live-connector` is an unofficial, reverse-engineered integration, not a TikTok/ByteDance official API. TikTok can change or block the event protocol; the direct listener is not guaranteed to work for every account/region. The account generally needs to be LIVE for connection to succeed.
- Screen fallback requires a browser that supports `getDisplayMedia()` (use a secure HTTPS origin or localhost) and explicit user permission. Keep the relevant LIVE Studio window visible. Host text uses Groq first (`GROQ_TEXT_MODEL=openai/gpt-oss-20b`), and screen capture tries Groq first using `GROQ_VISION_MODEL` (a vision-capable model), then optionally falls back to OpenAI if Groq fails. The fallback samples roughly every 12 seconds.
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
- `POST /api/live/screen-observation` `{ "image": "data:image/jpeg;base64,..." }`

Live control routes require `X-Admin-Token` matching `LIVE_ADMIN_TOKEN`.
