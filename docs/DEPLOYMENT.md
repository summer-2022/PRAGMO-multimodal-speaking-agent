# PRAGMO internal V1 deployment

This deployment uses Firebase Hosting for the React frontend and Cloud Run for
the FastAPI backend. Never commit `.env`, API-key values, or files under
`backend/results/`.

## Required backend settings

Configure these values in Cloud Run or Secret Manager:

- `OPENAI_API_KEY`
- `LIVEAVATAR_API_KEY`
- `ALLOWED_ORIGINS` — comma-separated exact frontend origins, without paths;
  for example `https://PROJECT_ID.web.app,https://PROJECT_ID.firebaseapp.com`

The service exposes `GET /health` for a non-provider health check. Cloud Run
must use port `8080` and include a request timeout long enough for a speaking
session.

## Backend deployment

Run from `backend/` after selecting the intended Google Cloud project:

```bash
gcloud run deploy pragmo-backend \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --timeout 3600 \
  --min 0
```

Add the two API keys securely and set `ALLOWED_ORIGINS` to the final Firebase
Hosting origins. Do not put provider keys in any `VITE_` variable.

## Frontend build and deployment

Set the public backend endpoints only for the production build:

```bash
cd frontend
VITE_API_URL=https://CLOUD_RUN_SERVICE_URL \
VITE_WS_URL=wss://CLOUD_RUN_SERVICE_HOST/ws \
npm run build
cd ..
firebase deploy --only hosting
```

`VITE_API_URL` and `VITE_WS_URL` are public routing values, not secrets. The
local development defaults remain `http://localhost:8000` and
`ws://localhost:8000/ws`.

## Internal V1 checks

1. Open the Firebase URL in a private browser window.
2. Confirm `GET /health` returns `{"status":"ok"}`.
3. Allow microphone access and complete SP1.
4. Confirm analysis prepares four TTS clips without generating a legacy video.
5. Play all four LiveAvatar turns, then verify Replay uses cached PCM.
6. Complete SP2 and verify the final evaluation appears once.
7. Review Cloud Run logs for WebSocket, provider, or timeout errors.

Local `backend/results/` storage is temporary on Cloud Run. It is acceptable
only for connectivity testing; connect Cloud Storage before collecting research
data that must be retained.
