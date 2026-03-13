# when2meet-ai

React + Node app that embeds a When2Meet page in an iframe and logs normalized per-person availability on query submit.

## Structure

- `client/`: Vite + React frontend.
- `server/`: Express API that fetches and parses When2Meet HTML.

## Run locally

1. Install dependencies:
   - `npm install`
2. Run backend:
   - `npm run dev:server`
3. Run frontend:
   - `npm run dev:client`
4. Open `http://localhost:5173`.

Default URL is blank; enter your own `https://www.when2meet.com/?<eventId>-<code>` link.

## Tests

- All tests: `npm test`
- Server only: `npm run test --workspace server`
- Client only: `npm run test --workspace client`

## Deploy (Railway + Vercel)

1. Push repo to GitHub.
2. Deploy backend on Railway:
   - Service root directory: `server`
   - Build command: `npm install && npm run build`
   - Start command: `npm start`
   - Env var: `CORS_ORIGIN=https://your-vercel-app.vercel.app`
   - Copy deployed URL, e.g. `https://your-backend.up.railway.app`
3. Deploy frontend on Vercel:
   - Project root directory: `client`
   - Build command: `npm run build`
   - Output directory: `dist`
   - Env var: `VITE_API_BASE_URL=https://your-backend.up.railway.app`
4. Redeploy Vercel after setting env var.
