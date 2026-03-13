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

Default URL is set to: `https://www.when2meet.com/?35187552-u5FTV`

## Tests

- All tests: `npm test`
- Server only: `npm run test --workspace server`
- Client only: `npm run test --workspace client`
