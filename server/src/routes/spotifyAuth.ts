import { Router } from "express";
import type { Server } from "socket.io";
import * as roomStore from "../rooms/roomStore.js";
import * as tokenStore from "../spotify/tokenStore.js";
import * as playbackPoller from "../spotify/playbackPoller.js";
import { exchangeCodeForTokens, getAuthorizeUrl } from "../spotify/spotifyClient.js";

function htmlPage(title: string, message: string, autoClose: boolean) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>
      body { font-family: system-ui, sans-serif; background: #111; color: #eee; display: flex;
             align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
      div { max-width: 320px; padding: 24px; }
      h1 { font-size: 1.1rem; margin-bottom: 8px; }
      p { font-size: 0.9rem; color: #aaa; }
    </style>
  </head>
  <body>
    <div>
      <h1>${title}</h1>
      <p>${message}</p>
    </div>
    ${autoClose ? "<script>setTimeout(() => window.close(), 1500);</script>" : ""}
  </body>
</html>`;
}

export function createSpotifyAuthRouter(io: Server): Router {
  const router = Router();

  router.get("/login", (req, res) => {
    const code = String(req.query.code ?? "").trim();
    const socketId = String(req.query.socketId ?? "").trim();
    const redirectUri = process.env.SPOTIFY_REDIRECT_URI;

    if (!redirectUri) {
      res
        .status(500)
        .send(htmlPage("Not configured", "The server is missing SPOTIFY_REDIRECT_URI. Ask the host to set it up.", false));
      return;
    }

    if (!code || !socketId) {
      res.status(400).send(htmlPage("Missing info", "This link is missing required parameters.", false));
      return;
    }

    if (!roomStore.isHost(code, socketId)) {
      res
        .status(403)
        .send(htmlPage("Not allowed", "Only the current host of the room can connect Spotify.", false));
      return;
    }

    try {
      const authorizeUrl = getAuthorizeUrl(code.toUpperCase(), redirectUri);
      res.redirect(authorizeUrl);
    } catch (err) {
      console.error("[spotify-auth] failed to build authorize URL:", err);
      res.status(500).send(htmlPage("Configuration error", "Couldn't start the Spotify connection.", false));
    }
  });

  router.get("/callback", async (req, res) => {
    const code = String(req.query.code ?? "");
    const state = String(req.query.state ?? "").trim();
    const error = req.query.error;
    const redirectUri = process.env.SPOTIFY_REDIRECT_URI;

    if (error) {
      res.send(htmlPage("Connection cancelled", "You didn't grant access, so nothing was connected.", true));
      return;
    }

    if (!code || !state || !redirectUri) {
      res.status(400).send(htmlPage("Something went wrong", "The Spotify response was missing information.", false));
      return;
    }

    const room = roomStore.getRoom(state);
    if (!room) {
      res.status(404).send(htmlPage("Room not found", "That room no longer exists. Try connecting again from the app.", false));
      return;
    }

    try {
      const tokens = await exchangeCodeForTokens(code, redirectUri);
      if (!tokens.refreshToken) {
        throw new Error("Spotify did not return a refresh token.");
      }
      tokenStore.set(state, tokens.accessToken, tokens.refreshToken, tokens.expiresIn);
      const updated = roomStore.setSpotifyConnected(state, true);
      if (updated) {
        io.to(updated.code).emit("room:state", updated);
        playbackPoller.startPolling(updated.code, io);
      }

      res.send(htmlPage("Connected!", "Spotify is connected. You can close this window.", true));
    } catch (err) {
      console.error("[spotify-auth] token exchange failed:", err);
      res.status(502).send(htmlPage("Connection failed", "Couldn't finish connecting to Spotify. Please try again.", false));
    }
  });

  router.post("/disconnect", (req, res) => {
    const code = String(req.body?.code ?? "").trim();
    const socketId = String(req.body?.socketId ?? "").trim();

    if (!code || !roomStore.isHost(code, socketId)) {
      res.status(403).json({ ok: false, error: "Only the current host can disconnect Spotify." });
      return;
    }

    tokenStore.clear(code);
    playbackPoller.stopPolling(code);
    const updated = roomStore.setSpotifyConnected(code, false);
    if (updated) io.to(updated.code).emit("room:state", updated);
    res.json({ ok: true });
  });

  return router;
}
