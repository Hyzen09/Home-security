import { Router } from "express";
import db from "../db.js";
import { settingsOf, toProfile } from "../user-view.js";

const router = Router();

router.get("/", (req, res) => {
  res.json(toProfile(req.user));
});

// Tone ids are only format-checked, not allowlisted, so new tones can ship
// in the app without a backend deploy; the app falls back on unknown ids.
router.patch("/settings", (req, res) => {
  const settings = settingsOf(req.user);
  const { alert_tone } = req.body || {};

  if (alert_tone !== undefined) {
    if (typeof alert_tone !== "string" || !/^[a-z0-9_-]{1,32}$/.test(alert_tone)) {
      return res.status(400).json({ error: "alert_tone must be a short tone id" });
    }
    settings.alert_tone = alert_tone;
  }

  db.prepare("UPDATE users SET settings = ? WHERE id = ?").run(JSON.stringify(settings), req.user.id);
  res.json(settings);
});

export default router;
