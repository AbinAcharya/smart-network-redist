const INDIA_VIEW = { center: [22.8, 79.0], zoom: 5 };
const ROUTE_COLORS = ['#137b68', '#4385c5', '#d08046', '#8a6bb8', '#bd5d70'];

const map = L.map('map', { zoomControl: false }).setView(INDIA_VIEW.center, INDIA_VIEW.zoom);
const standardMap = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
const humanitarianMap = L.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', {
 maxZoom: 19,
 attribution: '&copy; OpenStreetMap contributors, Tiles style by Humanitarian OpenStreetMap Team',
});
L.control.zoom({ position: 'topright' }).addTo(map);

const routeLayer = L.layerGroup().addTo(map);
const placeLayer = L.layerGroup().addTo(map);
const nearbyLayer = L.layerGroup().addTo(map);
const locationLayer = L.layerGroup().addTo(map);
const incidentLayer = L.layerGroup().addTo(map);
L.control.layers(
  { 'Standard map': standardMap, 'Humanitarian map': humanitarianMap },
  { Routes: routeLayer, 'Saved issue notes': incidentLayer },
  { position: 'topright', collapsed: true },
).addTo(map);
const appShell = document.querySelector('.app-shell');
const sidebar = document.getElementById('sidebar');
const sidebarContent = document.getElementById('sidebar-content');
const originInput = document.getElementById('origin-input');
const destinationInput = document.getElementById('destination-input');
const searchResults = document.getElementById('search-results');
const placeOptions = document.getElementById('place-options');
const nearbySection = document.getElementById('nearby-section');
const nearbyList = document.getElementById('nearby-list');
const routeSection = document.getElementById('route-section');
const routeOptions = document.getElementById('route-options');
const mapStatus = document.getElementById('map-status');
const locationIndicator = document.getElementById('location-indicator');
const locationIndicatorLabel = document.getElementById('location-indicator-label');
const locationIndicatorDetail = document.getElementById('location-indicator-detail');
const routeForm = document.getElementById('route-form');
const findRoutesButton = document.getElementById('find-routes');
const trafficNotice = document.querySelector('.traffic-notice');
const trafficSummary = document.getElementById('traffic-summary');
const refreshTrafficButton = document.getElementById('refresh-traffic');
const TRAFFIC_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const HOME_STORAGE_KEY = 'flowstate.home.v1';
const RECENTS_STORAGE_KEY = 'flowstate.recents.v1';
const INCIDENTS_STORAGE_KEY = 'flowstate.local-incidents.v1';
const MAX_RECENT_PLACES = 5;
const CATEGORY_LABELS = {
  restaurants: 'Restaurants',
  things: 'Things to do',
  shopping: 'Shopping',
  hospitals: 'Hospitals',
  fuel: 'Fuel',
  atm: 'ATM',
};

let currentFix = null;
let currentMarker = null;
let accuracyCircle = null;
let manualOrigin = false;
let manualOriginPlace = null;
let destinationPlace = null;
let mapPinSelected = false;
let awaitingLocationForRoute = false;
let routeChoices = [];
let selectedRouteIndex = 0;
let activeNavigation = false;
let offRouteReadings = 0;
let lastRerouteAt = 0;
let latestSearchId = 0;
let watchId = null;
let trafficConfigured = false;
let trafficRefreshTimer = null;
let trafficRefreshInProgress = false;
let suggestionTimer = null;
let suggestionRequestId = 0;
let suggestionController = null;
let nearbyRequestId = 0;
let homePlace = readSavedPlace(HOME_STORAGE_KEY);
let recentPlaces = readSavedPlaces(RECENTS_STORAGE_KEY);
let isPickingHome = false;
let isPickingIncident = false;
let activeSuggestionIndex = -1;
let incidentLocation = null;
let localIncidents = readSavedIncidents();

function setSidebarExpanded(expanded) {
  appShell.classList.toggle('sidebar-expanded', expanded);
  sidebar.classList.toggle('expanded', expanded);
  sidebarContent.inert = !expanded;
  const toggle = document.getElementById('sidebar-toggle');
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.setAttribute('aria-label', expanded ? 'Collapse navigation menu' : 'Expand navigation menu');
}

function displayError(message) {
  mapStatus.textContent = message;
}

function setSearchButtonLoading(loading, label = 'Search') {
  findRoutesButton.disabled = loading;
  findRoutesButton.classList.toggle('is-loading', loading);
  findRoutesButton.setAttribute('aria-label', loading ? label : 'Search');
  findRoutesButton.innerHTML = loading
    ? '<span class="search-spinner" aria-hidden="true"></span>'
    : '<span aria-hidden="true">→</span>';
}

function updateSearchPrompt() {
  routeForm.classList.toggle(
    'is-editing',
    document.activeElement === destinationInput || Boolean(destinationInput.value),
  );
}

function validSavedPlace(value) {
  return value && typeof value.label === 'string'
    && Number.isFinite(value.lat) && Number.isFinite(value.lon)
    && value.lat >= -90 && value.lat <= 90
    && value.lon >= -180 && value.lon <= 180;
}

function readSavedPlace(key) {
  try {
    const saved = localStorage.getItem(key);
    if (!saved) return null;
    const place = JSON.parse(saved);
    return validSavedPlace(place) ? place : null;
  } catch (error) {
    console.warn('Could not read a saved Flowstate place.', error);
    return null;
  }
}

function readSavedPlaces(key) {
  try {
    const saved = localStorage.getItem(key);
    if (!saved) return [];
    const places = JSON.parse(saved);
    return Array.isArray(places) ? places.filter(validSavedPlace).slice(0, MAX_RECENT_PLACES) : [];
  } catch (error) {
    console.warn('Could not read recent Flowstate places.', error);
    return [];
  }
}

function validIncident(value) {
  return value && typeof value.id === 'string'
    && typeof value.type === 'string'
    && typeof value.details === 'string'
    && Number.isFinite(value.lat) && Number.isFinite(value.lon)
    && value.lat >= 6 && value.lat <= 38
    && value.lon >= 68 && value.lon <= 98;
}

function readSavedIncidents() {
  try {
    const saved = localStorage.getItem(INCIDENTS_STORAGE_KEY);
    if (!saved) return [];
    const incidents = JSON.parse(saved);
    return Array.isArray(incidents) ? incidents.filter(validIncident).slice(0, 50) : [];
  } catch (error) {
    console.warn('Could not read locally saved map issue notes.', error);
    return [];
  }
}

function storeLocalValue(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.error('Could not save Flowstate places on this device.', error);
    setLocationStatus('Could not save this place on your device. Check browser storage settings.');
    return false;
  }
}

function haversineMetres(start, end) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const latitudeDelta = radians(end.lat - start.lat);
  const longitudeDelta = radians(end.lon - start.lon);
  const latitude1 = radians(start.lat);
  const latitude2 = radians(end.lat);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function distanceLabel(place) {
  if (!currentFix) return '';
  return formatDistance(haversineMetres(currentFix, place) / 1000);
}

function renderSavedPlaces() {
  const homeLabel = document.getElementById('home-label');
  const homeSubtitle = document.getElementById('home-subtitle');
  homeLabel.textContent = homePlace ? 'Home' : 'Set home';
  homeSubtitle.textContent = homePlace
    ? homePlace.label
    : 'Set a home place for quick directions';
  document.getElementById('home-shortcut').setAttribute(
    'aria-label',
    homePlace ? `Get directions to Home: ${homePlace.label}` : 'Choose a home place',
  );
  document.getElementById('change-home').hidden = !homePlace;

  const recentList = document.getElementById('recent-list');
  const recentEmpty = document.getElementById('recent-empty');
  const recentEmptyState = recentList.parentElement.querySelector('.empty-state-container');
  const clearRecents = document.getElementById('clear-recents');
  recentList.replaceChildren();
  if (recentEmpty) recentEmpty.hidden = recentPlaces.length > 0;
  if (recentEmptyState) recentEmptyState.hidden = recentPlaces.length > 0;
  clearRecents.hidden = recentPlaces.length === 0;
  recentPlaces.forEach((place) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'recent-place';
    const icon = document.createElement('span');
    icon.className = 'place-round-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '⌖';
    const copy = document.createElement('span');
    copy.className = 'recent-copy';
    const name = document.createElement('strong');
    name.textContent = place.label.split(',')[0];
    const description = document.createElement('small');
    description.textContent = place.label;
    const chosenAt = document.createElement('small');
    chosenAt.className = 'recent-time';
    chosenAt.textContent = Number.isFinite(place.chosenAt)
      && Number.isFinite(new Date(place.chosenAt).getTime())
      ? `Selected ${formatRelativeTime(place.chosenAt)}`
      : 'Previously selected';
    copy.append(name, description, chosenAt);
    button.append(icon, copy);
    const distance = distanceLabel(place);
    if (distance) {
      const badge = document.createElement('span');
      badge.className = 'recent-distance-badge';
      badge.textContent = distance;
      badge.setAttribute('aria-label', `Approximately ${distance} away in a straight line`);
      button.append(badge);
    }
    button.addEventListener('click', () => selectDestination(place));
    recentList.append(button);
  });
}

function formatRelativeTime(timestamp) {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (elapsedSeconds < 60) return 'just now';
  if (elapsedSeconds < 3600) return `${Math.floor(elapsedSeconds / 60)} min ago`;
  if (elapsedSeconds < 86400) return `${Math.floor(elapsedSeconds / 3600)} hr ago`;
  if (elapsedSeconds < 7 * 86400) return `${Math.floor(elapsedSeconds / 86400)} days ago`;
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(timestamp);
}

function saveHomePlace(place) {
  if (!validSavedPlace(place)) {
    setLocationStatus('Could not save Home because the location coordinates are invalid.');
    return false;
  }
  if (!storeLocalValue(HOME_STORAGE_KEY, place)) return false;
  homePlace = place;
  isPickingHome = false;
  renderSavedPlaces();
  setLocationStatus('Home saved on this device');
  return true;
}

function addRecentPlace(place) {
  const recentPlace = { ...place, chosenAt: Date.now() };
  recentPlaces = [
    recentPlace,
    ...recentPlaces.filter((recent) =>
      Math.abs(recent.lat - place.lat) > 0.0001
      || Math.abs(recent.lon - place.lon) > 0.0001),
  ].slice(0, MAX_RECENT_PLACES);
  if (storeLocalValue(RECENTS_STORAGE_KEY, recentPlaces)) renderSavedPlaces();
}

async function loadTrafficStatus() {
  try {
    const response = await fetch('/api/traffic/status');
    const status = await response.json();
    if (!response.ok) throw new Error(status.error || 'Unable to check traffic setup.');
    trafficConfigured = Boolean(status.configured);
    refreshTrafficButton.disabled = !trafficConfigured || !routeChoices.length;
  } catch (error) {
    trafficConfigured = false;
    refreshTrafficButton.disabled = true;
    console.error('Could not check the traffic provider status.', error);
  }
}

function setLocationStatus(message) {
  mapStatus.textContent = message;
}

function setLocationIndicator(state, detail = '') {
  const states = {
    locating: { label: 'Locating', fallback: 'GPS', description: 'Location is being determined' },
    ready: { label: 'Ready', fallback: 'GPS', description: 'Location ready' },
    denied: { label: 'Off', fallback: 'Permission', description: 'Location permission was denied' },
    unavailable: { label: 'Offline', fallback: 'No signal', description: 'Current location is unavailable' },
  };
  const status = states[state] || states.locating;
  const description = detail ? `${status.description} · ${detail}` : status.description;
  locationIndicator.dataset.state = state;
  locationIndicatorLabel.textContent = status.label;
  locationIndicatorDetail.textContent = detail || status.fallback;
  locationIndicator.title = `${description}. Center map on current location.`;
  locationIndicator.setAttribute('aria-label', `${description}. Center map on current location.`);
}

function setOriginMode(useManual) {
  manualOrigin = useManual;
  manualOriginPlace = null;
  awaitingLocationForRoute = false;
  document.getElementById('origin-controls').hidden = !useManual;
  originInput.value = '';
  document.getElementById('origin-summary').hidden = true;
  document.getElementById('location-button').textContent =
    useManual ? 'Cancel manual starting point' : 'Set starting point manually';
  if (useManual) originInput.focus();
}

function updateLocation(position) {
  const isFirstLocationFix = currentFix === null;
  currentFix = {
    lat: position.coords.latitude,
    lon: position.coords.longitude,
    accuracy: position.coords.accuracy,
  };
  const point = [currentFix.lat, currentFix.lon];
  if (!currentMarker) {
    currentMarker = L.circleMarker(point, {
      radius: 8,
      color: '#fff',
      weight: 3,
      fillColor: '#2785ed',
      fillOpacity: 1,
    }).bindTooltip('Your location').addTo(locationLayer);
    accuracyCircle = L.circle(point, {
      radius: Math.min(currentFix.accuracy, 500),
      color: '#2785ed',
      weight: 1,
      fillColor: '#2785ed',
      fillOpacity: 0.1,
    }).addTo(locationLayer);
  } else {
    currentMarker.setLatLng(point);
    accuracyCircle.setLatLng(point).setRadius(Math.min(currentFix.accuracy, 500));
  }

  if (!manualOrigin && (document.activeElement !== destinationInput
      || !destinationInput.value || destinationInput.value === 'My location')) {
    originInput.value = 'My location';
    originInput.placeholder = 'My location';
  }
  if (!map._flowstateHasCentered) {
    map.setView(point, 15);
    map._flowstateHasCentered = true;
  }
  const accuracy = Math.round(currentFix.accuracy);
  if (isFirstLocationFix) renderSavedPlaces();
  setLocationStatus(`Location ready · accuracy about ${accuracy} m`);
  setLocationIndicator('ready', `±${accuracy} m`);
  if (awaitingLocationForRoute && destinationPlace && !manualOrigin) {
    awaitingLocationForRoute = false;
    loadRoutes();
  }
  updateNavigationStep();
  checkOffRoute();
}

function locationError(error) {
  if (error.code === 1) {
    setLocationStatus('Location permission was denied. Set a starting place manually to continue.');
    setLocationIndicator('denied');
  } else if (error.code === 2) {
    setLocationStatus('Current location is unavailable. Try again or set a start manually.');
    setLocationIndicator('unavailable');
  } else {
    setLocationStatus('Still waiting for your location. You can set a start manually.');
    setLocationIndicator('locating', 'Waiting');
  }
  if (!currentFix && !manualOrigin) {
    setSidebarExpanded(true);
    setOriginMode(true);
  }
}

function startLocationTracking() {
  if (!('geolocation' in navigator)) {
    setLocationStatus('This browser does not support location. Set a start manually.');
    setLocationIndicator('unavailable', 'Unsupported');
    setSidebarExpanded(true);
    setOriginMode(true);
    return;
  }
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  setLocationStatus('Requesting location permission…');
  setLocationIndicator('locating');
  watchId = navigator.geolocation.watchPosition(updateLocation, locationError, {
    enableHighAccuracy: true,
    maximumAge: 5000,
    timeout: 20000,
  });
}

function selectPlace(place, kind) {
  if (suggestionTimer !== null) clearTimeout(suggestionTimer);
  suggestionTimer = null;
  suggestionRequestId += 1;
  if (suggestionController) suggestionController.abort();
  suggestionController = null;
  searchResults.hidden = true;
  if (kind === 'origin') {
    manualOriginPlace = place;
    originInput.value = place.label;
    const originSummary = document.getElementById('origin-summary');
    originSummary.textContent = `Starting from ${place.label}`;
    originSummary.hidden = false;
    document.getElementById('origin-controls').hidden = true;
    document.getElementById('location-button').textContent = 'Change starting point';
    setLocationStatus('Starting point selected');
    if (destinationPlace) loadRoutes();
    return;
  }
  if (isPickingHome) {
    if (saveHomePlace(place)) setSidebarExpanded(false);
    return;
  }
  selectDestination(place);
}

function selectDestination(place, { addRecent = true, fitMap = true } = {}) {
  setSidebarExpanded(true);
  destinationPlace = {
    label: place.label,
    lat: place.lat,
    lon: place.lon,
  };
  mapPinSelected = false;
  destinationInput.value = destinationPlace.label;
  updateSearchPrompt();
  searchResults.hidden = true;
  nearbySection.hidden = true;
  nearbyLayer.clearLayers();
  clearRouteState();
  placeLayer.clearLayers();
  L.marker([destinationPlace.lat, destinationPlace.lon])
    .bindTooltip('Destination')
    .addTo(placeLayer);
  if (addRecent) addRecentPlace(destinationPlace);
  if (fitMap) map.setView([destinationPlace.lat, destinationPlace.lon], Math.max(map.getZoom(), 14));
  loadRoutes();
}

async function setMapDestination(lat, lon) {
  const place = {
    label: `Dropped pin · ${lat.toFixed(5)}, ${lon.toFixed(5)}`,
    lat,
    lon,
  };
  if (isPickingHome) {
    if (saveHomePlace(place)) setSidebarExpanded(false);
    const requestId = latestSearchId;
    try {
      const response = await fetch(
        `/api/reverse-geocode?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`,
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not identify that map place.');
      if (requestId === latestSearchId && homePlace?.lat === lat && homePlace?.lon === lon
          && result.label) {
        homePlace.label = result.label;
        if (storeLocalValue(HOME_STORAGE_KEY, homePlace)) renderSavedPlaces();
      }
    } catch (error) {
      console.warn('Could not look up the name of the selected Home location.', error);
    }
    return;
  }
  selectDestination(place, { fitMap: false });
  const requestId = latestSearchId;
  try {
    const response = await fetch(
      `/api/reverse-geocode?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`,
    );
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not identify that map place.');
    if (requestId !== latestSearchId || !destinationPlace
        || destinationPlace.lat !== lat || destinationPlace.lon !== lon) return;
    if (!result.label) return;
    destinationPlace.label = result.label;
    destinationInput.value = result.label;
    updateSearchPrompt();
    addRecentPlace(destinationPlace);
    placeLayer.clearLayers();
    L.marker([lat, lon]).bindTooltip('Destination').addTo(placeLayer);
  } catch (error) {
    console.warn('Could not look up the name of the selected map location.', error);
    if (requestId === latestSearchId) {
      setLocationStatus('Map pin selected. The address name could not be loaded.');
    }
  }
}

function renderNearbyPlaces(places, category, heading = `${CATEGORY_LABELS[category]} nearby`) {
  nearbyList.replaceChildren();
  nearbyLayer.clearLayers();
  document.getElementById('nearby-heading').textContent = heading;
  document.getElementById('nearby-message').textContent = places.length
    ? `${places.length} places found, closest first. Select one to see routes.`
    : 'No matching places found nearby. Try another search or move the map.';

  places.forEach((place) => {
    const distance = distanceLabel(place);
    const marker = L.circleMarker([place.lat, place.lon], {
      radius: 8,
      color: '#fff',
      weight: 3,
      fillColor: '#147b67',
      fillOpacity: 1,
      bubblingMouseEvents: false,
    }).bindTooltip(`${place.label}${distance ? ` · approximately ${distance} away` : ''}`, {
      direction: 'top',
    });
    marker.on('click', () => selectDestination(place));
    marker.addTo(nearbyLayer);

    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'nearby-place';
    const icon = document.createElement('span');
    icon.className = 'place-round-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '⌖';
    const copy = document.createElement('span');
    copy.className = 'nearby-copy';
    const name = document.createElement('strong');
    name.textContent = place.label.split(',')[0];
    const details = document.createElement('small');
    details.textContent = place.label;
    copy.append(name, details);
    if (place.category) {
      const categoryDetail = document.createElement('small');
      categoryDetail.textContent = place.category;
      copy.append(categoryDetail);
    }
    if (distance) {
      const distanceDetail = document.createElement('small');
      distanceDetail.className = 'nearby-distance';
      distanceDetail.textContent = `Approx. ${distance} straight-line`;
      copy.append(distanceDetail);
    }
    option.append(icon, copy);
    option.addEventListener('click', () => selectDestination(place));
    nearbyList.append(option);
  });
}

const INCIDENT_LABELS = {
  closure: 'Road closure',
  crash: 'Crash or breakdown',
  hazard: 'Road hazard',
  works: 'Road works',
  map: 'Map correction',
};

function renderLocalIncidents() {
  incidentLayer.clearLayers();
  for (const incident of localIncidents) {
    const marker = L.circleMarker([incident.lat, incident.lon], {
      radius: 8,
      color: '#fff',
      weight: 2,
      fillColor: '#c45d47',
      fillOpacity: 1,
      bubblingMouseEvents: false,
    });
    const popup = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = `${INCIDENT_LABELS[incident.type] || 'Map issue'} · saved on this device`;
    popup.append(title);
    if (incident.details) {
      const details = document.createElement('p');
      details.textContent = incident.details;
      popup.append(details);
    }
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'local-note-delete';
    removeButton.textContent = 'Delete this local note';
    removeButton.addEventListener('click', () => {
      localIncidents = localIncidents.filter((saved) => saved.id !== incident.id);
      if (storeLocalValue(INCIDENTS_STORAGE_KEY, localIncidents)) {
        renderLocalIncidents();
        setLocationStatus('Local issue note deleted.');
      }
    });
    popup.append(removeButton);
    marker.bindPopup(popup).bindTooltip('Unshared local map note').addTo(incidentLayer);
  }
}

function openIncidentDialog(position = null) {
  incidentLocation = position || (currentFix
    ? { lat: currentFix.lat, lon: currentFix.lon }
    : map.getCenter());
  document.getElementById('incident-location').textContent =
    `Location: ${incidentLocation.lat.toFixed(5)}, ${incidentLocation.lon.toFixed(5)}${position ? ' (map pin)' : currentFix ? ' (your location)' : ' (map center)'}`;
  document.getElementById('incident-dialog').showModal();
}

function saveLocalIncident(event) {
  event.preventDefault();
  if (!incidentLocation) {
    setLocationStatus('Choose a location on the map or use the current map center.');
    return;
  }
  if (incidentLocation.lat < 6 || incidentLocation.lat > 38
      || incidentLocation.lon < 68 || incidentLocation.lon > 98) {
    setLocationStatus('Issue notes are limited to locations in India.');
    return;
  }
  const type = document.getElementById('incident-type').value;
  const details = document.getElementById('incident-details').value.trim();
  const incident = {
    id: crypto.randomUUID(),
    type,
    details,
    lat: incidentLocation.lat,
    lon: incidentLocation.lon,
    createdAt: new Date().toISOString(),
  };
  localIncidents = [incident, ...localIncidents].slice(0, 50);
  if (!storeLocalValue(INCIDENTS_STORAGE_KEY, localIncidents)) return;
  renderLocalIncidents();
  document.getElementById('incident-form').reset();
  document.getElementById('incident-dialog').close();
  setLocationStatus('Issue note saved on this device only; it was not shared.');
}

async function searchNearby(category) {
  setSidebarExpanded(true);
  const requestId = ++nearbyRequestId;
  latestSearchId += 1;
  cancelDestinationSuggestions();
  setSearchButtonLoading(false);
  searchResults.hidden = true;
  document.querySelectorAll('.category-chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.category === category);
    chip.setAttribute('aria-pressed', String(chip.dataset.category === category));
  });
  nearbySection.hidden = false;
  nearbyList.hidden = false;
  const nearbyViewToggle = document.getElementById('nearby-view-toggle');
  nearbyViewToggle.textContent = 'Map only';
  nearbyViewToggle.setAttribute('aria-pressed', 'false');
  nearbyList.replaceChildren();
  nearbyLayer.clearLayers();
  document.getElementById('nearby-heading').textContent =
    `${CATEGORY_LABELS[category]} nearby`;
  document.getElementById('nearby-message').textContent = 'Searching nearby…';

  if (!trafficConfigured) {
    document.getElementById('nearby-message').textContent =
      'Nearby place search needs a configured TomTom key. You can still search for a destination above.';
    return;
  }

  const center = currentFix
    ? { lat: currentFix.lat, lon: currentFix.lon }
    : map.getCenter();
  const searchUsesCurrentLocation = Boolean(currentFix);
  try {
    const params = new URLSearchParams({
      category,
      lat: String(center.lat),
      lon: String(center.lon),
      radius: '10000',
    });
    const response = await fetch(`/api/nearby?${params}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Nearby place search failed.');
    if (requestId !== nearbyRequestId) return;
    renderNearbyPlaces(result.places, category);
    if (!searchUsesCurrentLocation) {
      document.getElementById('nearby-message').textContent +=
        ' Search is centered on the map, not your current location.';
    }
    if (result.places.length) {
      const bounds = L.latLngBounds(result.places.map((place) => [place.lat, place.lon]));
      if (bounds.isValid()) map.fitBounds(bounds.pad(0.15), { maxZoom: 14, animate: true });
    }
  } catch (error) {
    if (requestId !== nearbyRequestId) return;
    document.getElementById('nearby-message').textContent =
      error instanceof Error ? error.message : 'Nearby place search failed.';
  }
}

async function searchNearbyQuery(query, heading) {
  setSidebarExpanded(true);
  const requestId = ++nearbyRequestId;
  latestSearchId += 1;
  cancelDestinationSuggestions();
  setSearchButtonLoading(false);
  searchResults.hidden = true;
  document.querySelectorAll('.category-chip').forEach((chip) => {
    chip.classList.remove('active');
    chip.setAttribute('aria-pressed', 'false');
  });
  nearbySection.hidden = false;
  nearbyList.hidden = false;
  const nearbyViewToggle = document.getElementById('nearby-view-toggle');
  nearbyViewToggle.textContent = 'Map only';
  nearbyViewToggle.setAttribute('aria-pressed', 'false');
  nearbyList.replaceChildren();
  nearbyLayer.clearLayers();
  document.getElementById('nearby-heading').textContent = heading;

  if (!currentFix) {
    document.getElementById('nearby-message').textContent =
      'Current location is unavailable. Allow location access to search near you.';
    setLocationStatus('Allow location access to search for places near you.');
    return;
  }
  if (!trafficConfigured) {
    document.getElementById('nearby-message').textContent =
      'Nearby place search needs a configured TomTom key.';
    return;
  }

  document.getElementById('nearby-message').textContent = 'Searching near your current location…';
  setSearchButtonLoading(true, 'Searching nearby places');
  setLocationStatus(`Searching for ${query} near your current location…`);
  try {
    const params = new URLSearchParams({
      q: query,
      lat: String(currentFix.lat),
      lon: String(currentFix.lon),
      radius: '10000',
    });
    const response = await fetch(`/api/nearby/search?${params}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Nearby place search failed.');
    if (requestId !== nearbyRequestId) return;
    renderNearbyPlaces(result.places, null, heading);
    if (result.places.length) {
      const bounds = L.latLngBounds(result.places.map((place) => [place.lat, place.lon]));
      if (bounds.isValid()) map.fitBounds(bounds.pad(0.15), { maxZoom: 14, animate: true });
      setLocationStatus(`${result.places.length} results near your location.`);
    }
  } catch (error) {
    if (requestId !== nearbyRequestId) return;
    document.getElementById('nearby-message').textContent =
      error instanceof Error ? error.message : 'Nearby place search failed.';
    setLocationStatus('Nearby place search failed.');
  } finally {
    if (requestId === nearbyRequestId) setSearchButtonLoading(false);
  }
}

function cancelDestinationSuggestions() {
  if (suggestionTimer !== null) clearTimeout(suggestionTimer);
  suggestionTimer = null;
  suggestionRequestId += 1;
  if (suggestionController) suggestionController.abort();
  suggestionController = null;
}

async function findPlaces(query, kind) {
  const searchId = ++latestSearchId;
  setSearchButtonLoading(true, 'Searching places');
  setLocationStatus('Searching places in India…');
  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Place search failed.');
    if (searchId !== latestSearchId) return;
    if (!result.places.length) {
      searchResults.hidden = true;
      setLocationStatus('No matching places found in India. Try adding a city or area.');
      return;
    }

    document.getElementById('search-heading').textContent =
      kind === 'origin' ? 'Choose your starting point' : 'Choose your destination';
    placeOptions.replaceChildren();
    for (const place of result.places) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'place-option';
      option.textContent = place.label;
      option.addEventListener('click', () => selectPlace(place, kind));
      placeOptions.append(option);
    }
    searchResults.hidden = false;
    setLocationStatus(`${result.places.length} matching place${result.places.length === 1 ? '' : 's'} found`);
  } catch (error) {
    setLocationStatus(error instanceof Error ? error.message : 'Place search failed.');
  } finally {
    if (searchId === latestSearchId) setSearchButtonLoading(false);
  }
}

function showSuggestionMessage(message) {
  placeOptions.replaceChildren();
  activeSuggestionIndex = -1;
  const notice = document.createElement('p');
  notice.className = 'suggestion-message';
  notice.textContent = message;
  placeOptions.append(notice);
  searchResults.hidden = false;
}

function renderPlaceSuggestions(places, heading = 'Suggested destinations') {
  document.getElementById('search-heading').textContent = heading;
  placeOptions.replaceChildren();
  for (const place of places) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'place-option';
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', 'false');
    const [nameText, ...addressParts] = place.label.split(',');
    const name = document.createElement('strong');
    name.className = 'suggestion-name';
    name.textContent = nameText.trim();
    const details = document.createElement('div');
    details.className = 'suggestion-details';
    details.textContent = addressParts.join(',').trim() || place.label;
    option.append(name, details);
    if (Number.isFinite(place.lat) && Number.isFinite(place.lon)) {
      const distance = distanceLabel(place);
      if (distance) {
        const distanceText = document.createElement('small');
        distanceText.className = 'suggestion-distance';
        distanceText.textContent = `${distance} away`;
        option.append(distanceText);
      }
    }
    option.addEventListener('click', () => selectPlace(place, 'destination'));
    placeOptions.append(option);
  }
  activeSuggestionIndex = -1;
  searchResults.hidden = false;
}

function showRecentSearches() {
  if (!recentPlaces.length) {
    searchResults.hidden = true;
    return;
  }
  renderPlaceSuggestions(recentPlaces, 'Recent places · saved on this device');
}

function moveSuggestionSelection(direction) {
  const options = [...placeOptions.querySelectorAll('button.place-option')];
  if (!options.length) return false;
  activeSuggestionIndex = (activeSuggestionIndex + direction + options.length) % options.length;
  options.forEach((option, index) => {
    const selected = index === activeSuggestionIndex;
    option.classList.toggle('active', selected);
    option.setAttribute('aria-selected', String(selected));
  });
  options[activeSuggestionIndex].scrollIntoView({ block: 'nearest' });
  return true;
}

function extractNearbySearchTerm(query) {
  const qualifier = /\b(?:near\s+me|nearby|near\s+my\s+location|near\s+my\s+current\s+location|around\s+me|close\s+by|close\s+to\s+me|in\s+my\s+area)\b/i;
  if (!qualifier.test(query)) return null;
  return query
    .replace(/\b(?:near\s+me|nearby|near\s+my\s+location|near\s+my\s+current\s+location|around\s+me|close\s+by|close\s+to\s+me|in\s+my\s+area)\b/gi, ' ')
    .replace(/[\s,]+/g, ' ')
    .trim();
}

function scheduleDestinationSuggestions() {
  if (suggestionTimer !== null) clearTimeout(suggestionTimer);
  suggestionTimer = null;
  suggestionRequestId += 1;
  const requestId = suggestionRequestId;
  if (suggestionController) suggestionController.abort();
  suggestionController = null;

  const query = destinationInput.value.trim();
  if (query.length < 2) {
    showRecentSearches();
    return;
  }

  const nearbyQuery = extractNearbySearchTerm(query);
  if (nearbyQuery !== null) {
    showSuggestionMessage(
      nearbyQuery.length >= 2
        ? 'Press Search to find matching places near your current location.'
        : 'Enter a place or business before “near me”.',
    );
    return;
  }

  document.getElementById('search-heading').textContent = 'Suggested destinations';
  if (!trafficConfigured) {
    showSuggestionMessage('Live suggestions require a TomTom key. Press Find routes to search places instead.');
    return;
  }
  showSuggestionMessage('Looking for places…');
  suggestionTimer = setTimeout(async () => {
    const controller = new AbortController();
    suggestionController = controller;
    try {
      const response = await fetch(`/api/suggestions?q=${encodeURIComponent(query)}`, {
        signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Place suggestions failed.');
      if (requestId !== suggestionRequestId || query !== destinationInput.value.trim()) return;
      if (result.places.length) {
        renderPlaceSuggestions(result.places);
      } else {
        showSuggestionMessage('No matching places. Try adding a city or area.');
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (requestId !== suggestionRequestId) return;
      showSuggestionMessage(error instanceof Error ? error.message : 'Place suggestions failed.');
    } finally {
      if (suggestionController === controller) suggestionController = null;
    }
  }, 350);
}

function searchForDestination() {
  const query = destinationInput.value.trim();
  if (query.length < 2) {
    destinationInput.focus();
    setLocationStatus('Enter a destination to find routes.');
    return;
  }
  const nearbyQuery = extractNearbySearchTerm(query);
  if (nearbyQuery !== null) {
    if (nearbyQuery.length < 2) {
      setLocationStatus('Enter a place or business before “near me”.');
      return;
    }
    destinationPlace = null;
    clearRouteState();
    searchNearbyQuery(nearbyQuery, query);
    return;
  }
  const firstSuggestion = placeOptions.querySelector('button.place-option');
  if (!destinationPlace && !searchResults.hidden && firstSuggestion) {
    firstSuggestion.click();
    return;
  }
  destinationPlace = null;
  clearRouteState();
  findPlaces(query, 'destination');
}

function selectedStart() {
  if (manualOrigin) return manualOriginPlace;
  if (!currentFix) return null;
  return {
    label: 'My location',
    lat: currentFix.lat,
    lon: currentFix.lon,
  };
}

async function requestRouteData(start, destination) {
  const response = await fetch('/api/routes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start, destination }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Route search failed.');
  return result;
}

async function loadRoutes({ rerouting = false } = {}) {
  const start = selectedStart();
  if (!start) {
    awaitingLocationForRoute = Boolean(destinationPlace && !manualOrigin);
    setLocationStatus('Waiting for location. Set a starting place manually if needed.');
    return;
  }
  if (!destinationPlace) {
    searchForDestination();
    return;
  }

  const requestId = ++latestSearchId;
  setSearchButtonLoading(true, rerouting ? 'Updating route' : 'Finding routes');
  setLocationStatus(rerouting ? 'Off route · finding a new path…' : 'Finding driving routes…');
  try {
    const result = await requestRouteData(start, destinationPlace);
    if (requestId !== latestSearchId) return;
    routeChoices = result.routes;
    selectedRouteIndex = 0;
    renderTrafficStatus(result.traffic);
    renderRoutes();
    drawRoutes();
    routeSection.hidden = false;
    refreshTrafficButton.disabled = !trafficConfigured;
    scheduleTrafficRefresh();
    if (!rerouting) {
      map.fitBounds(L.polyline(routeChoices[0].points).getBounds().pad(0.1), {
        maxZoom: 14,
        animate: true,
      });
    }
    setLocationStatus(result.traffic?.state === 'live' || result.traffic?.state === 'partial'
      ? `${routeChoices.length} routes · sampled TomTom traffic`
      : `${routeChoices.length} routes · non-live estimates`);
    if (activeNavigation) updateNavigationStep();
  } catch (error) {
    if (requestId === latestSearchId) {
      setLocationStatus(error instanceof Error ? error.message : 'Could not find routes.');
    }
  } finally {
    if (requestId === latestSearchId) setSearchButtonLoading(false);
  }
}

function renderTrafficStatus(traffic) {
  const state = traffic?.state || 'unavailable';
  const live = state === 'live' || state === 'partial';
  const alternativesNotice = traffic?.alternatives_notice
    ? ` ${traffic.alternatives_notice}`
    : '';
  trafficNotice.dataset.state = live ? 'live' : 'setup';
  trafficNotice.textContent = live
    ? `TomTom sampled ${traffic.sampled_segments} points across these routes; this is not a full-road traffic layer. ETAs are estimates. Drivers are not automatically assigned.${alternativesNotice}`
    : `${traffic?.notice || 'Live traffic is unavailable; showing non-live route estimates.'}${alternativesNotice}`;
  trafficSummary.hidden = !live;
  trafficSummary.textContent = live
    ? `TomTom sample time: ${new Date(traffic.sampled_at).toLocaleTimeString('en-IN')} · ${traffic.failed_samples || 0} sample requests failed · refreshes every 5 min.`
    : '';
}

function scheduleTrafficRefresh() {
  if (trafficRefreshTimer !== null) clearInterval(trafficRefreshTimer);
  trafficRefreshTimer = null;
  if (trafficConfigured && routeChoices.length) {
    trafficRefreshTimer = setInterval(() => {
      if (!document.hidden) refreshRouteTraffic();
    }, TRAFFIC_REFRESH_INTERVAL_MS);
  }
}

function sampledRoutePoints(points, maxPoints = 64) {
  if (points.length <= maxPoints) return points;
  return Array.from({ length: maxPoints }, (_, index) => {
    const sourceIndex = Math.round(index * (points.length - 1) / (maxPoints - 1));
    return points[sourceIndex];
  });
}

async function refreshRouteTraffic() {
  if (!trafficConfigured || trafficRefreshInProgress || !routeChoices.length) return;
  const requestId = latestSearchId;
  const selectedRouteId = routeChoices[selectedRouteIndex]?.id;
  trafficRefreshInProgress = true;
  refreshTrafficButton.disabled = true;
  refreshTrafficButton.textContent = 'Refreshing traffic…';
  try {
    const response = await fetch('/api/traffic/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        routes: routeChoices.map((route) => ({
          id: route.id,
          duration_min: route.duration_min,
          points: sampledRoutePoints(route.points),
        })),
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Traffic refresh failed.');
    if (requestId !== latestSearchId) return;
    const updates = new Map(result.routes.map((route) => [route.id, route]));
    routeChoices = routeChoices.map((route) => ({
      ...route,
      ...(updates.get(route.id) || {}),
    }));
    routeChoices.sort((left, right) =>
      (left.live_eta_min || left.duration_min) - (right.live_eta_min || right.duration_min));
    selectedRouteIndex = Math.max(
      0,
      routeChoices.findIndex((route) => route.id === selectedRouteId),
    );
    routeChoices.forEach((route, index) => {
      route.label = index === 0 ? 'Live estimate' : `Alternative ${index}`;
    });
    renderTrafficStatus(result.traffic);
    renderRoutes();
    drawRoutes();
    if (activeNavigation) updateNavigationStep();
  } catch (error) {
    trafficNotice.dataset.state = 'error';
    trafficNotice.textContent =
      `${error instanceof Error ? error.message : 'Traffic refresh failed.'} Last known route estimates are retained.`;
  } finally {
    trafficRefreshInProgress = false;
    refreshTrafficButton.disabled = !trafficConfigured || !routeChoices.length;
    refreshTrafficButton.textContent = 'Refresh traffic';
  }
}

function formatDistance(kilometres) {
  return kilometres < 1
    ? `${Math.round(kilometres * 1000).toLocaleString('en-IN')} m`
    : `${kilometres.toLocaleString('en-IN', { maximumFractionDigits: 1 })} km`;
}

function renderRoutes() {
  routeOptions.replaceChildren();
  document.getElementById('route-count').textContent =
    `${routeChoices.length} route${routeChoices.length === 1 ? '' : 's'}`;
  const bestEta = Math.min(...routeChoices.map((route) =>
    Number.isFinite(route.live_eta_min) ? route.live_eta_min : route.duration_min));
  const maxEtaDifference = Math.max(0, ...routeChoices.map((route) =>
    (Number.isFinite(route.live_eta_min) ? route.live_eta_min : route.duration_min) - bestEta));
  const sampledDelays = routeChoices
    .filter((route) => ['live', 'partial'].includes(route.traffic?.state)
      && Number.isFinite(route.traffic.delay_percent))
    .map((route) => Math.max(0, route.traffic.delay_percent));
  const minSampledDelay = sampledDelays.length ? Math.min(...sampledDelays) : null;
  const maxSampledDelay = sampledDelays.length ? Math.max(...sampledDelays) : null;
  document.getElementById('route-rationale').textContent =
    'Routes are ordered by estimated travel time. Alternatives provide route choices; drivers are not automatically assigned or redistributed.';
  document.getElementById('map-legend').hidden = routeChoices.length === 0;

  routeChoices.forEach((route, index) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = `route-option${index === selectedRouteIndex ? ' selected' : ''}`;
    option.setAttribute('aria-pressed', String(index === selectedRouteIndex));
    const mark = document.createElement('span');
    mark.className = 'route-mark';
    const details = document.createElement('div');
    const label = document.createElement('span');
    label.className = 'route-label';
    const etaMinutes = Number.isFinite(route.live_eta_min) ? route.live_eta_min : route.duration_min;
    label.textContent = index === 0
      ? 'Fastest estimate'
      : (route.label || `Alternative ${index}`);
    const subtitle = document.createElement('span');
    subtitle.className = 'route-subtitle';
    const routeTraffic = route.traffic || {};
    const hasTrafficSamples = ['live', 'partial'].includes(routeTraffic.state)
      && Number.isFinite(routeTraffic.delay_percent);
    const sampleText = routeTraffic.state === 'live' || routeTraffic.state === 'partial'
      ? `Traffic sampled at ${routeTraffic.sampled_segments || 0} route points`
      : 'Traffic not sampled';
    const extraTime = Math.max(0, Math.round(etaMinutes - bestEta));
    const relativeEta = maxEtaDifference > 0 ? extraTime / maxEtaDifference : 0;
    const hasDistinctTrafficDelays = hasTrafficSamples && maxSampledDelay > minSampledDelay;
    const relativeTrafficDelay = hasDistinctTrafficDelays
      ? (Math.max(0, routeTraffic.delay_percent) - minSampledDelay)
        / (maxSampledDelay - minSampledDelay)
      : relativeEta;
    const routeColor = `hsl(${Math.round(120 - relativeTrafficDelay * 120)} 55% 40%)`;
    subtitle.textContent = index === 0
      ? `${formatDistance(route.distance_km)} · ${sampleText}`
      : `${formatDistance(route.distance_km)} · ${extraTime} min more · ${sampleText}`;
    details.append(label, subtitle);
    const delayLabel = document.createElement('span');
    delayLabel.className = 'route-delay-label';
    const delayTrack = document.createElement('span');
    delayTrack.className = 'route-delay-track';
    delayTrack.setAttribute('role', 'progressbar');
    delayTrack.setAttribute(
      'aria-label',
      hasDistinctTrafficDelays
        ? 'Relative sampled traffic delay'
        : 'Relative travel time compared with fastest route',
    );
    delayTrack.setAttribute('aria-valuemin', '0');
    delayTrack.setAttribute('aria-valuemax', '100');
    delayTrack.setAttribute('aria-valuenow', String(Math.round(relativeTrafficDelay * 100)));
    const delayFill = document.createElement('span');
    delayFill.className = 'route-delay-fill';
    mark.style.setProperty('--route-color', routeColor);
    delayLabel.textContent = hasDistinctTrafficDelays
      ? `Sampled delay ${Math.max(0, routeTraffic.delay_percent)}% · ${extraTime} min slower`
      : `Relative ETA +${extraTime} min${hasTrafficSamples
      ? ` · sampled delay ${Math.max(0, routeTraffic.delay_percent)}%`
      : ' · no live sample'}`;
    delayFill.style.width = `${8 + relativeTrafficDelay * 92}%`;
    delayFill.style.backgroundColor = routeColor;
    delayTrack.append(delayFill);
    details.append(delayLabel, delayTrack);
    const time = document.createElement('span');
    time.className = 'route-time';
    time.append(document.createTextNode(`${etaMinutes} min`));
    const etaLabel = document.createElement('small');
    etaLabel.textContent = Number.isFinite(route.live_eta_min) ? 'sampled estimate' : 'estimate';
    time.append(etaLabel);
    option.append(mark, details, time);
    option.addEventListener('click', () => {
      selectedRouteIndex = index;
      renderRoutes();
      drawRoutes();
      if (activeNavigation) updateNavigationStep();
    });
    routeOptions.append(option);
  });
}

function drawRoutes() {
  routeLayer.clearLayers();
  placeLayer.clearLayers();
  routeChoices.forEach((route, index) => {
    L.polyline(route.points, {
      color: index === selectedRouteIndex ? '#137b68' : ROUTE_COLORS[index % ROUTE_COLORS.length],
      weight: index === selectedRouteIndex ? 6 : 4,
      opacity: index === selectedRouteIndex ? 0.95 : 0.55,
      lineCap: 'round',
      lineJoin: 'round',
      bubblingMouseEvents: false,
    }).bindTooltip(`${index === selectedRouteIndex ? 'Selected route' : (index === 0 ? 'Fastest estimate' : `Alternative ${index}`)} · ${route.duration_min} min`)
      .addTo(routeLayer);
  });
  if (destinationPlace) {
    L.marker([destinationPlace.lat, destinationPlace.lon])
      .bindTooltip('Destination')
      .addTo(placeLayer);
  }
  document.getElementById('start-navigation').disabled = routeChoices.length === 0;
}

function clearRouteState() {
  if (trafficRefreshTimer !== null) clearInterval(trafficRefreshTimer);
  trafficRefreshTimer = null;
  awaitingLocationForRoute = false;
  routeChoices = [];
  selectedRouteIndex = 0;
  activeNavigation = false;
  offRouteReadings = 0;
  routeSection.hidden = true;
  document.getElementById('map-legend').hidden = true;
  document.getElementById('navigation-card').hidden = true;
  document.getElementById('start-navigation').hidden = false;
  routeLayer.clearLayers();
  placeLayer.clearLayers();
}

function distanceToSegmentMetres(point, start, end) {
  const latitudeScale = 111_320;
  const longitudeScale = latitudeScale * Math.cos(point[0] * Math.PI / 180);
  const px = point[1] * longitudeScale;
  const py = point[0] * latitudeScale;
  const ax = start[1] * longitudeScale;
  const ay = start[0] * latitudeScale;
  const bx = end[1] * longitudeScale;
  const by = end[0] * latitudeScale;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const fraction = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + fraction * dx), py - (ay + fraction * dy));
}

function distanceFromRoute(point, route) {
  let nearest = Infinity;
  for (let index = 1; index < route.points.length; index += 1) {
    nearest = Math.min(
      nearest,
      distanceToSegmentMetres(point, route.points[index - 1], route.points[index]),
    );
  }
  return nearest;
}

function updateNavigationStep() {
  if (!activeNavigation || !currentFix || !routeChoices[selectedRouteIndex]) return;
  const route = routeChoices[selectedRouteIndex];
  const routeLength = route.points.reduce((total, point, index) => {
    if (index === 0) return total;
    return total + haversineMetres(
      { lat: route.points[index - 1][0], lon: route.points[index - 1][1] },
      { lat: point[0], lon: point[1] },
    );
  }, 0);
  let completedDistance = 0;
  let cumulativeDistance = 0;
  let nearestDistance = Infinity;
  route.points.forEach((point, index) => {
    if (index > 0) {
      const previousPoint = route.points[index - 1];
      cumulativeDistance += haversineMetres(
        { lat: previousPoint[0], lon: previousPoint[1] },
        { lat: point[0], lon: point[1] },
      );
    }
    const distance = haversineMetres(currentFix, { lat: point[0], lon: point[1] });
    if (distance < nearestDistance) {
      nearestDistance = distance;
      completedDistance = cumulativeDistance;
    }
  });
  const progress = routeLength > 0 ? Math.min(1, completedDistance / routeLength) : 0;
  const selectedRouteProgress = routeOptions.querySelector(
    '.route-option.selected .route-delay-track',
  );
  const selectedRouteProgressLabel = routeOptions.querySelector(
    '.route-option.selected .route-delay-label',
  );
  if (selectedRouteProgress && selectedRouteProgressLabel) {
    const progressPercent = Math.round(progress * 100);
    selectedRouteProgress.setAttribute('aria-label', 'Trip progress on selected route');
    selectedRouteProgress.setAttribute('aria-valuenow', String(progressPercent));
    selectedRouteProgressLabel.textContent = `Trip progress ${progressPercent}%`;
    selectedRouteProgress.firstElementChild.style.width = `${progressPercent}%`;
  }
  const remainingKm = (route.distance_km || routeLength / 1000) * (1 - progress);
  const totalMinutes = Number.isFinite(route.live_eta_min) ? route.live_eta_min : route.duration_min;
  const remainingMinutes = Math.ceil(totalMinutes * (1 - progress));
  document.getElementById('trip-progress').textContent =
    `Approx. ${formatDistance(remainingKm)} remaining · ${remainingMinutes} min by current estimate`;

  const instructions = route.instructions;
  if (!instructions.length) return;
  const point = [currentFix.lat, currentFix.lon];
  let closestIndex = 0;
  let closestDistance = Infinity;
  instructions.forEach((step, index) => {
    const distance = distanceToSegmentMetres(point, step.location, step.location);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index;
    }
  });
  const next = instructions[Math.min(closestIndex + 1, instructions.length - 1)];
  document.getElementById('next-step').textContent = next.text;
  document.getElementById('next-distance').textContent =
    next.location
      ? `Approx. to next turn · ${formatDistance(haversineMetres(currentFix, {
        lat: next.location[0],
        lon: next.location[1],
      }) / 1000)}`
      : '';
}

function checkOffRoute() {
  if (!activeNavigation || !currentFix || currentFix.accuracy > 50
      || !routeChoices[selectedRouteIndex] || manualOrigin) return;
  const distance = distanceFromRoute(
    [currentFix.lat, currentFix.lon],
    routeChoices[selectedRouteIndex],
  );
  offRouteReadings = distance > 120 ? offRouteReadings + 1 : 0;
  if (offRouteReadings < 3 || Date.now() - lastRerouteAt < 45_000) return;
  offRouteReadings = 0;
  lastRerouteAt = Date.now();
  loadRoutes({ rerouting: true });
}

document.getElementById('sidebar-toggle').addEventListener('click', () => {
  setSidebarExpanded(!sidebar.classList.contains('expanded'));
});

document.getElementById('open-home-panel').addEventListener('click', () => {
  setSidebarExpanded(true);
});

document.getElementById('open-recents-panel').addEventListener('click', () => {
  setSidebarExpanded(true);
  document.getElementById('recent-heading').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

routeForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (extractNearbySearchTerm(destinationInput.value.trim()) !== null) {
    searchForDestination();
    return;
  }
  if (manualOrigin && !manualOriginPlace) {
    const query = originInput.value.trim();
    if (query.length < 2) {
      originInput.focus();
      setLocationStatus('Enter a starting place, or use your current location.');
      return;
    }
    findPlaces(query, 'origin');
    return;
  }
  searchForDestination();
});

destinationInput.addEventListener('focus', () => {
  updateSearchPrompt();
  if (!destinationInput.value.trim()) showRecentSearches();
});
destinationInput.addEventListener('blur', updateSearchPrompt);

destinationInput.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    if (!searchResults.hidden && moveSuggestionSelection(1)) event.preventDefault();
  } else if (event.key === 'ArrowUp') {
    if (!searchResults.hidden && moveSuggestionSelection(-1)) event.preventDefault();
  } else if (event.key === 'Enter' && !searchResults.hidden) {
    const options = placeOptions.querySelectorAll('button.place-option');
    const option = options[activeSuggestionIndex] || options[0];
    if (option) {
      event.preventDefault();
      option.click();
    }
  } else if (event.key === 'Escape' && !searchResults.hidden) {
    event.preventDefault();
    searchResults.hidden = true;
    activeSuggestionIndex = -1;
  }
});

document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('.map-tools')) searchResults.hidden = true;
});

document.getElementById('location-button').addEventListener('click', () => {
  if (manualOrigin) {
    setOriginMode(false);
    clearRouteState();
    setLocationStatus('Using your current location');
  } else if (!manualOrigin) {
    setOriginMode(true);
    setLocationStatus('Search for a starting point.');
  }
});

document.getElementById('find-origin').addEventListener('click', () => {
  const query = originInput.value.trim();
  if (query.length < 2) {
    originInput.focus();
    setLocationStatus('Enter a starting place to search.');
    return;
  }
  findPlaces(query, 'origin');
});

document.getElementById('use-current-location').addEventListener('click', () => {
  setOriginMode(false);
  clearRouteState();
  setLocationStatus(currentFix ? 'Using your current location' : 'Waiting for your location.');
});

document.getElementById('home-shortcut').addEventListener('click', () => {
  if (homePlace) {
    selectDestination(homePlace);
    return;
  }
  isPickingHome = true;
  destinationInput.focus();
  setLocationStatus('Search for a place and choose it as Home.');
});

document.getElementById('set-current-home').addEventListener('click', () => {
  const saveCurrentLocationAsHome = (position) => {
    const place = {
      label: 'Current location',
      lat: position.coords.latitude ?? position.coords.lat,
      lon: position.coords.longitude ?? position.coords.lon,
    };
    if (saveHomePlace(place)) setSidebarExpanded(false);
  };

  if (currentFix) {
    saveCurrentLocationAsHome({ coords: currentFix });
    return;
  }
  if (!navigator.geolocation) {
    setLocationStatus('This browser does not support location. Search for your Home place instead.');
    return;
  }

  setLocationStatus('Getting your current location to save Home…');
  navigator.geolocation.getCurrentPosition(
    saveCurrentLocationAsHome,
    (error) => {
      if (error.code === 1) {
        setLocationStatus('Location permission was denied. Search for your Home place instead.');
      } else {
        setLocationStatus('Could not get your current location. Try again or search for your Home place.');
      }
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
  );
});

document.getElementById('change-home').addEventListener('click', () => {
  isPickingHome = true;
  destinationInput.focus();
  setLocationStatus('Search for a new place to save as Home.');
});

document.getElementById('clear-recents').addEventListener('click', () => {
  recentPlaces = [];
  if (storeLocalValue(RECENTS_STORAGE_KEY, recentPlaces)) renderSavedPlaces();
});

document.getElementById('clear-nearby').addEventListener('click', () => {
  nearbyRequestId += 1;
  nearbySection.hidden = true;
  nearbyList.hidden = false;
  nearbyList.replaceChildren();
  nearbyLayer.clearLayers();
  document.querySelectorAll('.category-chip').forEach((chip) => {
    chip.classList.remove('active');
    chip.setAttribute('aria-pressed', 'false');
  });
  setLocationStatus('Nearby results hidden.');
});

document.getElementById('nearby-view-toggle').addEventListener('click', (event) => {
  const showMapOnly = !nearbyList.hidden;
  nearbyList.hidden = showMapOnly;
  event.currentTarget.textContent = showMapOnly ? 'Show list' : 'Map only';
  event.currentTarget.setAttribute('aria-pressed', String(showMapOnly));
  if (showMapOnly) map.invalidateSize();
});

document.querySelectorAll('.category-chip').forEach((chip) => {
  chip.setAttribute('aria-pressed', String(chip.classList.contains('active')));
  chip.addEventListener('click', () => searchNearby(chip.dataset.category));
});

originInput.addEventListener('input', () => {
  manualOriginPlace = null;
  clearRouteState();
});
destinationInput.addEventListener('input', () => {
  destinationPlace = null;
  mapPinSelected = false;
  updateSearchPrompt();
  clearRouteState();
  scheduleDestinationSuggestions();
});

document.getElementById('start-navigation').addEventListener('click', () => {
  if (!routeChoices.length) return;
  activeNavigation = true;
  document.getElementById('navigation-card').hidden = false;
  document.getElementById('start-navigation').hidden = true;
  updateNavigationStep();
  setLocationStatus('Navigation started · route times do not include live traffic');
  checkOffRoute();
});

document.getElementById('stop-navigation').addEventListener('click', () => {
  activeNavigation = false;
  offRouteReadings = 0;
  if (routeChoices.length) renderRoutes();
  document.getElementById('navigation-card').hidden = true;
  document.getElementById('start-navigation').hidden = false;
  setLocationStatus(currentFix ? 'Location ready' : 'Navigation ended');
});

function recenterMapOnCurrentLocation() {
  if (currentFix) map.setView([currentFix.lat, currentFix.lon], 16, { animate: true });
  else setLocationStatus('Current location is unavailable. Allow location access or set a start manually.');
}

document.getElementById('recenter-button').addEventListener('click', recenterMapOnCurrentLocation);
locationIndicator.addEventListener('click', recenterMapOnCurrentLocation);

document.getElementById('report-issue').addEventListener('click', () => openIncidentDialog());
document.getElementById('incident-pick-location').addEventListener('click', () => {
  document.getElementById('incident-dialog').close();
  isPickingIncident = true;
  setLocationStatus('Tap the map to place your private issue note.');
});
document.getElementById('incident-cancel').addEventListener('click', () => {
  isPickingIncident = false;
  document.getElementById('incident-dialog').close();
});
document.getElementById('incident-form').addEventListener('submit', saveLocalIncident);

map.on('click', (event) => {
  if (isPickingIncident) {
    isPickingIncident = false;
    openIncidentDialog({ lat: event.latlng.lat, lon: event.latlng.lng });
    return;
  }

  // Check if sidebar is expanded or search results/nearby section are visible
  const sidebarExpanded = sidebar.classList.contains('expanded');
  const searchResultsVisible = !searchResults.hidden;
  const nearbySectionVisible = !nearbySection.hidden;

  // If any of these are open, collapse them instead of setting destination
  if (sidebarExpanded || searchResultsVisible || nearbySectionVisible) {
    // Collapse sidebar on desktop (not on mobile where it's always expanded)
    const mobileLayout = window.matchMedia('(max-width: 680px)');
    if (sidebarExpanded && !mobileLayout.matches) {
      setSidebarExpanded(false);
    }

    // Hide search results
    if (searchResultsVisible) {
      searchResults.hidden = true;
    }

    // Hide nearby section and clear category selection
    if (nearbySectionVisible) {
      nearbyRequestId += 1;
      nearbySection.hidden = true;
      nearbyList.hidden = false;
      nearbyList.replaceChildren();
      nearbyLayer.clearLayers();
      document.querySelectorAll('.category-chip').forEach((chip) => {
        chip.classList.remove('active');
        chip.setAttribute('aria-pressed', 'false');
      });
    }

    // Don't set a destination, just close the overlays
    return;
  }

  // If a pin is already selected, clear it
  if (mapPinSelected && !isPickingHome) {
    latestSearchId += 1;
    mapPinSelected = false;
    destinationPlace = null;
    destinationInput.value = '';
    updateSearchPrompt();
    searchResults.hidden = true;
    clearRouteState();
    setSearchButtonLoading(false);
    setLocationStatus('Map destination cleared. Tap again to choose a new place.');
    return;
  }

  // Only set destination if nothing is open
  setMapDestination(event.latlng.lat, event.latlng.lng);
  if (!isPickingHome) mapPinSelected = true;
});

refreshTrafficButton.addEventListener('click', refreshRouteTraffic);

renderSavedPlaces();
renderLocalIncidents();
const mobileLayout = window.matchMedia('(max-width: 680px)');
setSidebarExpanded(mobileLayout.matches);
mobileLayout.addEventListener('change', (event) => setSidebarExpanded(event.matches));
loadTrafficStatus();
startLocationTracking();
updateSearchPrompt();
