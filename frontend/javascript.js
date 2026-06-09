/**
 * RouteRider — Frontend JavaScript
 * ─────────────────────────────────────────────────────────────────────────────
 * ROLE: Thin display layer ONLY.
 *   - Sends fetch() requests to the Python Flask backend (/api/...)
 *   - Draws on the Leaflet map (markers, fit bounds)
 *   - Updates the DOM (stop cards, stats bar, dropdowns, nav panel)
 *
 * ALL logic (geocoding, distance, TSP, OSRM) lives in main.py (Python).
 * This file contains ZERO business logic.
 * ─────────────────────────────────────────────────────────────────────────────
 * MVP #2 additions:
 *   - computeRoute()     — calls GET /api/route, gets TSP order + polyline
 *   - drawRoutePolyline()— draws animated dashed polyline on the Leaflet map
 *   - startNavigation()  — activates nav panel with leg 0 info
 *   - showNavStop()      — updates nav panel for current leg index
 *   - clearRoute()       — removes polyline, resets nav panel
 * ─────────────────────────────────────────────────────────────────────────────
 * LIVE NAV additions:
 *   - startLiveTracking()   — watchPosition → live marker + step snapping
 *   - stopLiveTracking()    — clears GPS watch
 *   - updateLivePosition()  — on each GPS fix: move marker, snap step, check arrival
 *   - haversineJS()         — client-side Haversine for distance checks
 *   - getStepIcon()         — maps OSRM maneuver type → arrow emoji
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Constants ────────────────────────────────────────────────────────────────────
const API  = "";                      // Base URL — Flask serves both frontend + API
const BANGKAL = [14.5649, 121.0147]; // ARRAY [lat, lon] — default map center
const ARRIVAL_RADIUS_KM  = 0.04;     // 40 m  — auto-advance when rider is this close to stop
const STEP_SNAP_RADIUS_KM = 0.10;    // 100 m — snap nav step when rider passes within this

// ARRAY (lookup table) — stop color gradient light-blue → dark-navy (index 0..9)
// Indexed by stop.index - 1; capped at length - 1 for stops beyond 10.
const STOP_COLORS = [
  "#AED6F1", "#85C1E9", "#5DADE2", "#3498DB",
  "#2E86C1", "#2874A6", "#1F618D", "#1A5276",
  "#154360", "#0E2F44"
];

// ── Map State ────────────────────────────────────────────────────────────────────
let map;              // Leaflet map object
let gzMarker = null;  // Leaflet marker for Ground Zero

// OBJECT (hash map) — maps stop_id (string) → Leaflet marker instance
// Allows O(1) lookup when removing or highlighting a specific stop's marker.
let stopMarkers = {};

// ── Route / Navigation State ─────────────────────────────────────────────────────
let routePolyline = null;  // Leaflet polyline drawn on the map

// ARRAY of objects — each element is one leg of the route:
//   { from, to, distance_km, duration_min, steps: [ {instruction, distance_m, lat, lon, type} ] }
// Built from /api/route response and consumed by the navigation panel.
let routeLegs = [];

let navIndex   = 0;      // INTEGER index — current leg pointer into routeLegs[]
let routeActive = false; // BOOLEAN flag — true while route is computed and displayed

// ── Live GPS State ────────────────────────────────────────────────────────────────
let liveMarker   = null;  // Leaflet marker for the rider's live GPS position
let watchId      = null;  // INTEGER — ID returned by navigator.geolocation.watchPosition()
                          //           used to stop tracking with clearWatch(watchId)

// OBJECT {lat, lon} — last GPS fix received from the device
let liveLatLng   = null;

let currentStep  = 0;     // INTEGER index — current step pointer into routeLegs[navIndex].steps[]
let autoRecenter = true;  // BOOLEAN — whether the map auto-follows the rider's position

// ── Debounce ───────────────────────────────────────────────────────────────────
function debounce(fn, delay) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
}

// ── Init ────────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  initMap();
  bindEvents();
  syncFromBackend();  // In case the page reloads mid-session
});

/**
 * initMap — Creates the Leaflet map centered on Bangkal, Makati.
 * Uses OpenStreetMap (free) tiles. No API key required.
 */
function initMap() {
  map = L.map("map", { zoomControl: true }).setView(BANGKAL, 13);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);

  // One-shot center on rider (used before nav starts)
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => map.setView([pos.coords.latitude, pos.coords.longitude], 15),
      () => {}  // silently fall back to Bangkal
    );
  }

  // Stop auto-recentering if rider pans the map manually
  map.on("dragstart", () => { autoRecenter = false; });
}

// ── Event Binding ──────────────────────────────────────────────────────────────
function bindEvents() {
  // Ground Zero input — debounced search
  const gzInput = document.getElementById("gz-input");
  gzInput.addEventListener("input", debounce(() => {
    triggerSearch(gzInput.value.trim(), "gz");
  }, 400));
  gzInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") triggerSearch(gzInput.value.trim(), "gz");
    if (e.key === "Escape") closeDropdown("gz");
  });

  document.getElementById("gz-search-btn").addEventListener("click", () => {
    triggerSearch(gzInput.value.trim(), "gz");
  });

  document.getElementById("gz-clear-btn").addEventListener("click", clearGroundZero);

  // Stop input — debounced search
  const stopInput = document.getElementById("stop-input");
  stopInput.addEventListener("input", debounce(() => {
    triggerSearch(stopInput.value.trim(), "stop");
  }, 400));
  stopInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") triggerSearch(stopInput.value.trim(), "stop");
    if (e.key === "Escape") closeDropdown("stop");
  });

  document.getElementById("stop-search-btn").addEventListener("click", () => {
    triggerSearch(stopInput.value.trim(), "stop");
  });

  // Clear all stops
  document.getElementById("clear-all-btn").addEventListener("click", clearAllStops);

  // Compute button — MVP #2: trigger full route optimization
  document.getElementById("compute-btn").addEventListener("click", computeRoute);

  // Nav panel Prev / Next buttons
  document.getElementById("nav-prev").addEventListener("click", () => {
    if (navIndex > 0) showNavStop(navIndex - 1);
  });
  document.getElementById("nav-next").addEventListener("click", () => {
    if (navIndex < routeLegs.length - 1) {
      showNavStop(navIndex + 1);
    } else {
      endNavigation();
    }
  });

  // Recenter button — snap map back to rider and re-enable auto-follow
  document.getElementById("nav-recenter-btn").addEventListener("click", () => {
    autoRecenter = true;
    if (liveLatLng) map.setView([liveLatLng.lat, liveLatLng.lon], 17, { animate: true });
  });

  // Close dropdowns when clicking outside
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#gz-section")) closeDropdown("gz");
    if (!e.target.closest("#search-section")) closeDropdown("stop");
  });
}

// ── Search Flow (GZ & Stops) ───────────────────────────────────────────────────
/**
 * triggerSearch — calls Python backend /api/search, renders dropdown.
 * @param {string} query - user's text input
 * @param {"gz"|"stop"} type - which input triggered the search
 */
async function triggerSearch(query, type) {
  if (query.length < 2) { closeDropdown(type); return; }

  const dropdown = document.getElementById(`${type === "gz" ? "gz" : "stop"}-dropdown`);
  showLoadingDropdown(dropdown);

  try {
    const res = await fetch(`${API}/api/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();

    if (!res.ok) { showToast(data.error || "Search failed.", "error"); closeDropdown(type); return; }

    renderDropdown(dropdown, data, type);
  } catch {
    showToast("Cannot reach server. Is main.py running?", "error");
    closeDropdown(type);
  }
}

/**
 * renderDropdown — builds dropdown items from Nominatim results (via Python).
 * @param {HTMLElement} dropdown - the dropdown container
 * @param {Array} results - [{name, display_name, lat, lon}, ...]
 * @param {"gz"|"stop"} type - what to do when user clicks a result
 */
function renderDropdown(dropdown, results, type) {
  dropdown.innerHTML = "";

  if (!results.length) {
    dropdown.innerHTML = `<div class="dropdown-empty">No results found. Try a different search.</div>`;
    dropdown.classList.add("open");
    return;
  }

  results.forEach((place) => {
    const item = document.createElement("div");
    item.className = "dropdown-item";
    item.setAttribute("role", "option");
    item.innerHTML = `
      <div class="dropdown-item-name">${escHtml(place.name || place.display_name.split(",")[0])}</div>
      <div class="dropdown-item-detail">${escHtml(place.display_name)}</div>
    `;
    item.addEventListener("click", () => {
      if (type === "gz") handleSetGroundZero(place);
      else handleAddStop(place);
      closeDropdown(type);
    });
    dropdown.appendChild(item);
  });

  dropdown.classList.add("open");
}

function showLoadingDropdown(dropdown) {
  dropdown.innerHTML = `
    <div class="dropdown-loading">
      <div class="spinner"></div> Searching…
    </div>`;
  dropdown.classList.add("open");
}

function closeDropdown(type) {
  const id = type === "gz" ? "gz-dropdown" : "stop-dropdown";
  const d = document.getElementById(id);
  d.classList.remove("open");
}

// ── Ground Zero ────────────────────────────────────────────────────────────────
/**
 * handleSetGroundZero — sends {name, lat, lon} to Python POST /api/ground-zero.
 * On success, Python stores it; JS places the marker.
 */
async function handleSetGroundZero(place) {
  try {
    const res = await fetch(`${API}/api/ground-zero`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: place.name, lat: place.lat, lon: place.lon }),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error, "error"); return; }

    placeGzMarker(data);
    updateGzCard(data);
    document.getElementById("gz-input").value = "";
    updateComputeButton();
  } catch {
    showToast("Cannot reach server. Is main.py running?", "error");
  }
}

function placeGzMarker(gz) {
  if (gzMarker) map.removeLayer(gzMarker);

  const icon = L.divIcon({
    className: "",
    html: `<div class="custom-marker gz-marker" style="width:32px;height:32px;">⊙</div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });

  gzMarker = L.marker([gz.lat, gz.lon], { icon })
    .addTo(map)
    .bindPopup(`<b>Ground Zero</b><br/>${escHtml(gz.name)}`);

  map.panTo([gz.lat, gz.lon]);
}

function updateGzCard(gz) {
  document.getElementById("gz-name-display").textContent = gz.name;
  document.getElementById("gz-coords-display").textContent =
    `${gz.lat.toFixed(5)}, ${gz.lon.toFixed(5)}`;
  document.getElementById("gz-set-card").classList.add("visible");
}

async function clearGroundZero() {
  try {
    await fetch(`${API}/api/ground-zero`, { method: "DELETE" });
    if (gzMarker) { map.removeLayer(gzMarker); gzMarker = null; }
    document.getElementById("gz-set-card").classList.remove("visible");
    document.getElementById("gz-input").value = "";
    updateStats();
    updateComputeButton();
  } catch {
    showToast("Cannot reach server.", "error");
  }
}

// ── Delivery Stops ─────────────────────────────────────────────────────────────
/**
 * handleAddStop — sends {name, lat, lon} to Python POST /api/stops.
 * Python validates, assigns ID and index, returns updated stops list.
 * JS re-renders all markers and the stop cards.
 */
async function handleAddStop(place) {
  try {
    const res = await fetch(`${API}/api/stops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: place.name, lat: place.lat, lon: place.lon }),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error, "error"); return; }

    // data = full updated stops list from Python
    renderAllStopMarkers(data);
    renderStopCards(data);
    document.getElementById("stop-input").value = "";
    fitMapToMarkers();
    updateStats();
    updateComputeButton();
    showToast(`Stop #${data.length} added!`, "success");
  } catch {
    showToast("Cannot reach server. Is main.py running?", "error");
  }
}

/**
 * removeStop — DELETE /api/stops/<id> to Python. Python re-indexes.
 * JS clears all markers then re-draws from the returned list.
 */
async function removeStop(stopId) {
  try {
    const res = await fetch(`${API}/api/stops/${stopId}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) { showToast(data.error, "error"); return; }

    // If a route was computed, clear it — stop order is now stale
    if (routeActive) clearRoute();

    renderAllStopMarkers(data);
    renderStopCards(data);
    fitMapToMarkers();
    updateStats();
    updateComputeButton();
  } catch {
    showToast("Cannot reach server.", "error");
  }
}

async function clearAllStops() {
  try {
    await fetch(`${API}/api/stops`, { method: "DELETE" });

    // Remove all markers from map
    Object.values(stopMarkers).forEach((m) => map.removeLayer(m));
    stopMarkers = {};

    // Clear route if one was computed
    clearRoute();

    renderStopCards([]);
    updateStats();
    updateComputeButton();
  } catch {
    showToast("Cannot reach server.", "error");
  }
}

// ── Markers ────────────────────────────────────────────────────────────────────
/**
 * renderAllStopMarkers — clears all stop markers and re-draws them.
 * Color is interpolated light→dark based on stop index / total stops.
 * Called after every add/remove to keep markers in sync with Python state.
 *
 * @param {Array} stops - full stops list from Python [{id, name, lat, lon, index}, ...]
 */
function renderAllStopMarkers(stops) {
  // Clear existing markers
  Object.values(stopMarkers).forEach((m) => map.removeLayer(m));
  stopMarkers = {};

  stops.forEach((stop) => {
    const colorIndex = Math.min(stop.index - 1, STOP_COLORS.length - 1);
    const color = STOP_COLORS[colorIndex];

    const icon = L.divIcon({
      className: "",
      html: `<div class="custom-marker" style="width:28px;height:28px;background:${color};">${stop.index}</div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });

    const marker = L.marker([stop.lat, stop.lon], { icon })
      .addTo(map)
      .bindPopup(`<b>Stop #${stop.index}</b><br/>${escHtml(stop.name)}`);

    stopMarkers[stop.id] = marker;
  });
}

// ── Stop Cards (Sidebar) ───────────────────────────────────────────────────────
/**
 * renderStopCards — rebuilds the sidebar stop list from Python's stops array.
 * Each card has the stop number, name, coords, and a remove button.
 */
function renderStopCards(stops) {
  const list = document.getElementById("stops-list");
  list.innerHTML = "";

  if (!stops.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="icon">📦</div>
        <p>Set your ground zero first,<br/>then add delivery stops.</p>
      </div>`;
    return;
  }

  stops.forEach((stop) => {
    const colorIndex = Math.min(stop.index - 1, STOP_COLORS.length - 1);
    const color = STOP_COLORS[colorIndex];

    const card = document.createElement("div");
    card.className = "stop-card";
    card.dataset.id = stop.id;
    card.innerHTML = `
      <div class="stop-badge" style="background:${color};">${stop.index}</div>
      <div class="stop-info">
        <div class="stop-name">${escHtml(stop.name)}</div>
        <div class="stop-coords">${stop.lat.toFixed(5)}, ${stop.lon.toFixed(5)}</div>
      </div>
      <button class="stop-remove-btn" data-id="${stop.id}" title="Remove stop" aria-label="Remove stop ${stop.index}">✕</button>
    `;

    card.querySelector(".stop-remove-btn").addEventListener("click", () => {
      removeStop(stop.id);
    });

    list.appendChild(card);
  });
}

// ── Map Helpers ────────────────────────────────────────────────────────────────
function fitMapToMarkers() {
  const points = [];
  if (gzMarker) points.push(gzMarker.getLatLng());
  Object.values(stopMarkers).forEach((m) => points.push(m.getLatLng()));
  if (points.length > 0) {
    map.fitBounds(L.latLngBounds(points), { padding: [40, 40] });
  }
}

// ── Route Computation (MVP #2) ─────────────────────────────────────────────────
/**
 * computeRoute — calls Python GET /api/route.
 * Python runs Nearest-Neighbor TSP then OSRM for real road geometry.
 * JS draws the polyline, reorders markers, and starts navigation.
 */
async function computeRoute() {
  const btn    = document.getElementById("compute-btn");
  const rtb    = document.getElementById("return-to-base-toggle").checked ? "1" : "0";
  btn.disabled = true;
  btn.classList.add("loading");
  btn.textContent = "Computing…";

  clearRoute();

  try {
    const res  = await fetch(`${API}/api/route?return_to_base=${rtb}`);
    const data = await res.json();

    if (!res.ok) {
      showToast(data.error || "Route computation failed.", "error");
      return;
    }
    if (data.osrm_failed) showToast("OSRM unavailable — showing straight-line route.", "warning");

    renderAllStopMarkers(data.ordered_stops);
    renderStopCards(data.ordered_stops);
    drawRoutePolyline(data.geometry);

    if (data.geometry.length > 1)
      map.fitBounds(L.latLngBounds(data.geometry), { padding: [60, 60] });

    routeLegs  = data.legs;
    routeActive = true;

    document.getElementById("stat-stops").textContent = data.ordered_stops.length;
    document.getElementById("stat-dist").textContent  = data.total_km > 0 ? data.total_km : "—";
    document.getElementById("stat-time").textContent  = data.total_min > 0 ? data.total_min : "—";

    // — Show route panel with comparison + summary
    if (data.comparison) renderComparison(data.comparison);
    if (data.legs && data.legs.length) renderRouteSummary(data.legs);
    document.getElementById("route-panel").style.display = "block";

    if (routeLegs.length > 0) startNavigation();

    btn.textContent = "Recompute Route →";
    showToast(`Route optimized! ${data.ordered_stops.length} stops · ${data.total_km} km · ${data.total_min} min`, "success");
  } catch {
    showToast("Cannot reach server. Is main.py running?", "error");
    btn.textContent = "Compute Optimal Route →";
  } finally {
    btn.classList.remove("loading");
    btn.disabled = false;
  }
}

/**
 * drawRoutePolyline — renders the OSRM road-network path on the map.
 * Uses a dashed blue line that animates via CSS.
 * @param {Array} geometry - [[lat,lon], ...] from /api/route
 */
function drawRoutePolyline(geometry) {
  if (routePolyline) {
    map.removeLayer(routePolyline);
    routePolyline = null;
  }
  if (!geometry || geometry.length < 2) return;

  routePolyline = L.polyline(geometry, {
    color: "#3b82f6",
    weight: 4,
    opacity: 0.85,
    dashArray: "10, 8",
    className: "route-polyline",
  }).addTo(map);
}

/**
 * clearRoute — removes the polyline, hides the nav panel, and stops GPS watch.
 */
function clearRoute() {
  stopLiveTracking();
  if (routePolyline) { map.removeLayer(routePolyline); routePolyline = null; }
  routeLegs = []; navIndex = 0; routeActive = false;
  document.getElementById("nav-panel").classList.remove("active");
  document.getElementById("route-panel").style.display = "none";
  document.querySelectorAll(".custom-marker.nav-active").forEach(
    (el) => el.classList.remove("nav-active")
  );
}

// ── Navigation Panel ───────────────────────────────────────────────────────────
/**
 * startNavigation — shows the nav panel at leg 0 and begins live GPS tracking.
 */
function startNavigation() {
  navIndex = 0;
  currentStep = 0;
  autoRecenter = true;
  document.getElementById("nav-panel").classList.add("active");
  showNavStop(0);
  startLiveTracking();
}

/**
 * showNavStop — updates the nav panel for leg `index`.
 * Highlights the destination marker and resets the step pointer.
 */
function showNavStop(index) {
  navIndex = index;
  currentStep = 0;          // always reset to step 0 when switching legs
  const leg = routeLegs[index];
  const isLast = index === routeLegs.length - 1;

  document.getElementById("nav-header").textContent =
    `Stop ${index + 1} of ${routeLegs.length}`;
  document.getElementById("nav-stop-label").textContent = leg.to;
  document.getElementById("nav-dist").textContent =
    `${leg.distance_km} km`;

  // Show step 0 instruction (live tracking will update this from GPS)
  const step = leg.steps[0];
  document.getElementById("nav-instruction").textContent =
    step ? step.instruction : "Proceed to destination";
  document.getElementById("nav-turn-icon").textContent =
    step ? getStepIcon(step.type) : "↑";
  document.getElementById("nav-to-turn").textContent =
    step ? formatDist(step.distance_m) : "—";

  document.getElementById("nav-prev").disabled = index === 0;
  document.getElementById("nav-next").textContent = isLast ? "✓ Done" : "✓ Arrived →";

  // Highlight destination marker
  document.querySelectorAll(".custom-marker").forEach((el) => el.classList.remove("nav-active"));
  const destStop = Object.values(stopMarkers)[index];
  if (destStop) {
    if (!liveLatLng) map.panTo(destStop.getLatLng(), { animate: true, duration: 0.5 });
    const markerEl = destStop.getElement()?.querySelector(".custom-marker");
    if (markerEl) markerEl.classList.add("nav-active");
  }
}

/**
 * endNavigation — stops GPS watch, hides panel, shows completion toast.
 */
function endNavigation() {
  stopLiveTracking();
  document.getElementById("nav-panel").classList.remove("active");
  document.querySelectorAll(".custom-marker.nav-active").forEach(
    (el) => el.classList.remove("nav-active")
  );
  showToast("🎉 All deliveries complete!", "success");
}

// ── Live GPS Tracking ──────────────────────────────────────────────────────────
/**
 * startLiveTracking — begins watchPosition.
 * Creates a pulsing blue dot marker for the rider's real-time position.
 */
function startLiveTracking() {
  if (!navigator.geolocation) {
    showToast("GPS not available on this device.", "warning");
    setLiveDotOff();
    return;
  }

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      updateLivePosition(pos.coords.latitude, pos.coords.longitude);
    },
    (err) => {
      console.warn("[GPS]", err.message);
      setLiveDotOff();
      if (err.code === 1) showToast("GPS denied — enable location to use live nav.", "warning");
    },
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 10000 }
  );
}

/**
 * stopLiveTracking — clears the GPS watch and removes the live marker.
 */
function stopLiveTracking() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (liveMarker) {
    map.removeLayer(liveMarker);
    liveMarker = null;
  }
  liveLatLng = null;
  setLiveDotOff();
}

/**
 * updateLivePosition — called on every GPS fix.
 * 1. Moves / creates the live marker.
 * 2. If navigating: snaps to nearest upcoming step, updates instructions.
 * 3. Auto-advances to next leg if within ARRIVAL_RADIUS_KM of destination.
 */
function updateLivePosition(lat, lon) {
  liveLatLng = { lat, lon };

  // Create or move the live position marker
  if (!liveMarker) {
    const icon = L.divIcon({
      className: "",
      html: `<div class="live-location-marker"></div>`,
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
    liveMarker = L.marker([lat, lon], { icon, zIndexOffset: 1000 }).addTo(map);
  } else {
    liveMarker.setLatLng([lat, lon]);
  }

  // Auto-follow map
  if (autoRecenter && routeActive) {
    map.setView([lat, lon], map.getZoom() < 16 ? 16 : map.getZoom(), { animate: true });
  }

  // Set live dot green
  const dot = document.querySelector(".live-dot-pulse");
  if (dot) { dot.classList.remove("gps-off"); }
  const lbl = document.getElementById("nav-live-label");
  if (lbl) lbl.textContent = "LIVE";

  // ── Navigation step snapping ────────────────────────────────────────────────
  if (!routeActive || !routeLegs.length) return;

  const leg = routeLegs[navIndex];
  const steps = leg.steps || [];

  // Distance from rider to the stop destination
  const destStop = Object.values(stopMarkers)[navIndex];
  let distToStop = null;
  if (destStop) {
    const ll = destStop.getLatLng();
    distToStop = haversineJS(lat, lon, ll.lat, ll.lng);
    document.getElementById("nav-dist").textContent = formatDist(distToStop * 1000);
  }

  // Auto-advance if arrived at stop
  if (distToStop !== null && distToStop < ARRIVAL_RADIUS_KM) {
    showToast(`📍 Arrived at ${escHtml(leg.to)}!`, "success");
    if (navIndex < routeLegs.length - 1) {
      showNavStop(navIndex + 1);
    } else {
      endNavigation();
    }
    return;
  }

  // ── Step Snapping: Linear scan over upcoming steps (ARRAY traversal) ──────────
  // We scan the steps[] ARRAY starting from currentStep (not from 0)
  // to avoid re-checking steps the rider has already passed.
  let bestStep = currentStep;  // index of the closest step found so far
  let bestDist = Infinity;     // distance to that step (running minimum)

  for (let i = currentStep; i < steps.length; i++) {
    const s = steps[i];  // OBJECT — one navigation step from the ARRAY

    // Skip steps that have no GPS coordinates (e.g. some OSRM steps omit location)
    if (s.lat == null || s.lon == null) continue;

    // Haversine distance from rider → this step's maneuver point
    const d = haversineJS(lat, lon, s.lat, s.lon);

    if (d < bestDist) { bestDist = d; bestStep = i; }  // Update running minimum

    // Early exit: if steps are now getting farther (route is sorted spatially),
    // no need to scan further — saves unnecessary iterations
    if (i > currentStep + 3 && d > bestDist) break;
  }

  // Advance the step pointer if rider has passed within STEP_SNAP_RADIUS_KM
  // Math.min() caps it so we never go past the last step in the ARRAY
  if (bestDist < STEP_SNAP_RADIUS_KM && bestStep >= currentStep) {
    currentStep = Math.min(bestStep + 1, steps.length - 1);
  }

  // Display the current step instruction
  const activeStep = steps[currentStep];
  if (activeStep) {
    document.getElementById("nav-instruction").textContent = activeStep.instruction;
    document.getElementById("nav-turn-icon").textContent = getStepIcon(activeStep.type);

    // Distance-to-turn: straight line from rider to step maneuver point
    if (activeStep.lat != null) {
      const dturn = haversineJS(lat, lon, activeStep.lat, activeStep.lon);
      document.getElementById("nav-to-turn").textContent = formatDist(dturn * 1000);
    }
  }
}

// ── Live Tracking Helpers ──────────────────────────────────────────────────────
/** Client-side Haversine — mirrors Python's haversine(). Returns km. */
function haversineJS(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Format meters nicely: "50 m" or "1.2 km" */
function formatDist(meters) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

/**
 * getStepIcon — OBJECT used as a HASH MAP (dictionary lookup).
 * Maps OSRM maneuver type string → emoji icon in O(1).
 * This is a classic use of an object as a key-value lookup table.
 */
function getStepIcon(type) {
  // OBJECT (hash map) — key: OSRM maneuver type, value: direction emoji
  const icons = {
    depart:        "🚀",  // Starting the journey
    arrive:        "📍",  // Reached destination
    "turn":        "↩",  // General turn
    "new name":    "↑",  // Road name changes, keep going straight
    roundabout:    "🔄", // Enter roundabout
    merge:         "↗",  // Merge onto road
    fork:          "⑂",  // Road forks
    "end of road": "↩",  // Dead end — must turn
    "use lane":    "↑",  // Lane guidance
    continue:      "↑",  // Continue straight
  };
  return icons[type] || "↑";  // O(1) hash map lookup; default ↑ if type unknown
}

/** Set the live dot to "no GPS" state */
function setLiveDotOff() {
  const dot = document.querySelector(".live-dot-pulse");
  if (dot) dot.classList.add("gps-off");
  const lbl = document.getElementById("nav-live-label");
  if (lbl) lbl.textContent = "NO GPS";
}

// ── Algorithm Comparison Panel (MVP #3) ───────────────────────────────────────────────
/**
 * renderComparison — builds the algorithm comparison table from /api/route response.
 * @param {Object} comparison - {nearest_neighbor, two_opt, brute_force, best}
 */
function renderComparison(comparison) {
  const wrap = document.getElementById("comparison-table-wrap");
  const ALGO_KEYS = ["nearest_neighbor", "two_opt", "brute_force"];
  const BEST_LABELS = {
    nearest_neighbor: "NN", two_opt: "2-Opt", brute_force: "BF"
  };

  let rows = "";
  for (const key of ALGO_KEYS) {
    const a      = comparison[key];
    const isBest = comparison.best === key;
    const rowCls = isBest ? " class=\"best-row\"" : "";

    if (a.skipped) {
      rows += `<tr${rowCls}>
        <td><div class="algo-name">${escHtml(a.label)}</div>
            <code class="complexity-badge">${escHtml(a.complexity)}</code></td>
        <td colspan="2" class="skipped-cell">${escHtml(a.skip_reason || "Skipped")}</td>
      </tr>`;
    } else {
      rows += `<tr${rowCls}>
        <td>
          <div class="algo-name">${escHtml(a.label)}
            ${isBest ? `<span class="best-badge">★ BEST</span>` : ""}
          </div>
          <code class="complexity-badge">${escHtml(a.complexity)}</code>
        </td>
        <td class="algo-km">${a.haversine_km} km</td>
        <td class="algo-ms">${a.runtime_ms} ms</td>
      </tr>`;
    }
  }

  wrap.innerHTML = `
    <table class="comparison-table">
      <thead><tr><th>Algorithm</th><th>Distance</th><th>Runtime</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ── Route Summary Panel (MVP #3) ─────────────────────────────────────────────────────
/**
 * renderRouteSummary — builds collapsible per-leg turn-by-turn directions.
 * @param {Array} legs - legs array from /api/route response
 */
function renderRouteSummary(legs) {
  const container = document.getElementById("route-summary-legs");
  container.innerHTML = "";

  legs.forEach((leg, i) => {
    const section = document.createElement("div");
    section.className = "summary-leg";

    const header = document.createElement("div");
    header.className = "summary-leg-header";
    header.innerHTML = `
      <div class="summary-leg-info">
        <span class="summary-leg-num">${i + 1}</span>
        <div>
          <div class="summary-leg-to">${escHtml(leg.to)}</div>
          <div class="summary-leg-meta">${leg.distance_km} km · ~${leg.duration_min} min</div>
        </div>
      </div>
      <span class="summary-expand-icon">▾</span>`;

    const body = document.createElement("div");
    body.className = "summary-leg-body";
    body.innerHTML = leg.steps.length
      ? leg.steps.map(s =>
          `<div class="summary-step">
            <span class="step-dist">${s.distance_m}m</span>
            <span class="step-inst">${escHtml(s.instruction)}</span>
          </div>`).join("")
      : `<div class="summary-step"><span class="step-inst">Proceed to destination</span></div>`;

    header.addEventListener("click", () => section.classList.toggle("expanded"));
    section.append(header, body);
    container.appendChild(section);
  });
}

// ── Stats Bar ──────────────────────────────────────────────────────────────────
/**
 * updateStats — fetches computed stats from Python GET /api/stats.
 * Python uses Haversine formula. JS just displays the result.
 */
async function updateStats() {
  try {
    const res = await fetch(`${API}/api/stats`);
    const data = await res.json();
    document.getElementById("stat-stops").textContent = data.stop_count;
    document.getElementById("stat-dist").textContent =
      data.total_km > 0 ? data.total_km : "—";
    document.getElementById("stat-time").textContent =
      data.total_min > 0 ? data.total_min : "—";
  } catch { /* fail silently for stats */ }
}

// ── Compute Button State ───────────────────────────────────────────────────────
async function updateComputeButton() {
  try {
    const [gzRes, stopsRes] = await Promise.all([
      fetch(`${API}/api/ground-zero`),
      fetch(`${API}/api/stops`),
    ]);
    const gz = await gzRes.json();
    const stops = await stopsRes.json();
    const btn = document.getElementById("compute-btn");
    btn.disabled = !(gz && stops.length >= 2);
  } catch { /* keep button state as-is */ }
}

// ── Sync from Backend (page reload recovery) ───────────────────────────────────
async function syncFromBackend() {
  try {
    const [gzRes, stopsRes] = await Promise.all([
      fetch(`${API}/api/ground-zero`),
      fetch(`${API}/api/stops`),
    ]);
    const gz = await gzRes.json();
    const stops = await stopsRes.json();

    if (gz) { placeGzMarker(gz); updateGzCard(gz); }
    if (stops.length) { renderAllStopMarkers(stops); renderStopCards(stops); fitMapToMarkers(); }
    updateStats();
    updateComputeButton();
  } catch { /* server not ready yet, ignore */ }
}

// ── Toast Notifications ────────────────────────────────────────────────────────
/**
 * showToast — displays a temporary notification.
 * @param {string} msg - message text
 * @param {"success"|"error"|"warning"} type - styling type
 */
function showToast(msg, type = "success") {
  const container = document.getElementById("toast");
  const item = document.createElement("div");
  item.className = `toast-item ${type}`;
  item.textContent = msg;
  container.appendChild(item);
  setTimeout(() => item.remove(), 3500);
}

// ── Utilities ──────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
