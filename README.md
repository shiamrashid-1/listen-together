# Listen Together

A very basic web app for listening to Spotify with friends in real time:

- Create a room and get a short shareable code.
- Friends join from their browser using that code.
- The host shares their Spotify tab's audio (via `getDisplayMedia`) and it's relayed live to everyone else in the room over WebRTC — audio only, no video, no screen visuals.
- Anyone in the room can search Spotify's catalog and add songs to a shared queue. If the host connects their Spotify account, added songs also get pushed live onto the host's real Spotify queue.
- Every queued track shows who added it.

## How audio sharing works (and its limits)

The host clicks **Share my audio**, picks the browser tab playing `open.spotify.com`, and ticks **"Share tab audio"** in the browser prompt. That audio track is sent directly (peer-to-peer, mesh topology) to every other participant's browser over WebRTC — nothing is uploaded to a server.

Some networks (strict corporate/school firewalls, proxies that block anything but tunneled HTTP) block WebRTC outright, even with a TURN relay configured. For listeners on networks like that, the app automatically falls back to a plain HTTP audio stream: the host's audio is also recorded and sent to the server, transcoded live to MP3, and served like an ordinary internet radio stream that any browser (including Safari/iPhone) can just play. It kicks in automatically after ~8 seconds if WebRTC hasn't connected, runs a few seconds behind live, and is clearly labeled as "backup stream" in the UI so it's obvious when it's active.

Browser support for tab-audio capture varies:

| Browser | Support |
| --- | --- |
| Chrome / Edge (Windows, ChromeOS, Linux) | Best support for both tab audio and system audio |
| Chrome / Edge (macOS) | Tab audio capture works; full system audio capture needs a virtual audio driver (e.g. BlackHole) |
| Firefox | Partial/inconsistent |
| Safari | Not supported |

Because Spotify streams are DRM-protected, always share the **Spotify Web Player tab specifically** (not the whole desktop app) for the most reliable capture.

The queue is always a shared wishlist that everyone can see, whether or not the host connects Spotify — search results come from Spotify's public catalog (no login needed for that part). See [Real Spotify queueing](#real-spotify-queueing-optional) below for how the host can make "Add" also queue live on their own player.

## Project structure

```
listen-together/
  client/   # Vite + React + TypeScript + Tailwind CSS (the web app)
  server/   # Node + Express + Socket.io (room state, WebRTC signaling, Spotify search proxy, HTTP audio relay fallback)
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

Edit `server/.env` and fill in `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` from your Spotify Developer Dashboard app. Leave `SPOTIFY_REDIRECT_URI` at its default for local dev, or see [Real Spotify queueing](#real-spotify-queueing-optional) to set it up.

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
| `SPOTIFY_REDIRECT_URI` | `https://<your-render-service>.onrender.com/api/spotify/callback` — see [Real Spotify queueing](#real-spotify-queueing-optional) |
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

## Real Spotify queueing (optional)

By default, "Add" just adds a track to the shared in-app queue list — a wishlist everyone can see, but nobody's Spotify player actually changes. If the host connects their Spotify account, "Add" *also* pushes the track straight onto the host's real Spotify queue via Spotify's Web API.

Requirements:

- The host's Spotify account must have **Premium** (Spotify's playback-control API returns an error for free accounts).
- The host must already have Spotify open and playing something (an "active device") — Spotify has no way to queue a track if nothing is currently playing.
- Only the current host can connect Spotify (it's their player everyone is listening to). If the host changes (e.g. the original host disconnects), the new host needs to connect their own account.

Setup:

1. In your [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) app settings, add both redirect URIs under **Redirect URIs**:
   - `http://127.0.0.1:4000/api/spotify/callback` (local dev — Spotify requires the `127.0.0.1` loopback literal, not `localhost`)
   - `https://<your-render-service>.onrender.com/api/spotify/callback` (production — must be HTTPS)
2. Set `SPOTIFY_REDIRECT_URI` in `server/.env` (local) and on Render (production) to match whichever one applies.
3. In the room, the host clicks **Connect Spotify** (visible only to the host) and grants access in the popup that opens. Once granted, everyone in the room sees a "Spotify connected" indicator.
4. From then on, adding a song shows whether it was also queued live on Spotify, or an explanation if it couldn't be (not Premium, or nothing playing yet).

Spotify tokens are stored in-memory per room (matching the rest of the app's ephemeral, no-database design) and are cleared if the room closes or the host changes.

## Notes / future ideas

- Rooms are ephemeral and stored in memory only — restarting the server clears all rooms (including any connected Spotify session).
- Audio relay uses a WebRTC mesh (host connects directly to each listener) capped at `MAX_MESH_LISTENERS` (8, in `client/src/hooks/useAudioMesh.ts`) direct connections — each one is a separate upload from the host's browser, and too many at once saturates a typical home uplink and makes audio stutter for everyone. Listeners beyond that cap are automatically routed to the server-side relay (the same one used for the network-fallback case) instead of getting a WebRTC offer at all, so medium-sized rooms (10-30 people) stay stable without capping the room size itself. This isn't a full fix for very large rooms, since the relay is a single ffmpeg process per room — a future upgrade would move to a proper SFU (e.g. mediasoup, LiveKit) for the meshed tier too.
- The HTTP fallback stream routes audio through the server (unlike WebRTC's peer-to-peer path), so it counts against server bandwidth and adds an `ffmpeg` process per actively-sharing room. Fine for casual/personal-scale use; a lot of concurrent rooms relying on the fallback at once could strain Render's free tier.
