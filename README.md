# Flowstate — India navigation prototype

This local web prototype requests browser location as soon as it opens. Its
map-first home screen keeps the desktop navigation sidebar collapsed until the
menu is opened. The expanded left sidebar includes Home and recent
destinations. On phones, the existing bottom-panel layout is preserved. The
collapsed desktop rail shows current GPS status and accuracy and doubles as a
map-recenter control. The map also includes destination search, nearby-place
categories, device-local Home and recent destinations, and map pin selection.
Choose a destination to compare driving-route alternatives, select a route, and
start basic on-screen guidance. While navigation is active, the app watches
location and requests a new route after repeated, accurate off-route readings.

Search supports recent destinations, keyboard selection (Up/Down, Enter, and
Escape), and India-local distance formatting. Route options are ordered by
estimated travel time and distinguish sampled estimates from non-live ones.
Map layers include standard OpenStreetMap tiles and OpenStreetMap's
Humanitarian-style tiles, plus
route and locally saved issue-note overlays. Issue notes stay in this browser;
they are not submitted to traffic providers or shared with drivers.
The map search prompt uses a decorative caret until the field is focused or
contains text. Selecting a destination by tapping the map creates a pin;
tapping the map again clears that pin and its routes.

## Run locally

Requires Python 3.10 or later. No Python packages are needed.

```powershell
.\start_flowstate.bat
```

You can also double-click `start_flowstate.bat` in File Explorer. The launcher
starts the app on port 8012. Open <http://127.0.0.1:8012>. Leaflet, map tiles, place search, and route
calculation need an internet connection. Browser location is generally available
on `localhost` for development; accessing the app from a phone or deploying it
requires HTTPS for geolocation.

## Enable TomTom live traffic for the Kolkata pilot

1. Create a TomTom developer account and project in the
   [TomTom Developer Portal](https://developer.tomtom.com/). Enable access to
   the Traffic Flow API and create an API key. Check your account's pricing,
   usage limits, and terms before using it. TomTom lists India in its Traffic
   Flow market coverage, but verify usable coverage and quality on your intended
   Kolkata roads before relying on it.
2. Double-click `start_flowstate.bat`, or run it from PowerShell:

   ```powershell
   .\start_flowstate.bat
   ```

   The first time, the app prompts for the key without displaying what you type.
   Paste it into that local terminal prompt and press Enter. Windows encrypts
   and saves it for your Windows account using DPAPI, outside the project folder.
   On later launches, the app loads it automatically; you do not need to enter
   it again. The key is not written to source code or sent to the browser. Do not
   paste it into chat or commit it. Press Enter without a key to skip live data.
3. Open `http://127.0.0.1:8012/api/traffic/status`. It should report
   `"configured": true`. Search for a route in Kolkata; the server will request
   TomTom Flow Segment Data at up to three points per route, cache samples for
   45 seconds, and show sampled speed and a traffic-adjusted estimate. With a
   configured key, open routes refresh traffic every five minutes while the
   page is visible; you can also refresh it manually.
4. If the status says setup is required, or route cards say traffic is
   unavailable, check the key, API access, quota/billing, internet connection,
   and TomTom's live service status. The app explicitly falls back to
   non-live route estimates when sampling fails.

To remove the locally saved credential, run this in PowerShell:

```powershell
Remove-Item "$env:LOCALAPPDATA\Flowstate\tomtom-key.dpapi"
```

TomTom traffic availability is not a guarantee of road-level coverage. This
prototype samples a few points along candidate routes; it does not inspect every
road, measure spare vehicle capacity, or provide a citywide live traffic graph.
The estimated delay adjusts an OSM/OSRM route time using sampled segment
travel-time ratios; validate this method against real trips before using it for
operational decisions.

Run tests with:

```powershell
python -m unittest discover -s tests -v
```

## External providers and privacy

- Map imagery uses OpenStreetMap tiles.
- While typing a destination, the app waits briefly and sends the query to
  TomTom Search for India-filtered suggestions. This requires a configured
  TomTom key with Search API access. If that is unavailable, submit the place
  search to use OpenStreetMap Nominatim instead.
- Nearby category searches (Food & drink, Things to do, Shopping, Services,
  Fuel) use TomTom Search around the current location or map center. Selecting a
  result shows its approximate straight-line distance from your current
  location, sets it as the destination, and starts route planning. Clicking the
  map drops a destination pin; TomTom reverse geocoding provides its display
  label when available.
- Home and recent destinations are saved in this browser's local storage on
  this device. You can set Home from a search or save your current location
  from the Home section. They are not synced between browsers or devices and
  can be cleared from the app.
- Map issue notes (such as closures, hazards, or map corrections) are optional
  and stored only in this browser. They are unverified private notes; this
  prototype does not transmit them, notify other drivers, or use them to change
  routes.
- Submitted place searches send the typed name to the OpenStreetMap Nominatim
  service. These searches are explicitly submitted, and the server limits
  requests to one per second; Nominatim is not used for autocomplete.
- Route requests send start and destination coordinates to the public OSRM demo
  routing service. When its normal request returns fewer than three routes, the
  prototype makes additional requests through two offset waypoints and keeps
  distinct, drivable routes within a bounded detour. The router can still return
  fewer than three options when roads or provider data do not support them.
- When configured, the backend sends route sample coordinates to TomTom Traffic
  Flow when routes are requested and during manual/automatic traffic refreshes.
  API keys stay on the backend; coordinates are still sent to the third-party
  mapping/traffic providers.
- Current location is used in the active session and is not saved by the app.
  Home, recent destinations, and optional map issue notes are saved in this
  browser's local storage as described above. External providers process
  requests under their own service policies; do not use sensitive locations in
  this prototype.

Public OSM services are best-effort community services, not production SLAs.
Follow the providers' usage policies and move to an appropriately licensed,
reliable provider before a public launch.

## Important limitations

This is a navigation prototype, not a production maps replacement. It provides
road-based route alternatives and basic on-screen maneuver text with approximate
remaining distance/time. Without a
TomTom key, route times come from road data and do not reflect current
congestion. With a key, sparse route-segment samples refresh periodically for a
rough traffic adjustment; the map does not show a full-city traffic layer, and
this is not a full-route traffic guarantee. The app
still lacks voice guidance, offline maps, and an operational fleet/city
coordination service. It cannot coordinate drivers who are not using a
connected service, and it does not automatically control vehicles or traffic
signals.

The earlier regional demos are still available through `/api/regions` and
`/api/network`, but they remain schematic and must not be used for navigation.
Accurate coordinated redistribution requires a licensed live-traffic or
consented fleet-data source, validated road capacities, participating drivers,
and a tested optimization service.
