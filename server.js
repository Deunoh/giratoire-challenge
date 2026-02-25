const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const LEADERBOARD_FILE = path.join(__dirname, 'leaderboard.json');

// Trust proxy for hosting behind reverse proxies (Render, Railway, etc.)
app.set('trust proxy', 1);

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"]
    }
  }
}));

app.use(cors());
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Rate Limiters ---
const challengeLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 5,               // 5 challenges per minute per IP
  message: { error: 'Trop de requêtes ! Attends un peu avant de relancer.' },
  standardHeaders: true,
  legacyHeaders: false
});

const autocompleteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,              // 60 autocomplete requests per minute per IP
  message: { error: 'Trop de requêtes.' },
  standardHeaders: true,
  legacyHeaders: false
});

// --- Helpers ---

function loadLeaderboard() {
  if (!fs.existsSync(LEADERBOARD_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveLeaderboard(data) {
  fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Rate-limit helper for Nominatim (1 req/s policy)
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Geocode a city name via Nominatim ---
async function geocode(cityName) {
  const url = `https://nominatim.openstreetmap.org/search?` +
    `q=${encodeURIComponent(cityName)}&format=json&limit=1&countrycodes=fr`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'GiratoireChallenge/1.0' }
  });
  const data = await res.json();
  if (!data.length) throw new Error(`Ville introuvable : ${cityName}`);
  return {
    lat: parseFloat(data[0].lat),
    lon: parseFloat(data[0].lon),
    displayName: data[0].display_name.split(',')[0]
  };
}

// --- Get route via OSRM ---
async function getRoute(fromLon, fromLat, toLon, toLat) {
  const url = `https://router.project-osrm.org/route/v1/driving/` +
    `${fromLon},${fromLat};${toLon},${toLat}?overview=full&geometries=geojson`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'GiratoireChallenge/1.0' }
  });
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes.length) {
    throw new Error('Impossible de calculer un itinéraire');
  }
  const route = data.routes[0];
  return {
    geometry: route.geometry,
    distance: route.distance,    // meters
    duration: route.duration     // seconds
  };
}

// --- Count roundabouts along a route using Overpass API (bbox segments) ---

function computeSegmentBboxes(coords, maxSegments = 12) {
  // Split route coordinates into segments and compute a bbox for each
  const segmentSize = Math.max(1, Math.ceil(coords.length / maxSegments));
  const bboxes = [];
  const buffer = 0.003; // ~300m buffer

  for (let i = 0; i < coords.length; i += segmentSize) {
    const segment = coords.slice(i, i + segmentSize + 1); // overlap 1 point
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const [lon, lat] of segment) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
    bboxes.push({
      s: minLat - buffer,
      n: maxLat + buffer,
      w: minLon - buffer,
      e: maxLon + buffer
    });
  }
  return bboxes;
}

function deduplicateRoundabouts(elements) {
  const roundaboutWays = elements.filter(
    el => el.type === 'way' && (el.tags?.junction === 'roundabout' || el.tags?.junction === 'circular')
  );

  // Group by shared nodes — ways sharing any node belong to the same roundabout
  const nodeToGroup = new Map();
  let groupId = 0;
  const wayToGroup = new Map();

  for (const way of roundaboutWays) {
    let existingGroup = null;
    for (const nodeId of way.nodes) {
      if (nodeToGroup.has(nodeId)) {
        existingGroup = nodeToGroup.get(nodeId);
        break;
      }
    }
    if (existingGroup !== null) {
      wayToGroup.set(way.id, existingGroup);
      for (const nodeId of way.nodes) {
        nodeToGroup.set(nodeId, existingGroup);
      }
    } else {
      const gid = groupId++;
      wayToGroup.set(way.id, gid);
      for (const nodeId of way.nodes) {
        nodeToGroup.set(nodeId, gid);
      }
    }
  }

  // Return groups with their representative ways
  const groups = new Map();
  for (const way of roundaboutWays) {
    const gid = wayToGroup.get(way.id);
    if (!groups.has(gid)) {
      groups.set(gid, []);
    }
    groups.get(gid).push(way);
  }
  return groups; // Map<groupId, way[]>
}

// --- Haversine distance in meters between two points ---
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// --- Minimum distance from a point to a polyline segment ---
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// --- Check if a roundabout centroid is close to the route polyline ---
function isNearRoute(centroidLat, centroidLon, routeCoords, maxDistMeters = 50) {
  // Quick check: sample every N points for performance
  const step = Math.max(1, Math.floor(routeCoords.length / 500));
  let minDist = Infinity;

  for (let i = 0; i < routeCoords.length - 1; i += step) {
    const j = Math.min(i + step, routeCoords.length - 1);
    const [lon1, lat1] = routeCoords[i];
    const [lon2, lat2] = routeCoords[j];

    // Rough degree-distance check first (fast rejection, ~0.001° ≈ 100m)
    const threshold = 0.002;
    const midLat = (lat1 + lat2) / 2, midLon = (lon1 + lon2) / 2;
    if (Math.abs(centroidLat - midLat) > 0.05 && Math.abs(centroidLon - midLon) > 0.05) continue;

    const dist = haversineMeters(
      centroidLat, centroidLon,
      lat1 + (lat2 - lat1) * 0.5, lon1 + (lon2 - lon1) * 0.5
    );
    if (dist < minDist) minDist = dist;
    if (minDist < maxDistMeters) return true;
  }

  // Detailed check on nearby segments
  for (let i = 0; i < routeCoords.length - 1; i++) {
    const [lon1, lat1] = routeCoords[i];
    const [lon2, lat2] = routeCoords[i + 1];

    // Quick lat/lon rejection
    const segMinLat = Math.min(lat1, lat2) - 0.001;
    const segMaxLat = Math.max(lat1, lat2) + 0.001;
    const segMinLon = Math.min(lon1, lon2) - 0.001;
    const segMaxLon = Math.max(lon1, lon2) + 0.001;
    if (centroidLat < segMinLat || centroidLat > segMaxLat ||
        centroidLon < segMinLon || centroidLon > segMaxLon) continue;

    // Project onto segment and compute haversine
    const flatDist = distToSegment(centroidLon, centroidLat, lon1, lat1, lon2, lat2);
    // Convert flat degree distance to approximate meters
    const approxMeters = flatDist * 111320 * Math.cos(centroidLat * Math.PI / 180);
    if (approxMeters < maxDistMeters) return true;
  }

  return false;
}

async function queryOverpassBboxes(bboxes) {
  // Build a single Overpass query: union of bbox filters
  const bboxFilters = bboxes.map(b =>
    `  way["junction"="roundabout"](${b.s},${b.w},${b.n},${b.e});\n` +
    `  way["junction"="circular"](${b.s},${b.w},${b.n},${b.e});`
  ).join('\n');

  const query = `[out:json][timeout:90][maxsize:10485760];\n(\n${bboxFilters}\n);\nout body;\n>;\nout skel qt;`;

  console.log(`[Overpass] Querying ${bboxes.length} bbox segments (query length: ${query.length})`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'GiratoireChallenge/1.0'
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('[Overpass] HTTP error:', res.status, text.substring(0, 200));
      throw new Error(`Overpass API HTTP ${res.status}`);
    }

    const text = await res.text();
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

async function countRoundabouts(geometry) {
  const coords = geometry.coordinates; // [lon, lat] pairs
  console.log(`[Route] ${coords.length} coordinate points`);

  // Split route into bbox segments (max 12 segments for one query)
  const bboxes = computeSegmentBboxes(coords, 12);

  // If too many segments, split into batches
  const BATCH_SIZE = 12;
  let allElements = [];

  for (let i = 0; i < bboxes.length; i += BATCH_SIZE) {
    const batch = bboxes.slice(i, i + BATCH_SIZE);
    try {
      const data = await queryOverpassBboxes(batch);
      allElements.push(...data.elements);
    } catch (err) {
      console.error(`[Overpass] Batch ${i / BATCH_SIZE + 1} failed:`, err.message);
      // Retry once with smaller batches
      for (const singleBbox of batch) {
        try {
          await delay(5000); // Longer delay for rate-limited retries
          const data = await queryOverpassBboxes([singleBbox]);
          allElements.push(...data.elements);
        } catch (retryErr) {
          console.error('[Overpass] Single bbox retry also failed:', retryErr.message);
        }
      }
    }
    // Delay between batches to avoid rate limits
    if (i + BATCH_SIZE < bboxes.length) await delay(2000);
  }

  // Deduplicate (same way can appear in overlapping bboxes)
  const uniqueElements = new Map();
  for (const el of allElements) {
    if (el.id && !uniqueElements.has(`${el.type}-${el.id}`)) {
      uniqueElements.set(`${el.type}-${el.id}`, el);
    }
  }

  const elements = [...uniqueElements.values()];

  // Build node position lookup (for computing roundabout centroids)
  const nodePositions = new Map();
  for (const el of elements) {
    if (el.type === 'node' && el.lat !== undefined && el.lon !== undefined) {
      nodePositions.set(el.id, { lat: el.lat, lon: el.lon });
    }
  }

  // Deduplicate roundabouts into groups
  const groups = deduplicateRoundabouts(elements);
  console.log(`[Overpass] ${groups.size} roundabout groups in bboxes (before proximity filter)`);

  // Filter: only keep roundabouts whose centroid is within 50m of the route
  let nearCount = 0;
  for (const [gid, ways] of groups) {
    // Compute centroid from all nodes of all ways in this group
    let sumLat = 0, sumLon = 0, count = 0;
    for (const way of ways) {
      for (const nodeId of way.nodes) {
        const pos = nodePositions.get(nodeId);
        if (pos) {
          sumLat += pos.lat;
          sumLon += pos.lon;
          count++;
        }
      }
    }
    if (count === 0) continue;
    const centroidLat = sumLat / count;
    const centroidLon = sumLon / count;

    if (isNearRoute(centroidLat, centroidLon, coords, 50)) {
      nearCount++;
    }
  }

  console.log(`[Result] ${nearCount} roundabouts actually on route (filtered from ${groups.size})`);
  return nearCount;
}

// --- Input sanitization helper ---
function sanitize(str) {
  return str.replace(/[<>"'&;]/g, '').trim();
}

// --- API: Autocomplete city names via Nominatim ---
app.get('/api/autocomplete', autocompleteLimiter, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json([]);

    const url = `https://nominatim.openstreetmap.org/search?` +
      `q=${encodeURIComponent(q)}&format=json&limit=8&countrycodes=fr` +
      `&addressdetails=1&dedupe=1`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'GiratoireChallenge/1.0' }
    });
    const data = await response.json();

    // Filter to keep only places (cities, towns, villages)
    const placeTypes = ['city', 'town', 'village', 'municipality'];
    const results = data
      .filter(item => {
        const placeType = item.address?.city || item.address?.town || item.address?.village || item.address?.municipality;
        return placeType || item.type === 'city' || item.type === 'administrative' || item.class === 'place';
      })
      .map(item => ({
        name: item.address?.city || item.address?.town || item.address?.village || item.address?.municipality || item.display_name.split(',')[0],
        department: item.address?.county || item.address?.state || '',
        displayName: item.display_name.split(',').slice(0, 2).join(','),
        lat: parseFloat(item.lat),
        lon: parseFloat(item.lon)
      }));

    // Deduplicate by name + department
    const seen = new Set();
    const unique = results.filter(r => {
      const key = `${r.name}-${r.department}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    res.json(unique);
  } catch (err) {
    console.error('Autocomplete error:', err);
    res.json([]);
  }
});

// --- API: Search for roundabouts on route ---
app.post('/api/challenge', challengeLimiter, async (req, res) => {
  try {
    let { pseudo, villeDepart, villeArrivee } = req.body;
    if (!pseudo || !villeDepart || !villeArrivee) {
      return res.status(400).json({ error: 'Pseudo, ville de départ et ville d\'arrivée requis' });
    }

    // Sanitize inputs
    pseudo = sanitize(String(pseudo)).substring(0, 20);
    villeDepart = sanitize(String(villeDepart)).substring(0, 100);
    villeArrivee = sanitize(String(villeArrivee)).substring(0, 100);

    if (!pseudo || !villeDepart || !villeArrivee) {
      return res.status(400).json({ error: 'Entrées invalides' });
    }

    if (pseudo.length > 20) {
      return res.status(400).json({ error: 'Pseudo trop long (max 20 caractères)' });
    }

    // 1. Geocode cities
    const from = await geocode(villeDepart);
    await delay(1100); // Nominatim rate limit
    const to = await geocode(villeArrivee);

    if (from.displayName === to.displayName) {
      return res.status(400).json({ error: 'Les deux villes doivent être différentes !' });
    }

    // 2. Get route
    const route = await getRoute(from.lon, from.lat, to.lon, to.lat);

    // 3. Count roundabouts
    const nbRondPoints = await countRoundabouts(route.geometry);

    // 4. Compute distance in km
    const distanceKm = Math.round(route.distance / 1000);

    // 5. Compute ratio (roundabouts per 100km)
    const ratio = distanceKm > 0 ? Math.round((nbRondPoints / distanceKm) * 100 * 10) / 10 : 0;

    // 6. Save result to leaderboard
    const entry = {
      pseudo: pseudo.trim().substring(0, 20),
      villeDepart: from.displayName,
      villeArrivee: to.displayName,
      nbRondPoints,
      distanceKm,
      ratio,
      date: new Date().toISOString()
    };

    const leaderboard = loadLeaderboard();
    leaderboard.push(entry);
    // Sort by number of roundabouts (descending)
    leaderboard.sort((a, b) => b.nbRondPoints - a.nbRondPoints);
    // Keep top 100
    const trimmed = leaderboard.slice(0, 100);
    saveLeaderboard(trimmed);

    res.json({
      ...entry,
      rank: trimmed.findIndex(e => e.date === entry.date) + 1,
      leaderboard: trimmed.slice(0, 20)
    });

  } catch (err) {
    console.error('Challenge error:', err);
    res.status(500).json({ error: err.message || 'Erreur serveur' });
  }
});

// --- API: Get leaderboard ---
app.get('/api/leaderboard', (req, res) => {
  const leaderboard = loadLeaderboard();
  res.json(leaderboard.slice(0, 20));
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`🏁 Giratoire Challenge lancé sur http://localhost:${PORT}`);
});
