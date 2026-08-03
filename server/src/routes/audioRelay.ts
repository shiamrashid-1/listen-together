import { Router } from "express";
import * as roomStore from "../rooms/roomStore.js";
import * as audioRelay from "../audio/audioRelay.js";

export const audioRelayRouter = Router();

/**
 * Plain progressive HTTP audio stream - the universal-compatibility fallback
 * for listeners whose network blocks WebRTC entirely. A normal <audio src>
 * pointed at this URL just works in every browser, the same way tuning into
 * an internet radio stream does.
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
