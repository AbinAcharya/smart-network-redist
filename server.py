"""Local API and static server for the India traffic redistribution prototype."""

from __future__ import annotations

import heapq
import getpass
import ctypes
import json
import math
import mimetypes
import os
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from copy import deepcopy
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from ctypes import wintypes
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlencode, unquote, urlparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
APP_PORT = 8012
DEMAND_LIMIT = 10_000
PROVIDER_TIMEOUT_SECONDS = 15
NOMINATIM_MIN_INTERVAL_SECONDS = 1.0
TOMTOM_CACHE_SECONDS = 45
TOMTOM_SAMPLE_POINTS_PER_ROUTE = 3
TOMTOM_SAMPLE_WORKERS = 5
TOMTOM_SEARCH_LIMIT = 100
TOMTOM_CATEGORY_RESULTS_PER_QUERY = 100
TOMTOM_SEARCH_WORKERS = 3
MAX_ROUTE_CANDIDATES = 9
MAX_DISPLAYED_ROUTES = 3
_geocode_lock = threading.Lock()
_last_geocode_at = 0.0
_traffic_cache_lock = threading.Lock()
_traffic_cache: dict[tuple[float, float], tuple[float, dict]] = {}
_active_reservations_lock = threading.Lock()
_active_reservations: dict[str, int] = {}
USER_AGENT = "FlowstateNavigationPrototype/0.1 (local development demo)"

REGIONS = [
    {"id": "AP", "name": "Andhra Pradesh", "kind": "State", "capital": "Amaravati", "lat": 16.5062, "lon": 80.6480},
    {"id": "AR", "name": "Arunachal Pradesh", "kind": "State", "capital": "Itanagar", "lat": 27.0844, "lon": 93.6053},
    {"id": "AS", "name": "Assam", "kind": "State", "capital": "Dispur", "lat": 26.1433, "lon": 91.7898},
    {"id": "BR", "name": "Bihar", "kind": "State", "capital": "Patna", "lat": 25.5941, "lon": 85.1376},
    {"id": "CG", "name": "Chhattisgarh", "kind": "State", "capital": "Raipur", "lat": 21.2514, "lon": 81.6296},
    {"id": "GA", "name": "Goa", "kind": "State", "capital": "Panaji", "lat": 15.4909, "lon": 73.8278},
    {"id": "GJ", "name": "Gujarat", "kind": "State", "capital": "Gandhinagar", "lat": 23.2156, "lon": 72.6369},
    {"id": "HR", "name": "Haryana", "kind": "State", "capital": "Chandigarh", "lat": 30.7333, "lon": 76.7794},
    {"id": "HP", "name": "Himachal Pradesh", "kind": "State", "capital": "Shimla", "lat": 31.1048, "lon": 77.1734},
    {"id": "JH", "name": "Jharkhand", "kind": "State", "capital": "Ranchi", "lat": 23.3441, "lon": 85.3096},
    {"id": "KA", "name": "Karnataka", "kind": "State", "capital": "Bengaluru", "lat": 12.9716, "lon": 77.5946},
    {"id": "KL", "name": "Kerala", "kind": "State", "capital": "Thiruvananthapuram", "lat": 8.5241, "lon": 76.9366},
    {"id": "MP", "name": "Madhya Pradesh", "kind": "State", "capital": "Bhopal", "lat": 23.2599, "lon": 77.4126},
    {"id": "MH", "name": "Maharashtra", "kind": "State", "capital": "Mumbai", "lat": 19.0760, "lon": 72.8777},
    {"id": "MN", "name": "Manipur", "kind": "State", "capital": "Imphal", "lat": 24.8170, "lon": 93.9368},
    {"id": "ML", "name": "Meghalaya", "kind": "State", "capital": "Shillong", "lat": 25.5788, "lon": 91.8933},
    {"id": "MZ", "name": "Mizoram", "kind": "State", "capital": "Aizawl", "lat": 23.7271, "lon": 92.7176},
    {"id": "NL", "name": "Nagaland", "kind": "State", "capital": "Kohima", "lat": 25.6751, "lon": 94.1086},
    {"id": "OD", "name": "Odisha", "kind": "State", "capital": "Bhubaneswar", "lat": 20.2961, "lon": 85.8245},
    {"id": "PB", "name": "Punjab", "kind": "State", "capital": "Chandigarh", "lat": 30.7333, "lon": 76.7794},
    {"id": "RJ", "name": "Rajasthan", "kind": "State", "capital": "Jaipur", "lat": 26.9124, "lon": 75.7873},
    {"id": "SK", "name": "Sikkim", "kind": "State", "capital": "Gangtok", "lat": 27.3314, "lon": 88.6138},
    {"id": "TN", "name": "Tamil Nadu", "kind": "State", "capital": "Chennai", "lat": 13.0827, "lon": 80.2707},
    {"id": "TS", "name": "Telangana", "kind": "State", "capital": "Hyderabad", "lat": 17.3850, "lon": 78.4867},
    {"id": "TR", "name": "Tripura", "kind": "State", "capital": "Agartala", "lat": 23.8315, "lon": 91.2868},
    {"id": "UP", "name": "Uttar Pradesh", "kind": "State", "capital": "Lucknow", "lat": 26.8467, "lon": 80.9462},
    {"id": "UK", "name": "Uttarakhand", "kind": "State", "capital": "Dehradun", "lat": 30.3165, "lon": 78.0322},
    {"id": "WB", "name": "West Bengal", "kind": "State", "capital": "Kolkata", "lat": 22.5726, "lon": 88.3639},
    {"id": "AN", "name": "Andaman and Nicobar Islands", "kind": "Union Territory", "capital": "Sri Vijaya Puram", "lat": 11.6234, "lon": 92.7265},
    {"id": "CH", "name": "Chandigarh", "kind": "Union Territory", "capital": "Chandigarh", "lat": 30.7333, "lon": 76.7794},
    {"id": "DH", "name": "Dadra and Nagar Haveli and Daman and Diu", "kind": "Union Territory", "capital": "Daman", "lat": 20.3974, "lon": 72.8328},
    {"id": "DL", "name": "Delhi", "kind": "Union Territory", "capital": "New Delhi", "lat": 28.6139, "lon": 77.2090},
    {"id": "JK", "name": "Jammu and Kashmir", "kind": "Union Territory", "capital": "Srinagar (summer) / Jammu (winter)", "lat": 34.0837, "lon": 74.7973},
    {"id": "LA", "name": "Ladakh", "kind": "Union Territory", "capital": "Leh", "lat": 34.1526, "lon": 77.5771},
    {"id": "LD", "name": "Lakshadweep", "kind": "Union Territory", "capital": "Kavaratti", "lat": 10.5667, "lon": 72.6417},
    {"id": "PY", "name": "Puducherry", "kind": "Union Territory", "capital": "Puducherry", "lat": 11.9416, "lon": 79.8083},
]

NETWORK = {
    "region": "Delhi",
    "data_notice": (
        "All 28 states and 8 union territories are selectable. Their displayed "
        "corridors, capacities and traffic counts are schematic demo data, not "
        "verified road geometry or live traffic."
    ),
    "origin": "origin",
    "destination": "destination",
    "nodes": [
        {"id": "origin", "label": "Demo start", "lat": 28.6129, "lon": 77.2295},
        {"id": "a1", "label": "Corridor A midpoint", "lat": 28.6200, "lon": 77.2215},
        {"id": "b1", "label": "Corridor B midpoint", "lat": 28.6280, "lon": 77.2350},
        {"id": "c1", "label": "Corridor C midpoint", "lat": 28.6060, "lon": 77.2450},
        {"id": "destination", "label": "Demo destination", "lat": 28.6315, "lon": 77.2167},
    ],
    "edges": [
        {
            "id": "a1",
            "from": "origin",
            "to": "a1",
            "route_id": "A",
            "route_name": "Corridor A",
            "capacity": 18,
            "current_vehicles": 50,
            "travel_time_min": 7.0,
        },
        {
            "id": "a2",
            "from": "a1",
            "to": "destination",
            "route_id": "A",
            "route_name": "Corridor A",
            "capacity": 18,
            "current_vehicles": 50,
            "travel_time_min": 6.0,
        },
        {
            "id": "b1",
            "from": "origin",
            "to": "b1",
            "route_id": "B",
            "route_name": "Corridor B",
            "capacity": 24,
            "current_vehicles": 5,
            "travel_time_min": 9.0,
        },
        {
            "id": "b2",
            "from": "b1",
            "to": "destination",
            "route_id": "B",
            "route_name": "Corridor B",
            "capacity": 24,
            "current_vehicles": 5,
            "travel_time_min": 8.0,
        },
        {
            "id": "c1",
            "from": "origin",
            "to": "c1",
            "route_id": "C",
            "route_name": "Corridor C",
            "capacity": 18,
            "current_vehicles": 3,
            "travel_time_min": 8.0,
        },
        {
            "id": "c2",
            "from": "c1",
            "to": "destination",
            "route_id": "C",
            "route_name": "Corridor C",
            "capacity": 18,
            "current_vehicles": 3,
            "travel_time_min": 8.0,
        },
    ],
}


def get_network(region_id: str = "DL") -> dict:
    region = next((item for item in REGIONS if item["id"] == region_id), None)
    if region is None:
        raise InvalidRegion(f"unknown state or union territory: {region_id}")

    network = deepcopy(NETWORK)
    network["region"] = region["name"]
    network["region_id"] = region["id"]
    network["region_kind"] = region["kind"]
    network["capital"] = region["capital"]
    delta_lat = region["lat"] - 28.6129
    delta_lon = region["lon"] - 77.2295
    for node in network["nodes"]:
        node["lat"] = round(node["lat"] + delta_lat, 4)
        node["lon"] = round(node["lon"] + delta_lon, 4)
        if node["id"] == "origin":
            node["label"] = f"{region['capital']} demo start"
        elif node["id"] == "destination":
            node["label"] = f"{region['capital']} demo destination"
    return network


class InvalidDemand(ValueError):
    """Raised when a redistribution request has an invalid vehicle count."""


class InvalidRegion(ValueError):
    """Raised when a requested state or union territory is not listed."""


class InvalidLocation(ValueError):
    """Raised when a place query or coordinate is invalid."""


class ProviderError(RuntimeError):
    """Raised when an external geocoding or routing service fails."""


def _provider_json(url: str) -> dict | list:
    request = Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urlopen(request, timeout=PROVIDER_TIMEOUT_SECONDS) as response:
            body = response.read(8_000_001)
        if len(body) > 8_000_000:
            raise ProviderError("The mapping service returned an unexpectedly large response.")
        return json.loads(body)
    except HTTPError as error:
        raise ProviderError(
            f"The mapping service returned HTTP {error.code}. Please try again later."
        ) from error
    except (URLError, TimeoutError, OSError) as error:
        raise ProviderError(
            "The mapping service could not be reached. Check your internet connection and try again."
        ) from error
    except json.JSONDecodeError as error:
        raise ProviderError("The mapping service returned an invalid response.") from error


def search_places(query: str) -> list[dict]:
    global _last_geocode_at
    if not isinstance(query, str) or not 2 <= len(query.strip()) <= 200:
        raise InvalidLocation("Enter a place name between 2 and 200 characters.")
    query = query.strip()
    with _geocode_lock:
        delay = NOMINATIM_MIN_INTERVAL_SECONDS - (time.monotonic() - _last_geocode_at)
        if delay > 0:
            time.sleep(delay)
        _last_geocode_at = time.monotonic()

    params = urlencode({
        "format": "jsonv2",
        "addressdetails": 1,
        "limit": 5,
        "countrycodes": "in",
        "q": query,
    })
    response = _provider_json(f"https://nominatim.openstreetmap.org/search?{params}")
    if not isinstance(response, list):
        raise ProviderError("The place search returned an invalid response.")

    places = []
    for item in response:
        try:
            lat, lon = float(item["lat"]), float(item["lon"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (6 <= lat <= 38 and 68 <= lon <= 98):
            continue
        places.append({
            "label": str(item.get("display_name", query))[:300],
            "lat": lat,
            "lon": lon,
        })
    return places


def suggest_places(query: str) -> list[dict]:
    key = os.environ.get("TOMTOM_API_KEY", "").strip()
    if not key:
        raise ProviderError("TomTom place suggestions are not configured.")
    if not isinstance(query, str) or not 2 <= len(query.strip()) <= 100:
        raise InvalidLocation("Type at least 2 characters to get place suggestions.")

    params = urlencode({
        "key": key,
        "typeahead": "true",
        "countrySet": "IN",
        "limit": 5,
        "language": "en-US",
    })
    data = _provider_json(
        f"https://api.tomtom.com/search/2/search/{quote(query.strip(), safe='')}.json?{params}"
    )
    if not isinstance(data, dict) or not isinstance(data.get("results"), list):
        raise ProviderError("TomTom returned an invalid place-suggestions response.")

    places = []
    for item in data["results"]:
        if not isinstance(item, dict):
            continue
        position = item.get("position")
        address = item.get("address")
        poi = item.get("poi")
        if not isinstance(position, dict) or not isinstance(address, dict):
            continue
        try:
            lat, lon = float(position["lat"]), float(position["lon"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (6 <= lat <= 38 and 68 <= lon <= 98):
            continue
        country_code = address.get("countryCode")
        if not isinstance(country_code, str) or country_code.upper() != "IN":
            continue
        address_text = address.get("freeformAddress")
        address_label = address_text.strip() if isinstance(address_text, str) else ""
        poi_name = poi.get("name", "").strip() if isinstance(poi, dict) and isinstance(
            poi.get("name"), str
        ) else ""
        label = f"{poi_name}, {address_label}" if poi_name and address_label else (
            poi_name or address_label
        )
        if label:
            places.append({"label": label[:300], "lat": lat, "lon": lon})
    return places


NEARBY_CATEGORIES = {
    "restaurants": (
        "restaurant", "café", "coffee shop", "café/pub", "bar", "pub", "nightlife",
    ),
    "things": (
        "park", "park recreation area", "museum", "important tourist attraction",
        "amusement park", "zoo",
    ),
    "shopping": (
        "mall", "shopping center", "supermarkets hypermarkets",
        "jewelry, clocks watches",
    ),
    "hospitals": ("hospital", "hospital/polyclinic", "clinic", "medical center"),
    "fuel": ("petrol station", "electric vehicle station"),
    "atm": ("ATM",),
}


def _tomtom_place_result(item: object) -> dict | None:
    if not isinstance(item, dict):
        return None
    position = item.get("position")
    address = item.get("address")
    poi = item.get("poi")
    if not isinstance(position, dict) or not isinstance(address, dict):
        return None
    try:
        lat, lon = float(position["lat"]), float(position["lon"])
    except (KeyError, TypeError, ValueError):
        return None
    if not (6 <= lat <= 38 and 68 <= lon <= 98):
        return None
    country_code = address.get("countryCode")
    if not isinstance(country_code, str) or country_code.upper() != "IN":
        return None
    address_text = address.get("freeformAddress")
    address_label = address_text.strip() if isinstance(address_text, str) else ""
    poi_name = poi.get("name", "").strip() if isinstance(poi, dict) and isinstance(
        poi.get("name"), str
    ) else ""
    label = f"{poi_name}, {address_label}" if poi_name and address_label else (
        poi_name or address_label
    )
    if not label:
        return None
    categories = poi.get("categories", []) if isinstance(poi, dict) else []
    category_label = next(
        (value for value in categories if isinstance(value, str) and value.strip()),
        "",
    )
    return {
        "id": str(item.get("id", ""))[:120],
        "label": label[:300],
        "lat": lat,
        "lon": lon,
        "category": category_label[:80],
    }


def _tomtom_atm_result(item: object) -> bool:
    if not isinstance(item, dict):
        return False
    poi = item.get("poi")
    if not isinstance(poi, dict):
        return False
    name = poi.get("name", "")
    name = name.casefold() if isinstance(name, str) else ""
    categories = poi.get("categories", [])
    if not isinstance(categories, list):
        return False
    categories = {
        category.strip().casefold()
        for category in categories
        if isinstance(category, str)
    }
    return bool(
        categories.intersection({"automatic teller machine", "cash dispenser"})
        or ("atm" in name and "bank" in categories)
    )


def _tomtom_search_results(
    service: str,
    query: str,
    params: dict[str, object],
    max_results: int | None = None,
) -> list[object]:
    results = []
    offset = 0
    seen_pages = set()
    while True:
        page_limit = min(TOMTOM_SEARCH_LIMIT, max_results) if max_results else TOMTOM_SEARCH_LIMIT
        page_params = {**params, "limit": page_limit, "ofs": offset}
        data = _provider_json(
            f"https://api.tomtom.com/search/2/{service}/"
            f"{quote(query, safe='')}.json?{urlencode(page_params)}"
        )
        if not isinstance(data, dict) or not isinstance(data.get("results"), list):
            raise ProviderError("TomTom returned an invalid nearby places response.")
        page = data["results"]
        if not page:
            break
        signature = json.dumps(page, sort_keys=True, separators=(",", ":"))
        if signature in seen_pages:
            raise ProviderError("TomTom repeated a nearby results page; search could not be completed.")
        seen_pages.add(signature)
        results.extend(page)
        if max_results is not None and len(results) >= max_results:
            break
        if len(page) < TOMTOM_SEARCH_LIMIT:
            break
        offset += len(page)
    return results


def _nearby_distance_metres(
    start_lat: float, start_lon: float, end_lat: float, end_lon: float
) -> float:
    radians = math.radians
    latitude_delta = radians(end_lat - start_lat)
    longitude_delta = radians(end_lon - start_lon)
    latitude1, latitude2 = radians(start_lat), radians(end_lat)
    a = (
        math.sin(latitude_delta / 2) ** 2
        + math.cos(latitude1) * math.cos(latitude2)
        * math.sin(longitude_delta / 2) ** 2
    )
    a = min(1.0, max(0.0, a))
    return 6_371_000 * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _merge_nearby_results(
    items: list[object], lat: float, lon: float, radius: int
) -> list[dict]:
    collected = {}
    for item in items:
        place = _tomtom_place_result(item)
        if place is None or _nearby_distance_metres(
            lat, lon, place["lat"], place["lon"]
        ) > radius:
            continue
        key = ("id", place["id"]) if place["id"] else (
            "place", round(place["lat"], 6), round(place["lon"], 6),
            place["label"].casefold(),
        )
        collected.setdefault(key, place)
    return sorted(
        collected.values(),
        key=lambda place: _nearby_distance_metres(lat, lon, place["lat"], place["lon"]),
    )


def _validate_nearby_radius(radius: int) -> None:
    if isinstance(radius, bool) or not isinstance(radius, int) or not 500 <= radius <= 50_000:
        raise InvalidLocation("Search radius must be between 500 and 50,000 metres.")


def nearby_places(category: str, lat: float, lon: float, radius: int = 10_000) -> list[dict]:
    key = os.environ.get("TOMTOM_API_KEY", "").strip()
    if not key:
        raise ProviderError("TomTom place search is not configured.")
    if category not in NEARBY_CATEGORIES:
        raise InvalidLocation("Choose a supported nearby-place category.")
    lat, lon = _coordinate({"lat": lat, "lon": lon}, "Search center")
    _validate_nearby_radius(radius)
    params = {
        "key": key,
        "lat": f"{lat:.6f}",
        "lon": f"{lon:.6f}",
        "radius": radius,
        "countrySet": "IN",
        "language": "en-US",
    }
    service = "search" if category == "atm" else "categorySearch"
    if category == "atm":
        params["idxSet"] = "POI"
    queries = NEARBY_CATEGORIES[category]
    with ThreadPoolExecutor(max_workers=min(TOMTOM_SEARCH_WORKERS, len(queries))) as executor:
        futures = [
            executor.submit(
                _tomtom_search_results,
                service,
                query,
                params,
                TOMTOM_CATEGORY_RESULTS_PER_QUERY,
            )
            for query in queries
        ]
        items = [
            item
            for future in as_completed(futures)
            for item in future.result()
        ]
    if category == "atm":
        items = [item for item in items if _tomtom_atm_result(item)]
    return _merge_nearby_results(items, lat, lon, radius)


def search_nearby_places(
    query: str, lat: float, lon: float, radius: int = 10_000
) -> list[dict]:
    key = os.environ.get("TOMTOM_API_KEY", "").strip()
    if not key:
        raise ProviderError("TomTom place search is not configured.")
    if not isinstance(query, str) or not 2 <= len(query.strip()) <= 100:
        raise InvalidLocation("Enter a nearby place search between 2 and 100 characters.")
    lat, lon = _coordinate({"lat": lat, "lon": lon}, "Search center")
    _validate_nearby_radius(radius)
    params = {
        "key": key,
        "lat": f"{lat:.6f}",
        "lon": f"{lon:.6f}",
        "radius": radius,
        "countrySet": "IN",
        "idxSet": "POI",
        "language": "en-US",
    }
    items = _tomtom_search_results("search", query.strip(), params)
    return _merge_nearby_results(items, lat, lon, radius)


def reverse_geocode(lat: float, lon: float) -> str | None:
    key = os.environ.get("TOMTOM_API_KEY", "").strip()
    if not key:
        raise ProviderError("TomTom place search is not configured.")
    lat, lon = _coordinate({"lat": lat, "lon": lon}, "Map location")
    params = urlencode({"key": key, "language": "en-US"})
    data = _provider_json(
        "https://api.tomtom.com/search/2/reverseGeocode/"
        f"{lat:.6f},{lon:.6f}.json?{params}"
    )
    if not isinstance(data, dict) or not isinstance(data.get("addresses"), list):
        raise ProviderError("TomTom returned an invalid address response.")
    for item in data["addresses"]:
        if not isinstance(item, dict):
            continue
        address = item.get("address")
        if not isinstance(address, dict):
            continue
        country_code = address.get("countryCode")
        address_text = address.get("freeformAddress")
        if (isinstance(country_code, str) and country_code.upper() == "IN"
                and isinstance(address_text, str) and address_text.strip()):
            return address_text.strip()[:300]
    return None


def _coordinate(value: object, label: str) -> tuple[float, float]:
    if not isinstance(value, dict):
        raise InvalidLocation(f"{label} must include latitude and longitude.")
    lat, lon = value.get("lat"), value.get("lon")
    if (isinstance(lat, bool) or isinstance(lon, bool)
            or not isinstance(lat, (int, float)) or not isinstance(lon, (int, float))
            or not 6 <= lat <= 38 or not 68 <= lon <= 98):
        raise InvalidLocation(f"{label} must be a valid coordinate in India.")
    return float(lat), float(lon)


def _maneuver_instruction(step: dict) -> str:
    maneuver = step.get("maneuver") or {}
    kind = maneuver.get("type", "continue")
    modifier = maneuver.get("modifier", "")
    road = step.get("name") or ""
    if kind == "depart":
        instruction = "Start"
    elif kind == "arrive":
        instruction = "Arrive at your destination"
    elif kind in ("roundabout", "rotary"):
        instruction = "Enter the roundabout"
    elif kind in ("exit roundabout", "exit rotary"):
        instruction = "Leave the roundabout"
    elif kind in ("merge", "fork", "on ramp", "off ramp"):
        instruction = kind.capitalize()
    elif kind in ("turn", "end of road", "roundabout turn") and modifier:
        instruction = f"Turn {modifier}"
    else:
        instruction = "Continue"
    if road and kind not in ("arrive",) and road.lower() not in instruction.lower():
        instruction = f"{instruction} onto {road}"
    return instruction


def _route_signature(geometry: list) -> tuple:
    if not geometry:
        return ()
    stride = max(1, len(geometry) // 24)
    return tuple(
        (round(point[0], 3), round(point[1], 3))
        for point in geometry[::stride]
        if isinstance(point, list) and len(point) >= 2
    )


def _route_corridor_key(geometry: list) -> str:
    if not geometry:
        return ""
    # Sample 5 points to identify the corridor across different A-B pairs
    # but rounded to 3 decimal places (~110m) to group similar paths.
    indices = [0, len(geometry) // 4, len(geometry) // 2, 3 * len(geometry) // 4, -1]
    sampled = [geometry[i] for i in indices]
    return "|".join(f"{round(p[0], 3)},{round(p[1], 3)}" for p in sampled)


def _format_osrm_route(candidate: dict, index: int) -> dict | None:
    geometry = candidate.get("geometry", {}).get("coordinates", [])
    if len(geometry) < 2:
        return None
    instructions = []
    for leg in candidate.get("legs", []):
        for step in leg.get("steps", []):
            maneuver = step.get("maneuver") or {}
            location = maneuver.get("location")
            if not isinstance(location, list) or len(location) != 2:
                continue
            instructions.append({
                "text": _maneuver_instruction(step),
                "distance_m": max(0, round(step.get("distance", 0))),
                "location": [location[1], location[0]],
            })
    return {
        "id": f"route-{index + 1}",
        "corridor_key": _route_corridor_key(geometry),
        "label": "Fastest estimate" if index == 0 else f"Alternative {index}",
        "distance_km": round(candidate.get("distance", 0) / 1000, 1),
        "duration_min": max(1, round(candidate.get("duration", 0) / 60)),
        "points": [[point[1], point[0]] for point in geometry if len(point) >= 2],
        "instructions": instructions,
    }


def _alternative_waypoints(start_lat: float, start_lon: float,
                           end_lat: float, end_lon: float) -> list[tuple[float, float]]:
    midpoint_lat = (start_lat + end_lat) / 2
    midpoint_lon = (start_lon + end_lon) / 2
    meters_per_latitude_degree = 111_320
    meters_per_longitude_degree = max(
        1, meters_per_latitude_degree * abs(math.cos(math.radians(midpoint_lat)))
    )
    delta_x = (end_lon - start_lon) * meters_per_longitude_degree
    delta_y = (end_lat - start_lat) * meters_per_latitude_degree
    distance = (delta_x**2 + delta_y**2) ** 0.5
    if distance < 250:
        return []

    offset = min(max(distance * 0.1, 1_500), 25_000)
    normal_x = -delta_y / distance
    normal_y = delta_x / distance
    waypoints = [(midpoint_lat, midpoint_lon)]
    for direction in (1, -1):
        lat = midpoint_lat + direction * normal_y * offset / meters_per_latitude_degree
        lon = midpoint_lon + direction * normal_x * offset / meters_per_longitude_degree
        if 6 <= lat <= 38 and 68 <= lon <= 98:
            waypoints.append((lat, lon))
    return waypoints


def get_routes(start: object, destination: object) -> dict:
    start_lat, start_lon = _coordinate(start, "Starting point")
    end_lat, end_lon = _coordinate(destination, "Destination")
    if abs(start_lat - end_lat) < 0.00001 and abs(start_lon - end_lon) < 0.00001:
        raise InvalidLocation("Starting point and destination must be different.")

    coordinates = f"{start_lon},{start_lat};{end_lon},{end_lat}"
    params = urlencode({
        "alternatives": 3,
        "steps": "true",
        "overview": "full",
        "geometries": "geojson",
    })
    response = _provider_json(
        f"https://router.project-osrm.org/route/v1/driving/{coordinates}?{params}"
    )
    if not isinstance(response, dict) or response.get("code") != "Ok":
        raise ProviderError("No drivable route was found between those places.")

    candidates = response.get("routes")
    if not isinstance(candidates, list):
        raise ProviderError("The routing service returned no route options.")
    candidates = sorted(candidates, key=lambda route: route.get("duration", float("inf")))
    routes = []
    seen_geometries = set()
    fastest_duration = min(
        (route.get("duration", float("inf")) for route in candidates),
        default=float("inf"),
    )

    def add_candidates(
        route_candidates: list[dict], corridor_index: int | None = None
    ) -> None:
        for candidate in sorted(
            route_candidates, key=lambda route: route.get("duration", float("inf"))
        ):
            if len(routes) >= MAX_ROUTE_CANDIDATES:
                return
            geometry = candidate.get("geometry", {}).get("coordinates", [])
            signature = _route_signature(geometry)
            route = _format_osrm_route(candidate, len(routes))
            if (route is None or not signature or signature in seen_geometries
                    or candidate.get("duration", float("inf")) > fastest_duration * 2.25):
                continue

            # Apply active load penalty (+15 seconds per active vehicle on this corridor)
            with _active_reservations_lock:
                load = _active_reservations.get(route["corridor_key"], 0)
                if load > 0:
                    route["duration_min"] += round((load * 15) / 60, 1)
                    route["active_vehicles"] = load

            seen_geometries.add(signature)
            route["id"] = f"route-{len(routes) + 1}"
            route["label"] = "Fastest estimate" if not routes else f"Alternative {len(routes)}"
            route["_corridor_index"] = corridor_index
            routes.append(route)

    add_candidates(candidates)
    waypoints = _alternative_waypoints(start_lat, start_lon, end_lat, end_lon)
    alternative_errors = 0
    alternative_requests = []
    for corridor_index, (via_lat, via_lon) in enumerate(waypoints):
        if len(routes) >= MAX_ROUTE_CANDIDATES:
            break
        via_coordinates = (
            f"{start_lon},{start_lat};{via_lon},{via_lat};{end_lon},{end_lat}"
        )
        via_params = urlencode({
            "steps": "true",
            "overview": "full",
            "geometries": "geojson",
            "radiuses": "1000;1000;1000",
        })
        url = (
            f"https://router.project-osrm.org/route/v1/driving/"
            f"{via_coordinates}?{via_params}"
        )
        alternative_requests.append((corridor_index, url))

    if alternative_requests:
        with ThreadPoolExecutor(max_workers=len(alternative_requests)) as executor:
            futures = {
                corridor_index: executor.submit(_provider_json, url)
                for corridor_index, url in alternative_requests
            }
            for corridor_index, _ in alternative_requests:
                try:
                    alternative = futures[corridor_index].result()
                except ProviderError:
                    alternative_errors += 1
                    continue
                if isinstance(alternative, dict) and alternative.get("code") == "Ok":
                    alternative_routes = alternative.get("routes", [])
                    if isinstance(alternative_routes, list):
                        add_candidates(alternative_routes, corridor_index)
    if not routes:
        raise ProviderError("The routing service did not return usable route geometry.")

    routes.sort(key=lambda route: route["duration_min"])
    traffic = enrich_routes_with_traffic(routes)
    ranked_routes = sorted(
        routes,
        key=lambda route: (
            route.get("live_eta_min") is None,
            route.get("live_eta_min") or route["duration_min"],
        ),
    )
    selected_routes = [ranked_routes[0]]
    selected_route_ids = {ranked_routes[0]["id"]}
    for corridor_index in range(len(waypoints)):
        if len(selected_routes) >= MAX_DISPLAYED_ROUTES:
            break
        route = next(
            (
                candidate for candidate in ranked_routes
                if candidate.get("_corridor_index") == corridor_index
                and candidate["id"] not in selected_route_ids
            ),
            None,
        )
        if route is not None:
            selected_routes.append(route)
            selected_route_ids.add(route["id"])
    for route in ranked_routes:
        if len(selected_routes) >= MAX_DISPLAYED_ROUTES:
            break
        if route["id"] not in selected_route_ids:
            selected_routes.append(route)
            selected_route_ids.add(route["id"])
    selected_routes.sort(
        key=lambda route: (
            route.get("live_eta_min") is None,
            route.get("live_eta_min") or route["duration_min"],
        )
    )

    selected_states = [
        route.get("traffic", {}).get("state", "unavailable")
        for route in selected_routes
    ]
    sampled_segments = sum(
        route.get("traffic", {}).get("sampled_segments", 0)
        for route in selected_routes
    )
    if "failed_samples" in traffic:
        expected_samples = sum(
            route.get("traffic", {}).get(
                "expected_samples", len(_route_sample_points(route))
            )
            for route in selected_routes
        )
        traffic["sampled_segments"] = sampled_segments
        traffic["failed_samples"] = max(0, expected_samples - sampled_segments)
        traffic["state"] = (
            "live" if all(state == "live" for state in selected_states)
            else "partial" if sampled_segments
            else "unavailable"
        )
        if traffic["state"] == "unavailable":
            traffic["notice"] = (
                "TomTom traffic could not be sampled for the selected routes. "
                "Route times remain non-live estimates."
            )
    else:
        traffic["sampled_segments"] = sampled_segments
    if alternative_errors:
        traffic["alternatives_notice"] = (
            "Some alternate-route searches failed; showing the routes that were available."
        )
    for index, route in enumerate(selected_routes):
        route["id"] = f"route-{index + 1}"
        route["label"] = "Fastest estimate" if index == 0 else f"Alternative {index}"
        route.pop("_corridor_index", None)
    return {
        "routes": selected_routes,
        "traffic": traffic,
    }


def get_traffic_status() -> dict:
    return {
        "provider": "TomTom Traffic Flow",
        "configured": bool(os.environ.get("TOMTOM_API_KEY", "").strip()),
        "pilot_area": "Kolkata, West Bengal",
        "state": "configured" if os.environ.get("TOMTOM_API_KEY", "").strip() else "setup_required",
        "notice": (
            "Live flow data is sampled from route segments; this does not represent every road or all traffic."
        ),
    }


def configure_tomtom_key() -> bool:
    if os.environ.get("TOMTOM_API_KEY", "").strip():
        return True
    try:
        saved_key = _load_tomtom_key()
    except (OSError, RuntimeError, ValueError) as error:
        raise RuntimeError(
            "Could not load the saved TomTom key securely. Remove the saved "
            "credential and enter the key again."
        ) from error
    if saved_key:
        os.environ["TOMTOM_API_KEY"] = saved_key
        print("Loaded TomTom key saved for this Windows account.")
        return True
    if not sys.stdin.isatty():
        return False
    key = getpass.getpass("TomTom API key (input hidden; Enter to skip): ").strip()
    if key:
        try:
            _save_tomtom_key(key)
        except (OSError, RuntimeError) as error:
            raise RuntimeError(
                "Could not securely save the TomTom key for future runs. "
                "The key was not saved; check Windows account access and try again."
            ) from error
        os.environ["TOMTOM_API_KEY"] = key
        print("TomTom key saved encrypted for this Windows account.")
        return True
    return False


def _tomtom_key_path() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        raise RuntimeError("Windows local application data is not available.")
    return Path(local_app_data) / "Flowstate" / "tomtom-key.dpapi"


def _dpapi_transform(data: bytes, *, decrypt: bool) -> bytes:
    if os.name != "nt":
        raise RuntimeError("Encrypted TomTom key storage requires Windows DPAPI.")

    class DataBlob(ctypes.Structure):
        _fields_ = [
            ("cbData", wintypes.DWORD),
            ("pbData", ctypes.POINTER(ctypes.c_ubyte)),
        ]

    source_buffer = ctypes.create_string_buffer(data)
    source = DataBlob(
        len(data),
        ctypes.cast(source_buffer, ctypes.POINTER(ctypes.c_ubyte)),
    )
    destination = DataBlob()
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    flags = 0x1  # CRYPTPROTECT_UI_FORBIDDEN

    if decrypt:
        transform = crypt32.CryptUnprotectData
        description = ctypes.c_wchar_p()
        transform.argtypes = [
            ctypes.POINTER(DataBlob),
            ctypes.POINTER(ctypes.c_wchar_p),
            ctypes.POINTER(DataBlob),
            ctypes.c_void_p,
            ctypes.c_void_p,
            wintypes.DWORD,
            ctypes.POINTER(DataBlob),
        ]
        succeeded = transform(
            ctypes.byref(source),
            ctypes.byref(description),
            None,
            None,
            None,
            flags,
            ctypes.byref(destination),
        )
    else:
        transform = crypt32.CryptProtectData
        description = None
        transform.argtypes = [
            ctypes.POINTER(DataBlob),
            ctypes.c_wchar_p,
            ctypes.POINTER(DataBlob),
            ctypes.c_void_p,
            ctypes.c_void_p,
            wintypes.DWORD,
            ctypes.POINTER(DataBlob),
        ]
        succeeded = transform(
            ctypes.byref(source),
            "Flowstate TomTom API key",
            None,
            None,
            None,
            flags,
            ctypes.byref(destination),
        )

    if not succeeded:
        error_code = ctypes.get_last_error()
        raise OSError(error_code, "Windows could not protect or unprotect the credential.")

    try:
        return ctypes.string_at(destination.pbData, destination.cbData)
    finally:
        kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        kernel32.LocalFree.restype = ctypes.c_void_p
        kernel32.LocalFree(ctypes.cast(destination.pbData, ctypes.c_void_p))
        if decrypt and description:
            kernel32.LocalFree(ctypes.cast(description, ctypes.c_void_p))


def _save_tomtom_key(key: str) -> None:
    path = _tomtom_key_path()
    encrypted_key = _dpapi_transform(key.encode("utf-8"), decrypt=False)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=path.parent, prefix=".tomtom-key-", delete=False
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
            temporary_file.write(encrypted_key)
        os.replace(temporary_path, path)
    finally:
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink()


def _load_tomtom_key() -> str | None:
    path = _tomtom_key_path()
    if not path.exists():
        return None
    encrypted_key = path.read_bytes()
    key = _dpapi_transform(encrypted_key, decrypt=True).decode("utf-8").strip()
    if not key:
        raise ValueError("The saved TomTom credential is empty.")
    return key


def _tomtom_flow_segment(lat: float, lon: float) -> dict:
    key = os.environ.get("TOMTOM_API_KEY", "").strip()
    if not key:
        raise ProviderError("TomTom live traffic is not configured.")
    cache_key = (round(lat, 5), round(lon, 5))
    now = time.monotonic()
    with _traffic_cache_lock:
        cached = _traffic_cache.get(cache_key)
        if cached and now - cached[0] < TOMTOM_CACHE_SECONDS:
            return dict(cached[1])

    params = urlencode({
        "key": key,
        "point": f"{lat:.6f},{lon:.6f}",
        "unit": "kmph",
    })
    data = _provider_json(
        "https://api.tomtom.com/traffic/services/4/"
        f"flowSegmentData/absolute/10/json?{params}"
    )
    if not isinstance(data, dict):
        raise ProviderError("TomTom returned an invalid traffic response.")
    flow = data.get("flowSegmentData")
    if not isinstance(flow, dict):
        raise ProviderError("TomTom returned no flow data for this road segment.")

    try:
        current_speed = float(flow["currentSpeed"])
        free_flow_speed = float(flow["freeFlowSpeed"])
        confidence = float(flow["confidence"])
    except (KeyError, TypeError, ValueError) as error:
        raise ProviderError("TomTom returned incomplete speed data.") from error
    if (not math.isfinite(current_speed) or not math.isfinite(free_flow_speed)
            or not math.isfinite(confidence) or current_speed < 0
            or free_flow_speed < 0 or not 0 <= confidence <= 1):
        raise ProviderError("TomTom returned out-of-range speed data.")

    segment = {
        "current_speed_kmh": current_speed,
        "free_flow_speed_kmh": free_flow_speed,
        "confidence": confidence,
        "road_closure": flow.get("roadClosure") is True,
        "observed_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        current_time = float(flow.get("currentTravelTime", 0))
        free_flow_time = float(flow.get("freeFlowTravelTime", 0))
    except (TypeError, ValueError):
        current_time = free_flow_time = 0
    if current_time > 0 and free_flow_time > 0:
        segment["travel_time_ratio"] = current_time / free_flow_time
    elif current_speed > 0 and free_flow_speed > 0:
        segment["travel_time_ratio"] = free_flow_speed / current_speed
    else:
        segment["travel_time_ratio"] = 1.0

    with _traffic_cache_lock:
        _traffic_cache[cache_key] = (time.monotonic(), dict(segment))
        expired = [
            item_key for item_key, (created, _) in _traffic_cache.items()
            if time.monotonic() - created >= TOMTOM_CACHE_SECONDS
        ]
        for item_key in expired:
            _traffic_cache.pop(item_key, None)
    return segment


def _route_sample_points(route: dict) -> list[tuple[float, float]]:
    points = route.get("points", [])
    if len(points) < 2:
        return []
    sample_count = min(TOMTOM_SAMPLE_POINTS_PER_ROUTE, len(points))
    indices = sorted({
        round((index + 1) * (len(points) - 1) / (sample_count + 1))
        for index in range(sample_count)
    })
    return [(float(points[index][0]), float(points[index][1])) for index in indices]


def enrich_routes_with_traffic(routes: list[dict]) -> dict:
    status = get_traffic_status()
    if not status["configured"]:
        for route in routes:
            route["traffic"] = {"state": "unavailable"}
            route["live_eta_min"] = None
        return {
            "state": "unavailable",
            "provider": status["provider"],
            "sampled_segments": 0,
            "notice": "Add TOMTOM_API_KEY to enable live segment-speed samples.",
        }

    requests: dict[tuple[int, int], tuple[float, float]] = {}
    for route_index, route in enumerate(routes):
        for sample_index, point in enumerate(_route_sample_points(route)):
            requests[(route_index, sample_index)] = point

    results: dict[tuple[int, int], dict] = {}
    failures = 0
    with ThreadPoolExecutor(max_workers=TOMTOM_SAMPLE_WORKERS) as executor:
        futures = {
            executor.submit(_tomtom_flow_segment, lat, lon): key
            for key, (lat, lon) in requests.items()
        }
        for future in as_completed(futures):
            try:
                results[futures[future]] = future.result()
            except ProviderError:
                failures += 1

    route_states = []
    for route_index, route in enumerate(routes):
        samples = [
            sample for (index, _), sample in results.items()
            if index == route_index
        ]
        expected_samples = len(_route_sample_points(route))
        if not samples:
            route["traffic"] = {"state": "unavailable", "sampled_segments": 0}
            route["live_eta_min"] = None
            route_states.append("unavailable")
            continue

        slowdown = sum(sample["travel_time_ratio"] for sample in samples) / len(samples)
        current_speed = sum(sample["current_speed_kmh"] for sample in samples) / len(samples)
        free_flow_speed = sum(sample["free_flow_speed_kmh"] for sample in samples) / len(samples)
        confidence = sum(sample["confidence"] for sample in samples) / len(samples)
        state = "live" if len(samples) == expected_samples else "partial"
        route["live_eta_min"] = max(1, round(route["duration_min"] * slowdown))
        route["traffic"] = {
            "state": state,
            "sampled_segments": len(samples),
            "expected_samples": expected_samples,
            "current_speed_kmh": round(current_speed, 1),
            "free_flow_speed_kmh": round(free_flow_speed, 1),
            "confidence": round(confidence, 2),
            "delay_percent": max(0, round((slowdown - 1) * 100)),
            "road_closure": any(sample["road_closure"] for sample in samples),
            "observed_at": max(sample["observed_at"] for sample in samples),
        }
        route_states.append(state)

    available_routes = [
        route for route in routes
        if route.get("traffic", {}).get("state") in ("live", "partial")
    ]
    if available_routes:
        routes.sort(
            key=lambda route: (
                route.get("live_eta_min") is None,
                route.get("live_eta_min") or route["duration_min"],
            )
        )
        for index, route in enumerate(routes):
            route["label"] = "Live estimate" if index == 0 else f"Alternative {index}"
        overall_state = (
            "live" if all(state == "live" for state in route_states) else "partial"
        )
    else:
        overall_state = "unavailable"

    return {
        "state": overall_state,
        "provider": status["provider"],
        "sampled_segments": len(results),
        "failed_samples": failures,
        "sampled_at": datetime.now(timezone.utc).isoformat() if results else None,
        "notice": (
            "Live ETA is an estimate based on sampled road segments, not a full-route traffic guarantee."
            if results else
            "TomTom traffic could not be sampled. Route times remain non-live estimates."
        ),
    }


def sample_existing_routes(requested_routes: object) -> dict:
    if not isinstance(requested_routes, list) or not 1 <= len(requested_routes) <= 5:
        raise InvalidLocation("Provide between 1 and 5 routes to refresh.")

    routes = []
    seen_ids = set()
    for item in requested_routes:
        if not isinstance(item, dict):
            raise InvalidLocation("Each route must be a JSON object.")
        route_id = item.get("id")
        if not isinstance(route_id, str) or not 1 <= len(route_id) <= 50 or route_id in seen_ids:
            raise InvalidLocation("Each route must have a unique ID.")
        seen_ids.add(route_id)
        duration = item.get("duration_min")
        if (isinstance(duration, bool) or not isinstance(duration, (int, float))
                or not math.isfinite(duration) or not 0 < duration <= 24 * 60):
            raise InvalidLocation("Each route must include a valid estimated duration.")
        points = item.get("points")
        if not isinstance(points, list) or not 2 <= len(points) <= 2000:
            raise InvalidLocation("Each route must include between 2 and 2,000 map points.")
        validated_points = []
        for point in points:
            if not isinstance(point, list) or len(point) != 2:
                raise InvalidLocation("Route points must be [latitude, longitude] pairs.")
            lat, lon = _coordinate({"lat": point[0], "lon": point[1]}, "Route point")
            validated_points.append([lat, lon])
        routes.append({
            "id": route_id,
            "duration_min": duration,
            "points": validated_points,
        })

    traffic = enrich_routes_with_traffic(routes)
    return {
        "traffic": traffic,
        "routes": [
            {
                "id": route["id"],
                "traffic": route["traffic"],
                "live_eta_min": route["live_eta_min"],
                "label": route.get("label"),
            }
            for route in routes
        ],
    }


def _edge_cost(edge: dict) -> float:
    utilization = edge["current_vehicles"] / edge["capacity"]
    congestion_factor = 1 + 0.35 * utilization**2
    return edge["travel_time_min"] * congestion_factor


def _shortest_available_path(nodes: set[str], edges: list[dict], capacities: list[int],
                             start: str, goal: str) -> list[int] | None:
    adjacency: dict[str, list[int]] = {node: [] for node in nodes}
    for index, edge in enumerate(edges):
        if capacities[index] > 0:
            adjacency[edge["from"]].append(index)

    distances = {start: 0.0}
    previous: dict[str, tuple[str, int]] = {}
    queue = [(0.0, start)]
    while queue:
        distance, node = heapq.heappop(queue)
        if distance > distances.get(node, float("inf")):
            continue
        if node == goal:
            break
        for edge_index in adjacency[node]:
            edge = edges[edge_index]
            next_node = edge["to"]
            candidate = distance + _edge_cost(edge)
            if candidate < distances.get(next_node, float("inf")):
                distances[next_node] = candidate
                previous[next_node] = (node, edge_index)
                heapq.heappush(queue, (candidate, next_node))

    if goal not in previous and start != goal:
        return None
    path: list[int] = []
    current = goal
    while current != start:
        prior, edge_index = previous[current]
        path.append(edge_index)
        current = prior
    path.reverse()
    return path


def redistribute(vehicles: int, region_id: str = "DL") -> dict:
    if isinstance(vehicles, bool) or not isinstance(vehicles, int) or not 1 <= vehicles <= DEMAND_LIMIT:
        raise InvalidDemand(f"vehicles must be an integer from 1 to {DEMAND_LIMIT}")

    network = get_network(region_id)
    edges = network["edges"]
    source_route_id = "A"
    effective_edges = [
        {
            **edge,
            "current_vehicles": (
                max(0, edge["current_vehicles"] - vehicles)
                if edge["route_id"] == source_route_id
                else edge["current_vehicles"]
            ),
        }
        for edge in edges
    ]
    node_ids = {node["id"] for node in network["nodes"]}
    residual = [
        max(0, edge["capacity"] - edge["current_vehicles"])
        for edge in effective_edges
    ]
    initial_available = residual.copy()
    allocated: dict[str, int] = {}
    route_edges: dict[str, list[dict]] = {}
    remaining = vehicles

    # Repeated shortest-path augmentation sends flow only where every road has spare capacity.
    while remaining:
        path = _shortest_available_path(
            node_ids, effective_edges, residual, network["origin"], network["destination"]
        )
        if path is None:
            break
        amount = min(remaining, *(residual[index] for index in path))
        for index in path:
            residual[index] -= amount
        route_id = effective_edges[path[0]]["route_id"]
        allocated[route_id] = allocated.get(route_id, 0) + amount
        route_edges.setdefault(route_id, []).extend(
            edge for edge in (effective_edges[index] for index in path)
            if edge not in route_edges.get(route_id, [])
        )
        remaining -= amount

    node_by_id = {node["id"]: node for node in network["nodes"]}
    route_info = {}
    for edge in effective_edges:
        route_info.setdefault(edge["route_id"], edge)
    route_available_capacity = {
        route_id: min(
            initial_available[index]
            for index, edge in enumerate(effective_edges)
            if edge["route_id"] == route_id
        )
        for route_id in route_info
    }

    routes = []
    for route_id, count in allocated.items():
        path_edges = route_edges[route_id]
        routes.append(
            {
                "id": route_id,
                "name": route_info[route_id]["route_name"],
                "vehicles": count,
                "capacity": min(edge["capacity"] for edge in path_edges),
                "available_capacity": route_available_capacity[route_id],
                "current_vehicles": route_info[route_id]["current_vehicles"],
                "travel_time_min": round(sum(edge["travel_time_min"] for edge in path_edges), 1),
                "points": [
                    [node_by_id[path_edges[0]["from"]]["lat"],
                     node_by_id[path_edges[0]["from"]]["lon"]]
                ] + [
                    [node_by_id[edge["to"]]["lat"], node_by_id[edge["to"]]["lon"]]
                    for edge in path_edges
                ],
            }
        )
    routes.sort(key=lambda route: route["id"])
    return {
        "region_id": region_id,
        "region": network["region"],
        "requested": vehicles,
        "routed": vehicles - remaining,
        "unassigned": remaining,
        "routes": routes,
        "algorithm": "Dijkstra shortest-path search with capacity-bounded flow augmentation",
    }


class RequestHandler(BaseHTTPRequestHandler):
    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/traffic/status":
            self._send_json(200, get_traffic_status())
            return
        if path == "/api/search":
            query = parse_qs(parsed.query).get("q", [""])[0]
            try:
                self._send_json(200, {"places": search_places(query)})
            except InvalidLocation as error:
                self._send_json(400, {"error": str(error)})
            except ProviderError as error:
                self._send_json(502, {"error": str(error)})
            return
        if path == "/api/suggestions":
            query = parse_qs(parsed.query).get("q", [""])[0]
            try:
                self._send_json(200, {"places": suggest_places(query)})
            except InvalidLocation as error:
                self._send_json(400, {"error": str(error)})
            except ProviderError as error:
                self._send_json(502, {"error": str(error)})
            return
        if path == "/api/nearby/search":
            query = parse_qs(parsed.query)
            try:
                lat = float(query.get("lat", [""])[0])
                lon = float(query.get("lon", [""])[0])
                radius = int(query.get("radius", ["10000"])[0])
                search = query.get("q", [""])[0]
                places = search_nearby_places(search, lat, lon, radius)
                self._send_json(200, {"places": places, "query": search})
            except (TypeError, ValueError):
                self._send_json(400, {"error": "Provide a search term and valid location/radius."})
            except InvalidLocation as error:
                self._send_json(400, {"error": str(error)})
            except ProviderError as error:
                self._send_json(502, {"error": str(error)})
            return
        if path == "/api/nearby":
            query = parse_qs(parsed.query)
            try:
                lat = float(query.get("lat", [""])[0])
                lon = float(query.get("lon", [""])[0])
                radius = int(query.get("radius", ["10000"])[0])
                category = query.get("category", [""])[0]
                places = nearby_places(category, lat, lon, radius)
                self._send_json(200, {"places": places, "category": category})
            except (TypeError, ValueError):
                self._send_json(400, {"error": "Provide valid map coordinates and search radius."})
            except InvalidLocation as error:
                self._send_json(400, {"error": str(error)})
            except ProviderError as error:
                self._send_json(502, {"error": str(error)})
            return
        if path == "/api/reverse-geocode":
            query = parse_qs(parsed.query)
            try:
                lat = float(query.get("lat", [""])[0])
                lon = float(query.get("lon", [""])[0])
                label = reverse_geocode(lat, lon)
                self._send_json(200, {"label": label})
            except (TypeError, ValueError):
                self._send_json(400, {"error": "Provide a valid map coordinate."})
            except InvalidLocation as error:
                self._send_json(400, {"error": str(error)})
            except ProviderError as error:
                self._send_json(502, {"error": str(error)})
            return
        if path == "/api/regions":
            self._send_json(200, {
                "states": [region for region in REGIONS if region["kind"] == "State"],
                "union_territories": [
                    region for region in REGIONS if region["kind"] == "Union Territory"
                ],
            })
            return
        if path == "/api/network":
            region_id = parse_qs(parsed.query).get("region", ["DL"])[0]
            try:
                self._send_json(200, get_network(region_id))
            except InvalidRegion as error:
                self._send_json(400, {"error": str(error)})
            return
        if path == "/":
            path = "/index.html"
        requested = (WEB_ROOT / unquote(path.lstrip("/"))).resolve()
        if not requested.is_relative_to(WEB_ROOT.resolve()) or not requested.is_file():
            self.send_error(404)
            return
        content = requested.read_bytes()
        content_type = mimetypes.guess_type(requested.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path not in ("/api/redistribute", "/api/routes", "/api/traffic/refresh", "/api/routes/select", "/api/routes/complete"):
            self.send_error(404)
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            max_length = 128 * 1024 if path == "/api/traffic/refresh" else 4096
            if not 0 < content_length <= max_length:
                self._send_json(400, {"error": f"Request body must be between 1 and {max_length} bytes"})
                return
            payload = json.loads(self.rfile.read(content_length))
            if not isinstance(payload, dict):
                raise InvalidDemand("request body must be a JSON object")
            if path == "/api/routes":
                result = get_routes(payload.get("start"), payload.get("destination"))
            elif path == "/api/traffic/refresh":
                result = sample_existing_routes(payload.get("routes"))
            elif path == "/api/routes/select":
                corridor_key = payload.get("corridor_key")
                if corridor_key:
                    with _active_reservations_lock:
                        _active_reservations[corridor_key] = _active_reservations.get(corridor_key, 0) + 1
                result = {"status": "ok"}
            elif path == "/api/routes/complete":
                corridor_key = payload.get("corridor_key")
                if corridor_key:
                    with _active_reservations_lock:
                        _active_reservations[corridor_key] = max(0, _active_reservations.get(corridor_key, 0) - 1)
                result = {"status": "ok"}
            else:
                result = redistribute(payload.get("vehicles"), payload.get("region", "DL"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_json(400, {"error": "Request body must contain valid JSON"})
            return
        except InvalidLocation as error:
            self._send_json(400, {"error": str(error)})
            return
        except ProviderError as error:
            self._send_json(502, {"error": str(error)})
            return
        except InvalidDemand as error:
            self._send_json(400, {"error": str(error)})
            return
        except InvalidRegion as error:
            self._send_json(400, {"error": str(error)})
            return
        self._send_json(200, result)

    def log_message(self, format: str, *args: object) -> None:
        print(f"{self.address_string()} - {self.command} {urlparse(self.path).path}")


def main() -> None:
    try:
        if not configure_tomtom_key():
            print("TomTom live traffic is not configured; routes will use non-live estimates.")
    except RuntimeError as error:
        print(error, file=sys.stderr)
        raise SystemExit(1) from error
    host = os.environ.get("FLOWSTATE_HOST", "127.0.0.1")
    server = ThreadingHTTPServer((host, APP_PORT), RequestHandler)
    print(f"Traffic redistribution prototype: http://{host}:{APP_PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
