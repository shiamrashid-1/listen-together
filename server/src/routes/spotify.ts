import { Router } from "express";
import { searchTracks } from "../spotify/spotifyClient.js";

export const spotifyRouter = Router();

spotifyRouter.get("/search", async (req, res) => {
  const query = String(req.query.q ?? "").trim();
  if (!query) {
    res.status(400).json({ error: "Missing query parameter 'q'." });
    return;
  }

  try {
    const results = await searchTracks(query);
    res.json({ results });
  } catch (err) {
    console.error("[spotify] search failed:", err);
    res.status(502).json({ error: "Spotify search is unavailable right now. Check server credentials." });
  }
});
