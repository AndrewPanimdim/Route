"""
RouteRider — Multi-Stop Delivery Route Optimizer
Backend: Flask (Python) — ALL logic lives here
Data Structures: dict (ground_zero), list (stops), dict (stop_index hash map)
Algorithms: Haversine, Nearest Neighbor TSP O(n²), 2-Opt O(n²k), Brute-Force O(n!)
"""
import uuid, time, math, os, threading, itertools
import requests
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND = os.path.join(BASE_DIR, "..", "frontend")

app = Flask(__name__, static_folder=FRONTEND, static_url_path="")
CORS(app)

# ── In-Memory State ─────────────────────────────────────────────────────────────
# Data structures chosen for O(1) access patterns:
#
#   ground_zero → DICT (key-value store)
#     Stores the rider's starting point: {name, lat, lon}
#     Why dict? Named fields, fast attribute access, easy JSON serialization.
#
#   stops → LIST (ordered dynamic array)
#     Stores delivery stops in the order they were added.
#     Why list? Preserves insertion order; index-based access for TSP algorithms.
#
#   stop_index → DICT (hash map)
#     Maps stop_id (UUID string) → stop dict for O(1) lookup by ID.
#     Why hash map? Avoids O(n) linear scan when deleting a stop by ID.
#
#   MAX_STOPS → constant cap to keep brute-force (O(n!)) tractable.

ground_zero: dict | None  = None       # DICT  — {name, lat, lon} or None
stops: list[dict]         = []         # LIST  — ordered array of stop dicts
stop_index: dict[str, dict] = {}       # HASH MAP — stop_id → stop dict (O(1) lookup)
MAX_STOPS = 10                         # Constant — brute-force cap

_nom_lock = threading.Lock()
_last_nom_call = 0.0


# ── Helper: Haversine Distance ──────────────────────────────────────────────────
def haversine(lat1, lon1, lat2, lon2) -> float:
    """
    Great-circle distance in km between two GPS points.
    Uses the Haversine formula. Time/Space: O(1).
    """
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def route_distance(start: dict, ordered: list, return_to_base: bool = False) -> float:
    """Total Haversine distance (km) for a route. O(n)."""
    waypoints = [start] + list(ordered)
    if return_to_base:
        waypoints.append(start)
    return sum(
        haversine(waypoints[i]["lat"], waypoints[i]["lon"],
                  waypoints[i+1]["lat"], waypoints[i+1]["lon"])
        for i in range(len(waypoints) - 1)
    )


def compute_stats() -> dict:
    """Straight-line distance + time estimate (25 km/h avg) for current route."""
    if not stops:
        return {"stop_count": 0, "total_km": 0.0, "total_min": 0}
    waypoints = []
    if ground_zero:
        waypoints.append((ground_zero["lat"], ground_zero["lon"]))
    for s in stops:
        waypoints.append((s["lat"], s["lon"]))
    km = sum(haversine(*waypoints[i], *waypoints[i+1]) for i in range(len(waypoints)-1))
    return {"stop_count": len(stops), "total_km": round(km, 2), "total_min": int(km/25*60)}


def nominatim_search(query: str, limit: int = 6) -> list[dict]:
    """
    Geocode a place name via Nominatim (free OSM geocoder).
    Rate-limited to 1 req/sec per Nominatim policy.
    Filtered to Philippines (countrycodes=ph).
    """
    global _last_nom_call
    with _nom_lock:
        gap = time.time() - _last_nom_call
        if gap < 1.0:
            time.sleep(1.0 - gap)
        _last_nom_call = time.time()

    try:
        r = requests.get(
            "https://nominatim.openstreetmap.org/search",
            params={"q": query, "format": "json", "limit": limit,
                    "countrycodes": "ph", "addressdetails": 1},
            headers={"User-Agent": "RouteRider/1.0 (DSA Finals Project)"},
            timeout=8
        )
        r.raise_for_status()
        raw = r.json()
    except Exception as e:
        print(f"[Nominatim] Error: {e}")
        return []

    results = []
    for item in raw:
        try:
            results.append({
                "name": item.get("name") or item.get("display_name","")[:50],
                "display_name": item.get("display_name",""),
                "lat": float(item["lat"]),
                "lon": float(item["lon"]),
            })
        except (KeyError, ValueError):
            continue
    return results


def rebuild_index():
    """
    Rebuild the stop_index HASH MAP from the stops LIST. O(n).

    Called after every add/remove operation.
    This keeps the hash map in sync with the list so lookups
    remain O(1) instead of requiring O(n) list scans.

    Data Structure: DICT comprehension → hash map {stop_id: stop_dict}
    """
    global stop_index
    # DICT comprehension — builds a hash map: UUID string → stop dict
    # Access pattern: stop_index[stop_id] → O(1) average case
    stop_index = {s["id"]: s for s in stops}


def ph_bounds(lat, lon) -> bool:
    """Loose Philippines bounding box check."""
    return 4.5 <= lat <= 21.2 and 116.9 <= lon <= 126.6


# ── Serve Frontend ──────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return send_from_directory(FRONTEND, "index.html")


# ── Search (Geocoding) ──────────────────────────────────────────────────────────
@app.route("/api/search")
def search():
    """GET /api/search?q=<text> — returns list of matching places from Nominatim."""
    q = request.args.get("q", "").strip()
    if len(q) < 2:
        return jsonify({"error": "Type at least 2 characters."}), 400
    return jsonify(nominatim_search(q)), 200


# ── Ground Zero ─────────────────────────────────────────────────────────────────
@app.route("/api/ground-zero", methods=["GET"])
def get_gz():
    """GET /api/ground-zero — returns current start point or null."""
    return jsonify(ground_zero), 200


@app.route("/api/ground-zero", methods=["POST"])
def set_gz():
    """POST /api/ground-zero — sets rider's start point. Body: {name,lat,lon}."""
    global ground_zero
    d = request.get_json(silent=True) or {}
    name = str(d.get("name","")).strip()
    try:
        lat, lon = float(d["lat"]), float(d["lon"])
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "lat and lon must be valid numbers."}), 400
    if not name:
        return jsonify({"error": "name is required."}), 400
    if not ph_bounds(lat, lon):
        return jsonify({"error": "Coordinates must be within the Philippines."}), 400
    ground_zero = {"name": name, "lat": lat, "lon": lon}
    return jsonify(ground_zero), 200


@app.route("/api/ground-zero", methods=["DELETE"])
def clear_gz():
    """DELETE /api/ground-zero — clears the start point."""
    global ground_zero
    ground_zero = None
    return jsonify({"message": "Ground zero cleared."}), 200


# ── Delivery Stops ──────────────────────────────────────────────────────────────
@app.route("/api/stops", methods=["GET"])
def get_stops():
    """GET /api/stops — returns ordered stops list."""
    return jsonify(stops), 200


@app.route("/api/stops", methods=["POST"])
def add_stop():
    """
    POST /api/stops — adds a delivery stop. Body: {name,lat,lon}
    Data structure: list.append() O(1). Re-indexes: O(n).
    Enforces max 10 stops and no duplicate coordinates.
    """
    global stops
    if len(stops) >= MAX_STOPS:
        return jsonify({"error": f"Maximum {MAX_STOPS} stops reached."}), 409
    d = request.get_json(silent=True) or {}
    name = str(d.get("name","")).strip()
    try:
        lat, lon = float(d["lat"]), float(d["lon"])
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "lat and lon must be valid numbers."}), 400
    if not name:
        return jsonify({"error": "name is required."}), 400
    if not ph_bounds(lat, lon):
        return jsonify({"error": "Coordinates must be within the Philippines."}), 400
    if any(abs(s["lat"]-lat)<0.0001 and abs(s["lon"]-lon)<0.0001 for s in stops):
        return jsonify({"error": "This stop is already in your list."}), 409
    new_stop = {"id": str(uuid.uuid4()), "name": name, "lat": lat, "lon": lon, "index": len(stops)+1}
    stops.append(new_stop)
    rebuild_index()
    return jsonify(stops), 201


@app.route("/api/stops/<stop_id>", methods=["DELETE"])
def remove_stop(stop_id):
    """
    DELETE /api/stops/<stop_id> — removes one stop, re-indexes remainder.
    O(1) lookup via hash map, O(n) list rebuild.
    """
    global stops
    if stop_id not in stop_index:
        return jsonify({"error": "Stop not found."}), 404
    stops = [s for s in stops if s["id"] != stop_id]
    for i, s in enumerate(stops):
        s["index"] = i + 1
    rebuild_index()
    return jsonify(stops), 200


@app.route("/api/stops", methods=["DELETE"])
def clear_stops():
    """DELETE /api/stops — removes all stops."""
    global stops, stop_index
    stops, stop_index = [], {}
    return jsonify({"message": "All stops cleared."}), 200


# ── Stats ───────────────────────────────────────────────────────────────────────
@app.route("/api/stats")
def get_stats():
    """GET /api/stats — returns {stop_count, total_km, total_min} using Haversine."""
    return jsonify(compute_stats()), 200


# Cap brute-force at 8 stops — 8! = 40,320 permutations (manageable).
# 9! = 362,880 — noticeably slow; 10! = 3.6M — too slow for a web app.
BRUTE_FORCE_CAP = 8


# ── Algorithm 1: Nearest Neighbor Greedy Heuristic ──────────────────────────────
def nearest_neighbor_tsp(start: dict, waypoints: list[dict]) -> list[dict]:
    """
    Nearest Neighbor TSP — Greedy heuristic, Time: O(n²), Space: O(n).

    Strategy: From the current position, always move to the closest
    unvisited stop. Simple and fast but not always optimal.

    Data Structures:
      unvisited → LIST  : mutable working copy; shrinks each iteration O(n)
      visited   → SET   : hash set for O(1) membership checks
      ordered   → LIST  : result array built up one stop at a time
    """
    # LIST — mutable working copy of all stops to visit
    unvisited: list[dict] = list(waypoints)

    # SET (hash set) — tracks visited IDs for O(1) duplicate check
    visited: set[str] = set()

    # LIST — the final ordered route we are building
    ordered: list[dict] = []

    current_lat, current_lon = start["lat"], start["lon"]

    while unvisited:
        # Scan remaining stops → pick the closest one (O(n) per iteration)
        closest = min(
            unvisited,
            key=lambda s: haversine(current_lat, current_lon, s["lat"], s["lon"])
        )

        ordered.append(closest)          # Add to result LIST
        visited.add(closest["id"])       # Mark as visited in SET — O(1)

        # Rebuild unvisited list excluding visited IDs — O(n)
        unvisited = [s for s in unvisited if s["id"] not in visited]

        # Move current position to the stop we just visited
        current_lat, current_lon = closest["lat"], closest["lon"]

    return ordered  # LIST of stops in greedy-optimal order


# ── Algorithm 2: 2-Opt Local Search Improvement ────────────────────────────────
def two_opt_improve(start: dict, ordered: list[dict], return_to_base: bool = False) -> list[dict]:
    """
    2-Opt Improvement — Local search, Time: O(n² × k), Space: O(n).

    Strategy: Try reversing every sub-segment of the route. If reversing
    segment [i..j] shortens the total distance, keep it. Repeat until
    no improvement is found (local optimum).

    Data Structure:
      best      → LIST : the current best route (mutated each improvement)
      candidate → LIST : a temporary reversed-segment copy for comparison
    """
    # LIST — start from the Nearest Neighbor result
    best: list[dict] = list(ordered)
    n = len(best)
    improved = True

    while improved:          # Keep looping until no improvement found
        improved = False

        for i in range(n - 1):
            for j in range(i + 2, n):
                # Build a candidate LIST by reversing the sub-segment [i+1 .. j]
                # LIST slicing: O(n) to create the reversed candidate
                candidate = best[:i + 1] + best[i + 1:j + 1][::-1] + best[j + 1:]

                # Compare Haversine distances — keep whichever is shorter
                if route_distance(start, candidate, return_to_base) < route_distance(start, best, return_to_base):
                    best = candidate   # Replace best LIST with improved route
                    improved = True    # Signal: keep looping

    return best  # LIST — locally optimal route


# ── Algorithm 3: Brute-Force Exhaustive Search ─────────────────────────────────
def brute_force_tsp(start: dict, waypoints: list[dict], return_to_base: bool = False) -> tuple:
    """
    Brute-Force TSP — Exhaustive search, Time: O(n!), Space: O(n).

    Strategy: Try every possible ordering (permutation) of stops and
    return the one with the shortest Haversine distance. Guaranteed
    optimal but exponentially slow — only runs when n <= BRUTE_FORCE_CAP.

    Data Structures:
      permutations → GENERATOR (lazy iterator) : O(n) memory at any time
                     itertools generates each permutation on-demand —
                     never stores all n! at once.
      best_order   → LIST : the shortest route found so far
      best_dist    → float : current minimum distance (acts as a running min)
    """
    best_order: list = []
    best_dist: float = float("inf")  # Start with "infinity" as the baseline

    # GENERATOR — itertools.permutations is lazy: O(n) memory, not O(n!)
    # Each `perm` is a TUPLE of stops in one specific order
    for perm in itertools.permutations(waypoints):
        # Convert TUPLE → LIST to pass to route_distance
        d = route_distance(start, list(perm), return_to_base)

        if d < best_dist:        # Found a shorter route
            best_dist  = d
            best_order = list(perm)  # Save best LIST so far

    return best_order, best_dist  # TUPLE return: (ordered LIST, float distance)


def osrm_route(coords: list[tuple[float, float]]) -> dict | None:
    """
    Call the free public OSRM API to get a real road-network route.
    coords: list of (lat, lon) tuples — OSRM expects lon,lat order.
    Returns parsed route dict or None on failure.
    """
    # OSRM expects longitude,latitude order
    coord_str = ";".join(f"{lon},{lat}" for lat, lon in coords)
    url = (
        f"http://router.project-osrm.org/route/v1/driving/{coord_str}"
        f"?overview=full&geometries=geojson&steps=true&annotations=false"
    )
    try:
        r = requests.get(url, headers={"User-Agent": "RouteRider/1.0"}, timeout=10)
        r.raise_for_status()
        data = r.json()
        if data.get("code") != "Ok" or not data.get("routes"):
            return None
        return data["routes"][0]
    except Exception as e:
        print(f"[OSRM] Error: {e}")
        return None


@app.route("/api/route")
def compute_route():
    """
    GET /api/route?return_to_base=0|1
    MVP #3 pipeline:
      1. Nearest Neighbor TSP — O(n²)
      2. 2-Opt Improvement    — O(n² × k)
      3. Brute-Force (n≤8)   — O(n!)
    Picks the best (shortest Haversine), routes via OSRM.
    Returns comparison object for all 3 algorithms.
    """
    return_to_base = request.args.get("return_to_base", "0") == "1"
    if not ground_zero:
        return jsonify({"error": "Set a ground zero start point first."}), 400
    if len(stops) < 2:
        return jsonify({"error": "Add at least 2 delivery stops to compute a route."}), 400

    comparison: dict = {}

    # ── 1. Nearest Neighbor ─────────────────────────────────────────────────────
    t0 = time.perf_counter()
    nn_order = nearest_neighbor_tsp(ground_zero, stops)
    nn_ms    = round((time.perf_counter() - t0) * 1000, 3)
    nn_dist  = route_distance(ground_zero, nn_order, return_to_base)
    comparison["nearest_neighbor"] = {
        "label": "Nearest Neighbor (Greedy)",
        "complexity": "O(n²)",
        "haversine_km": round(nn_dist, 3),
        "runtime_ms": nn_ms,
        "order": [s["name"] for s in nn_order],
        "skipped": False,
    }

    # ── 2. 2-Opt Improvement ────────────────────────────────────────────────────
    t0 = time.perf_counter()
    two_order = two_opt_improve(ground_zero, nn_order, return_to_base)
    two_ms    = round((time.perf_counter() - t0) * 1000, 3)
    two_dist  = route_distance(ground_zero, two_order, return_to_base)
    comparison["two_opt"] = {
        "label": "2-Opt Improvement",
        "complexity": "O(n² × k)",
        "haversine_km": round(two_dist, 3),
        "runtime_ms": two_ms,
        "order": [s["name"] for s in two_order],
        "skipped": False,
    }

    # ── 3. Brute-Force (capped) ─────────────────────────────────────────────────
    if len(stops) <= BRUTE_FORCE_CAP:
        t0 = time.perf_counter()
        bf_order, bf_dist = brute_force_tsp(ground_zero, stops, return_to_base)
        bf_ms = round((time.perf_counter() - t0) * 1000, 3)
        comparison["brute_force"] = {
            "label": "Brute-Force Permutation",
            "complexity": "O(n!)",
            "haversine_km": round(bf_dist, 3),
            "runtime_ms": bf_ms,
            "order": [s["name"] for s in bf_order],
            "skipped": False,
        }
    else:
        bf_order, bf_dist = None, float("inf")
        comparison["brute_force"] = {
            "label": "Brute-Force Permutation",
            "complexity": "O(n!)",
            "haversine_km": None,
            "runtime_ms": None,
            "order": [],
            "skipped": True,
            "skip_reason": f"Skipped — {len(stops)} stops exceeds cap of {BRUTE_FORCE_CAP}",
        }

    # ── Pick best algorithm ─────────────────────────────────────────────────────
    candidates = {
        "nearest_neighbor": (nn_order, nn_dist),
        "two_opt": (two_order, two_dist),
    }
    if bf_order is not None:
        candidates["brute_force"] = (bf_order, bf_dist)
    best_key   = min(candidates, key=lambda k: candidates[k][1])
    best_order = list(candidates[best_key][0])
    comparison["best"] = best_key

    # Re-assign indices
    for i, s in enumerate(best_order):
        best_order[i] = {**dict(s), "index": i + 1}

    # ── OSRM road routing on the winning order ──────────────────────────────────
    waypoints = [(ground_zero["lat"], ground_zero["lon"])] + \
                [(s["lat"], s["lon"]) for s in best_order]
    if return_to_base:
        waypoints.append((ground_zero["lat"], ground_zero["lon"]))

    osrm_data = osrm_route(waypoints)

    if osrm_data is None:
        total_km = round(sum(
            haversine(*waypoints[i], *waypoints[i + 1])
            for i in range(len(waypoints) - 1)
        ), 2)
        return jsonify({
            "ordered_stops": best_order,
            "geometry": [[lat, lon] for lat, lon in waypoints],
            "legs": [], "total_km": total_km,
            "total_min": int(total_km / 25 * 60),
            "return_to_base": return_to_base,
            "comparison": comparison,
            "osrm_failed": True,
        }), 200

    # ── Parse OSRM geometry ─────────────────────────────────────────────────────
    geometry = [
        [coord[1], coord[0]]
        for coord in osrm_data["geometry"]["coordinates"]
    ]

    all_nodes = [ground_zero] + best_order
    if return_to_base:
        all_nodes.append(ground_zero)

    legs_out = []
    for i, leg in enumerate(osrm_data.get("legs", [])):
        steps_out = []
        for step in leg.get("steps", []):
            maneuver      = step.get("maneuver", {})
            instruction   = step.get("name", "")
            maneuver_type = maneuver.get("type", "")
            maneuver_mod  = maneuver.get("modifier", "")
            # Extract GPS position of this maneuver point [lon, lat] → convert to lat/lon
            m_loc = maneuver.get("location", [None, None])
            step_lat = m_loc[1] if len(m_loc) > 1 else None
            step_lon = m_loc[0] if len(m_loc) > 0 else None
            if maneuver_type == "depart":
                instruction = f"Head {maneuver_mod or 'straight'} on {step.get('name','')}"
            elif maneuver_type == "arrive":
                instruction = f"Arrive at {all_nodes[i+1]['name']}"
            elif maneuver_type in ("turn", "new name"):
                instruction = f"Turn {maneuver_mod} onto {step.get('name','road')}"
            elif maneuver_type == "roundabout":
                instruction = f"Take roundabout exit {maneuver.get('exit','')}"
            elif maneuver_type == "merge":
                instruction = f"Merge {maneuver_mod}"
            elif instruction == "":
                instruction = f"{maneuver_type.capitalize()} {maneuver_mod}".strip()
            dist_m = round(step.get("distance", 0))
            if dist_m > 0:
                steps_out.append({
                    "instruction": instruction,
                    "distance_m": dist_m,
                    "lat": step_lat,
                    "lon": step_lon,
                    "type": maneuver_type,
                })
        legs_out.append({
            "from": all_nodes[i]["name"],
            "to":   all_nodes[i + 1]["name"],
            "distance_km":  round(leg.get("distance", 0) / 1000, 2),
            "duration_min": round(leg.get("duration", 0) / 60),
            "steps": steps_out,
        })

    total_m = osrm_data.get("distance", 0)
    total_s = osrm_data.get("duration", 0)
    return jsonify({
        "ordered_stops": best_order,
        "geometry":      geometry,
        "legs":          legs_out,
        "total_km":      round(total_m / 1000, 2),
        "total_min":     round(total_s / 60),
        "return_to_base": return_to_base,
        "comparison":    comparison,
    }), 200


# ── Run ─────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("=" * 50)
    print("  RouteRider Backend is running!")
    print("  Open: http://localhost:5000")
    print("=" * 50)
    app.run(debug=True, host="0.0.0.0", port=5000)
