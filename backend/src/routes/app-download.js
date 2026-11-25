import { Router } from "express";
import path from "path";

// GET /app downloads the Android app: a copy of the GitHub release, put by hand in downloads/ on
// the server (DEPLOYMENT.md, "Android app download"). The QR code for the app points here.
const router = Router();
const APK = path.resolve(process.env.DOWNLOADS_DIR || "downloads", "digi-guard.apk");

router.get("/", (req, res) => {
  // no-cache: after the file is replaced, a phone must not get the old one from its cache.
  res.download(APK, "digi-guard.apk", { cacheControl: false, headers: { "Cache-Control": "no-cache" } }, (err) => {
    if (!err) return;
    if (res.headersSent) return; // the phone stopped the download
    res.removeHeader("Content-Disposition");
    const missing = err.status === 404 || err.code === "ENOENT";
    if (!missing) console.error("[app] download failed:", err.message);
    res.status(missing ? 404 : 500).type("text").send("The app isn't available for download right now.");
  });
});

export default router;
