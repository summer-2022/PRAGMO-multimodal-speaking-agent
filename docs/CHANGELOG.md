# PRAGMO Changelog

## 2026-09-13 — Internal V1 deployment candidate

### Product updates

- Migrated the OpenAI Realtime conversation flow to the GA API using `gpt-realtime-2.1`.
- Refined the professor instruction to keep office-hour dialogue concise, relevant, and natural.
- Integrated two LiveAvatar LITE sessions for the four-turn feedback demonstration.
- Added role-specific TTS, PCM caching, Replay behavior, cleanup, and duplicate-event protection.
- Refined the intermediate feedback and final evaluation prompts while preserving their JSON contracts.
- Simplified the LiveAvatar feedback UI and gated SP2 until feedback playback completes.

### Deployment preparation

- Added configurable CORS origins through `ALLOWED_ORIGINS`.
- Added the backend `/health` endpoint.
- Added the Cloud Run `Dockerfile` with `ffmpeg` support and `.dockerignore`.
- Added Firebase Hosting configuration for the React production build.
- Strengthened Git exclusions for secrets, results, build outputs, caches, and the standalone avatar prototype.
- Added `docs/DEPLOYMENT.md` with the initial GCP and Firebase deployment procedure.

### Verification

- Backend offline tests: 18 passed.
- Frontend offline tests: 35 passed.
- Frontend lint: passed.
- Frontend production build: passed.
- No live OpenAI or HeyGen API calls were made during these checks.

### Remaining before research use

- Deploy the backend to Cloud Run and the frontend to Firebase Hosting.
- Configure production secrets, frontend URLs, CORS, HTTPS, and WSS.
- Test microphone, WebSocket, Realtime, LiveAvatar, SP1–SP2, and result saving from the deployed link.
- Replace Cloud Run local result storage with durable Cloud Storage before collecting research data.
