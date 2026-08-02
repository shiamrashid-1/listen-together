# Listen Together

A very basic web app for listening to Spotify with friends in real time:

- Create a room and get a short shareable code.
- Friends join from their browser using that code.
- The host shares their Spotify tab's audio (via `getDisplayMedia`) and it's relayed live to everyone else in the room over WebRTC — audio only, no video, no screen visuals.
- Anyone in the room can search Spotify's catalog and add songs to a shared queue.

## How audio sharing works (and its limits)

The host clicks **Share my audio**, picks the browser tab playing `open.spotify.com`, and ticks **"Share tab audio"** in the browser prompt. That audio track is sent directly (peer-to-peer, mesh topology) to every other participant's browser over WebRTC — nothing is uploaded to a server.

Browser support for tab-audio capture varies:

| Browser | Support |
| --- | --- |
| Chrome / Edge (Windows, ChromeOS, Linux) | Best support for both tab audio and system audio |
| Chrome / Edge (macOS) | Tab audio capture works; full system audio capture needs a virtual audio driver (e.g. BlackHole) |
| Firefox | Partial/inconsistent |
| Safari | Not supported |

Because Spotify streams are DRM-protected, always share the **Spotify Web Player tab specifically** (not the whole desktop app) for the most reliable capture.

The queue is a shared wishlist, not a remote control for the host's Spotify — search results come from Spotify's public catalog (no login needed), and it's up to the host to actually play picks from the queue in their own Spotify.

## Project structure

```
listen-together/
  client/   # Vite + React + TypeScript + Tailwind CSS (the web app)
  server/   # Node + Express + Socket.io (room state, WebRTC signaling, Spotify search proxy)
```

## Setup

### 1. Prerequisites

- Node.js 20+
- A free [Spotify Developer](https://developer.spotify.com/dashboard) app for search (no user login flow needed, just a Client ID/Secret for the Client Credentials grant).

### 2. Install dependencies

```bash
npm install
```

This installs dependencies for the root, `client/`, and `server/` workspaces.

### 3. Configure environment variables

```bash
cp .env.example server/.env
```

Edit `server/.env` and fill in `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` from your Spotify Developer Dashboard app.

Optionally copy `client/.env.example` to `client/.env` if you need to point the client at a non-default server URL.

### 4. Run in development

```bash
npm run dev
```

This starts the server on `http://localhost:4000` and the client on `http://localhost:5173` together. Open the client URL, create a room, and open the invite link in another browser (or send it to a friend) to test joining.

## Deploying so people on other networks can join

Running locally only works for people on your same network. To let friends anywhere join, deploy the client and server separately:

- **Client** (`client/`) → [Vercel](https://vercel.com) as a static site.
- **Server** (`server/`) → [Render](https://render.com) as a persistent Node web service (it needs to stay running to hold Socket.io/WebSocket connections, so it doesn't fit a serverless platform).

### 1. Push to GitHub

Both Render and Vercel deploy straight from a connected GitHub repo. Create a repo and push this project to it.

### 2. Deploy the backend on Render

Render can pick up the [render.yaml](render.yaml) Blueprint in this repo automatically ("New +" → "Blueprint" → select your repo), or you can configure a Web Service manually with:

- **Root Directory**: `server`
- **Build Command**: `npm install && npm run build`
- **Start Command**: `npm run start`
- **Health Check Path**: `/api/health`

Add these environment variables in the Render dashboard:

| Variable | Value |
| --- | --- |
| `SPOTIFY_CLIENT_ID` | from your Spotify Developer app |
| `SPOTIFY_CLIENT_SECRET` | from your Spotify Developer app |
| `CLIENT_ORIGIN` | your Vercel URL (set this after step 3 below, then redeploy) |
| `METERED_API_KEY` | optional, see step 4 |
| `METERED_DOMAIN` | optional, see step 4 |

Deploy, and note the resulting URL (e.g. `https://listen-together-server.onrender.com`).

> Render's free tier spins a service down after ~15 minutes of inactivity. The first request after that takes ~30-50s to wake it back up — fine for a casual listening party, just not instant if nobody's used it in a while.

### 3. Deploy the frontend on Vercel

Import the same GitHub repo into Vercel:

- **Root Directory**: `client`
- **Framework Preset**: Vite (auto-detected)

Add an environment variable:

| Variable | Value |
| --- | --- |
| `VITE_SERVER_URL` | your Render URL from step 2 |

Deploy, and note the resulting URL (e.g. `https://listen-together.vercel.app`). Then go back to Render and set `CLIENT_ORIGIN` to this URL, and redeploy the backend so CORS/Socket.io allow requests from it.

### 4. (Optional) Add a TURN server for reliability

WebRTC tries to connect peers directly first. That works fine on most home networks, but some networks (stricter corporate/school firewalls, symmetric NATs) block direct peer connections entirely and need a TURN relay server as a fallback.

1. Sign up free at [openrelayproject.org](https://openrelayproject.org) or [metered.ca](https://www.metered.ca/stun-turn) (no credit card).
2. From your dashboard, grab your API key and the domain shown for TURN credential requests (e.g. `yourapp.metered.live`).
3. Set `METERED_API_KEY` and `METERED_DOMAIN` on Render, then redeploy.

The server exposes these as `GET /api/ice-servers`; the client fetches this once before setting up WebRTC connections and falls back to public STUN-only automatically if it's not configured or the request fails.

### 5. Test it

Open the Vercel URL from two devices on genuinely different networks (e.g. your laptop on WiFi and your phone on cellular data) and confirm room joining, live audio sharing, and the queue all work.

## Notes / future ideas

- Rooms are ephemeral and stored in memory only — restarting the server clears all rooms.
- Audio relay uses a simple WebRTC mesh (host connects directly to each listener), which is fine for small groups of friends but won't scale to large rooms. A future upgrade would move to an SFU (e.g. mediasoup, LiveKit).
- The queue could later be upgraded to actually control the host's Spotify playback via the Spotify Connect API, if the host connects their account (requires Spotify Premium + OAuth login).
