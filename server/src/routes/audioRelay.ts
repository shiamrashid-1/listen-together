import { Router } from "express";
import * as roomStore from "../rooms/roomStore.js";
import * as audioRelay from "../audio/audioRelay.js";

export const audioRelayRouter = Router();

/**
 * Raw HTTP byte stream of the room's relay output (MP3) - mainly useful for
 * debugging/manual inspection. The app itself plays audio through the
 * Socket.IO-delivered path in useAudioMesh.ts instead, since some networks
 * block long-lived streaming HTTP connections outright.
 */
audioRelayRouter.get("/live/:code", (req, res) => {
  const code = req.params.code.toUpperCase();
  if (!roomStore.getRoom(code)) {
    res.status(404).end();
    return;
  }

  res.writeHead(200, {
    "Content-Type": "audio/mpeg",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });

  audioRelay.subscribe(code, res);
});
