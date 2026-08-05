import { Router } from "express";
import * as roomStore from "../rooms/roomStore.js";
import * as audioRelay from "../audio/audioRelay.js";

export const audioRelayRouter = Router();

/**
 * Raw HTTP byte stream of the room's relay output (fragmented MP4/AAC) -
 * mainly useful for debugging/manual inspection. The app itself no longer
 * plays audio through this directly (see the Socket.IO-delivered
 * MediaSource path in useAudioMesh.ts); a live-growing fragmented MP4 isn't
 * reliably playable via a plain <audio src> the way progressive MP3 was.
 */
audioRelayRouter.get("/live/:code", (req, res) => {
  const code = req.params.code.toUpperCase();
  if (!roomStore.getRoom(code)) {
    res.status(404).end();
    return;
  }

  res.writeHead(200, {
    "Content-Type": "audio/mp4",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });

  audioRelay.subscribe(code, res);
});
