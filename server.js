/**
 * RaastaGo Local Development Server
 * Serves HTML pages at clean URLs and static files correctly
 */

const express = require("express");
const path = require("path");
const app = express();
const ROOT = __dirname;

// Determine HTML file paths from /UI folder
const HOME_FILE = path.join(ROOT, "UI", "home.html");
const COMPARE_FILE = path.join(ROOT, "UI", "route.html");
const ANALYSIS_FILE = path.join(ROOT, "UI", "analysis.html");
const SAFETY_FILE = path.join(ROOT, "UI", "safety.html");
const FEEDBACK_FILE = path.join(ROOT, "UI", "feedback.html");

// Serve static files FIRST (before routes)
app.use("/public", express.static(path.join(ROOT, "public")));
// Note: /api is NOT static - we handle it as routes below

// Parse form submissions
app.use(express.urlencoded({ extended: true }));

// ==================== API ENDPOINTS ====================

// Health check
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

// Geocoding endpoint (Nominatim proxy)
app.get("/api/geocode", async (req, res) => {
  const query = req.query.q;
  
  if (!query || typeof query !== "string" || query.trim().length === 0) {
    return res.status(400).json({ 
      ok: false, 
      message: "Query parameter 'q' is required" 
    });
  }

  try {
    // Call Nominatim API with Lahore bias
    const nominatimUrl = new URL("https://nominatim.openstreetmap.org/search");
    nominatimUrl.searchParams.set("q", query.trim() + ", Lahore, Pakistan");
    nominatimUrl.searchParams.set("countrycodes", "pk");
    nominatimUrl.searchParams.set("format", "jsonv2");
    nominatimUrl.searchParams.set("addressdetails", "1");
    nominatimUrl.searchParams.set("limit", "5");
    nominatimUrl.searchParams.set("viewbox", "73.98,31.35,74.55,31.62");
    nominatimUrl.searchParams.set("bounded", "1");

    const userAgent = process.env.OSM_USER_AGENT || "RaastaGo/1.0 (local-dev)";
    
    const response = await fetch(nominatimUrl.toString(), {
      headers: {
        "User-Agent": userAgent,
        "Accept-Language": "en",
      },
      timeout: 5000,
    });

    if (!response.ok) {
      console.error(`Nominatim API error: ${response.status}`);
      return res.json({
        ok: false,
        message: "Geocoding service temporarily unavailable",
        results: [],
      });
    }

    const data = await response.json();
    
    // Transform results
    const results = (data || []).map((item) => ({
      label: item.display_name || item.name || "",
      lat: parseFloat(item.lat),
      lon: parseFloat(item.lon),
      importance: parseFloat(item.importance) || 0.5,
      type: item.type || "place",
    }));

    return res.json({
      ok: results.length > 0,
      query: query.trim(),
      results: results,
      message: results.length === 0 ? "No results found" : undefined,
    });
  } catch (error) {
    console.error("Geocode error:", error.message);
    return res.json({
      ok: false,
      message: "Geocoding service error: " + error.message,
      results: [],
    });
  }
});

// Routing endpoint - OSRM proxy for driving routes
app.get("/api/route", async (req, res) => {
  const { profile, fromLat, fromLon, toLat, toLon } = req.query;
  
  if (!profile || !fromLat || !fromLon || !toLat || !toLon) {
    return res.status(400).json({
      ok: false,
      message: "Missing required params: profile, fromLat, fromLon, toLat, toLon",
    });
  }

  const fLat = parseFloat(fromLat);
  const fLon = parseFloat(fromLon);
  const tLat = parseFloat(toLat);
  const tLon = parseFloat(toLon);

  if (isNaN(fLat) || isNaN(fLon) || isNaN(tLat) || isNaN(tLon)) {
    return res.status(400).json({ 
      ok: false, 
      message: "Coordinates must be valid numbers" 
    });
  }

  // Build OSRM URL - OSRM expects [lon,lat] order
  // Using overview=full to get complete geometry, geometries=geojson for GeoJSON format
  const osrmUrl = `https://router.project-osrm.org/route/v1/${profile}/${fLon},${fLat};${tLon},${tLat}?overview=full&geometries=geojson&alternatives=false&steps=false`;
  
  console.log(`[OSRM] Requesting: ${osrmUrl}`);

  try {
    const response = await fetch(osrmUrl, { 
      timeout: 5000,
      headers: {
        "User-Agent": "RaastaGo/1.0 (local-dev)",
      }
    });

    if (!response.ok) {
      console.error(`[OSRM] HTTP error: ${response.status}`);
      const errorText = await response.text();
      console.error(`[OSRM] Response: ${errorText}`);
      
      // Fallback to straight-line route
      return res.json(fallbackRoute(fLat, fLon, tLat, tLon, "OSRM API error"));
    }

    const data = await response.json();
    
    if (!data.routes || data.routes.length === 0) {
      console.warn("[OSRM] No routes returned");
      return res.json(fallbackRoute(fLat, fLon, tLat, tLon, "No routes found"));
    }

    const route = data.routes[0];
    const geometry = route.geometry.coordinates;
    
    // Convert from GeoJSON [lon, lat] to Leaflet [lat, lon] format
    const polyline = geometry.map(([lon, lat]) => [lat, lon]);
    
    console.log(`[OSRM] Success: ${polyline.length} points, distance: ${route.distance}m, duration: ${route.duration}s`);

    res.json({
      ok: true,
      distanceMeters: Math.round(route.distance),
      durationSeconds: Math.round(route.duration),
      polyline: polyline, // Now has many points following actual roads
    });
  } catch (error) {
    console.error("[OSRM] Request failed:", error.message);
    return res.json(fallbackRoute(fLat, fLon, tLat, tLon, error.message));
  }
});

// Fallback when OSRM fails: straight-line approximation
function fallbackRoute(fromLat, fromLon, toLat, toLon, reason) {
  console.log(`[FALLBACK] Using straight-line (reason: ${reason})`);
  
  // Haversine distance calculation
  const R = 6371; // Earth radius in km
  const dLat = ((toLat - fromLat) * Math.PI) / 180;
  const dLon = ((toLon - fromLon) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((fromLat * Math.PI) / 180) *
      Math.cos((toLat * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = Math.round((R * c * 1000)); // meters
  
  // Estimate duration at 40 km/h average
  const duration = Math.round((distance / 40000) * 3600); // seconds
  
  return {
    ok: false,
    distanceMeters: distance,
    durationSeconds: duration,
    polyline: [[fromLat, fromLon], [toLat, toLon]], // 2-point fallback
    fallback: true,
    reason: reason,
  };
}

// ==================== HTML PAGE ROUTES ====================

// Clean URL Routes - these handle human navigation
app.get("/", (req, res) => {
  res.sendFile(HOME_FILE);
});

app.get("/compare", (req, res) => {
  res.sendFile(COMPARE_FILE);
});

app.get("/analysis", (req, res) => {
  res.sendFile(ANALYSIS_FILE);
});

app.get("/safety", (req, res) => {
  res.sendFile(SAFETY_FILE);
});

app.get("/feedback", (req, res) => {
  res.sendFile(FEEDBACK_FILE);
});

// Feedback form submission handler
app.post("/feedback", (req, res) => {
  // Read form data
  const category = req.body.category || "Not specified";
  const message = req.body.message || "";
  const email = req.body.email || "Not provided";
  
  // Log to console (optional: could save to file here)
  console.log("[FEEDBACK] Category:", category);
  console.log("[FEEDBACK] Message:", message);
  console.log("[FEEDBACK] Email:", email);
  
  // Redirect to feedback page with success flag
  res.redirect(303, "/feedback?success=1");
});

// Legacy file extension routes - redirect to clean URLs
app.get("/home.html", (req, res) => res.redirect("/"));
app.get("/route.html", (req, res) => res.redirect("/compare"));
app.get("/analysis.html", (req, res) => res.redirect("/analysis"));
app.get("/safety.html", (req, res) => res.redirect("/safety"));
app.get("/feedback.html", (req, res) => res.redirect("/feedback"));

// 404 handler - helpful error for debugging
app.use((req, res) => {
  res.status(404).send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>404 Not Found</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 20px; background: #f5f5f5; }
        .container { max-width: 600px; margin: 50px auto; background: white; padding: 20px; border-radius: 8px; }
        h1 { color: #652046; }
        code { background: #eee; padding: 2px 6px; border-radius: 3px; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>404 Not Found</h1>
        <p>The requested path <code>${req.path}</code> does not exist.</p>
        <p><strong>Available routes:</strong></p>
        <ul>
          <li><a href="/">Home</a> (or /home.html)</li>
          <li><a href="/compare">Compare Routes</a> (or /route.html)</li>
          <li><a href="/analysis">Analysis</a> (or /analysis.html)</li>
          <li><a href="/safety">Safety</a> (or /safety.html)</li>
          <li><a href="/feedback">Feedback</a> (or /feedback.html)</li>
          <li><a href="/public/app.js">Static: app.js</a></li>
          <li><a href="/public/map.js">Static: map.js</a></li>
        </ul>
        <hr>
        <p><small>RaastaGo Development Server</small></p>
      </div>
    </body>
    </html>
  `);
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║     RaastaGo Development Server        ║
╠════════════════════════════════════════╣
║  🚀 Running on http://localhost:${PORT}       ║
║                                        ║
║  Routes:                               ║
║    /              → Home page          ║
║    /compare       → Compare routes     ║
║    /analysis      → Route analysis     ║
║    /safety        → Safety info        ║
║    /feedback      → User feedback      ║
║                                        ║
║  Static files:                         ║
║    /public/app.js → Frontend logic     ║
║    /public/map.js → Map controller     ║
║                                        ║
║  Press Ctrl+C to stop                  ║
╚════════════════════════════════════════╝
  `);
});
