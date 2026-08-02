import { Router } from "express";
import { getIceServers } from "../webrtc/turnCredentials.js";

export const iceServersRouter = Router();

iceServersRouter.get("/", async (_req, res) => {
  const iceServers = await getIceServers();
  res.json({ iceServers });
});
