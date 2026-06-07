// 1. Add this import at the top (under "import { createRequire } ..."):
import https from "https";

// 2. Add this route endpoint (e.g., right below the other post routes or around line 1124):
  // API Route: CORS proxy to secure and reliably retrieve remote quiz JSON data
  app.get("/api/proxy-json-url", async (req, res) => {
    try {
      const url = req.query.url;
      if (!url || typeof url !== "string") {
        return res.status(400).json({ error: "Missing required 'url' query parameter." });
      }

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch (e) {
        return res.status(400).json({ error: "Invalid URL structure." });
      }

      // Safe retrieval using native https client
      https.get(parsedUrl.toString(), (getRes) => {
        let body = "";
        getRes.on("data", (chunk) => {
          body += chunk;
        });
        getRes.on("end", () => {
          try {
            const data = JSON.parse(body);
            res.json(data);
          } catch (jsonErr) {
            // If response is not purely JSON but text, send as layout
            res.status(400).json({ error: "Retrieved source is not a valid JSON structure." });
          }
        });
      }).on("error", (err) => {
        console.error("https get error in proxy route:", err);
        res.status(500).json({ error: `Proxy failed to fetch source content: ${err.message}` });
      });
    } catch (routeErr: any) {
      console.error("Proxy route general failure:", routeErr);
      res.status(500).json({ error: routeErr.message || "General failure inside proxy context." });
    }
  });
