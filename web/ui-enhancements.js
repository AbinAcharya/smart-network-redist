// ============================================
// UI/UX ENHANCEMENTS - Premium Features
// ============================================

// Toast Notification System
// ============================================
const ToastManager = {
  container: null,
  toasts: new Map(),

  init() {
    if (!this.container) {
      this.container = document.createElement('div');
      this.container.className = 'toast-container';
      document.body.appendChild(this.container);
    }
  },

  show(message, type = 'info', duration = 4000) {
    this.init();

    const id = `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');

    const icons = {
      success: '✓',
      error: '✕',
      info: 'ℹ'
    };

    toast.innerHTML = `
      <span class="toast-icon" aria-hidden="true">${icons[type] || icons.info}</span>
      <div class="toast-content">
        <p class="toast-message">${message}</p>
      </div>
      <button class="toast-dismiss" type="button" aria-label="Dismiss notification">×</button>
    `;

    const dismissBtn = toast.querySelector('.toast-dismiss');
    dismissBtn.addEventListener('click', () => this.dismiss(id));

    this.container.appendChild(toast);
    this.toasts.set(id, { element: toast, timer: null });

    // Auto dismiss after duration
    if (duration > 0) {
      const timer = setTimeout(() => this.dismiss(id), duration);
      this.toasts.get(id).timer = timer;
    }

    return id;
  },

  dismiss(id) {
    const toastData = this.toasts.get(id);
    if (!toastData) return;

    const { element, timer } = toastData;
    if (timer) clearTimeout(timer);

    element.classList.add('toast-exit');
    element.addEventListener('animationend', () => {
      element.remove();
      this.toasts.delete(id);
    });
  },

  success(message, duration) {
    return this.show(message, 'success', duration);
  },

  error(message, duration) {
    return this.show(message, 'error', duration);
  },

  info(message, duration) {
    return this.show(message, 'info', duration);
  }
};

function formatDurationMinutes(totalMinutes) {
  const minutes = Math.max(0, Math.ceil(totalMinutes));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainingMinutes = minutes % 60;
  const parts = [];

  if (days) parts.push(`${days} day${days === 1 ? '' : 's'}`);
  if (hours) parts.push(`${hours} hr`);
  if (remainingMinutes || parts.length === 0) {
    parts.push(`${remainingMinutes} min`);
  }
  return parts.join(' ');
}

// Enhanced Location Marker with Pulse
// ============================================
function createPulsingLocationMarker(latlng) {
  const pulsingIcon = L.divIcon({
    className: 'current-location-pulse',
    html: `
      <div style="
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: #2785ed;
        border: 3px solid #fff;
        box-shadow: 0 2px 8px rgba(39, 133, 237, 0.4);
      "></div>
    `,
    iconSize: [16, 16],
    iconAnchor: [8, 8]
  });

  return L.marker(latlng, { icon: pulsingIcon });
}

// Skeleton Loading State
// ============================================
function createRouteSkeleton(count = 3) {
  const skeletons = [];
  for (let i = 0; i < count; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'route-skeleton';
    skeleton.innerHTML = `
      <span class="skeleton skeleton-mark"></span>
      <div>
        <div class="skeleton skeleton-text" style="width: 60%;"></div>
        <div class="skeleton skeleton-text-small" style="width: 85%;"></div>
      </div>
      <div class="skeleton skeleton-number"></div>
    `;
    skeletons.push(skeleton);
  }
  return skeletons;
}

function showRouteLoadingState(container) {
  container.replaceChildren();
  const skeletons = createRouteSkeleton(3);
  skeletons.forEach(skeleton => container.appendChild(skeleton));
}

function createPlaceSkeleton(count = 5) {
  const skeletons = [];
  for (let i = 0; i < count; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'recent-place';
    skeleton.style.pointerEvents = 'none';
    skeleton.innerHTML = `
      <span class="skeleton" style="width: 36px; height: 36px; border-radius: 50%;"></span>
      <div style="flex: 1; min-width: 0;">
        <div class="skeleton skeleton-text" style="width: 50%; margin-bottom: 6px;"></div>
        <div class="skeleton skeleton-text-small" style="width: 75%;"></div>
      </div>
    `;
    skeletons.push(skeleton);
  }
  return skeletons;
}

// Route Drawing Animation
// ============================================
let routeDrawCounter = 0;

function drawRoutesWithAnimation(routes, routeLayer, selectedIndex, colors) {
  routeLayer.clearLayers();
  routeDrawCounter++;
  const currentDrawId = routeDrawCounter;

  routes.forEach((route, index) => {
    if (currentDrawId !== routeDrawCounter) return; // Animation was cancelled

    const polyline = L.polyline(route.points, {
      color: index === selectedIndex ? '#137b68' : colors[index % colors.length],
      weight: index === selectedIndex ? 6 : 4,
      opacity: index === selectedIndex ? 0.95 : 0.55,
      lineCap: 'round',
      lineJoin: 'round',
      bubblingMouseEvents: false,
      className: 'animated-route'
    });

    polyline.bindTooltip(
      `${index === selectedIndex ? 'Selected route' : (index === 0 ? 'Fastest estimate' : `Alternative ${index}`)} · ${formatDurationMinutes(route.duration_min)}`
    );

    polyline.addTo(routeLayer);
  });
}

// Enhanced setLocationStatus with Toast
// ============================================
const originalSetLocationStatus = window.setLocationStatus;
const statusMessageHistory = [];

window.enhancedSetLocationStatus = function(message, showToast = false, toastType = 'info') {
  // Call original function
  if (typeof originalSetLocationStatus === 'function') {
    originalSetLocationStatus(message);
  }

  // Show toast for important updates
  if (showToast && statusMessageHistory[statusMessageHistory.length - 1] !== message) {
    ToastManager.show(message, toastType, 3500);
  }

  statusMessageHistory.push(message);
  if (statusMessageHistory.length > 10) statusMessageHistory.shift();
};

// Enhanced Wrapper Functions
// ============================================

// Wrap route rendering with loading state
window.enhancedLoadRoutes = function(originalLoadRoutes) {
  return async function(...args) {
    const routeOptions = document.getElementById('route-options');
    if (routeOptions) {
      showRouteLoadingState(routeOptions);
    }
    return originalLoadRoutes.apply(this, args);
  };
};

// Integration Helpers
// ============================================

// Hook into home save
const originalSaveHomePlace = window.saveHomePlace;
if (typeof originalSaveHomePlace === 'function') {
  window.saveHomePlace = function(place) {
    const result = originalSaveHomePlace(place);
    if (result) {
      ToastManager.success('Home location saved successfully');
    }
    return result;
  };
}

// Hook into recent place additions
const originalAddRecentPlace = window.addRecentPlace;
if (typeof originalAddRecentPlace === 'function') {
  window.addRecentPlace = function(place) {
    const result = originalAddRecentPlace(place);
    ToastManager.info('Place added to recent destinations');
    return result;
  };
}

// Enhanced navigation start
document.addEventListener('DOMContentLoaded', function() {
  const startNavButton = document.getElementById('start-navigation');
  if (startNavButton) {
    startNavButton.addEventListener('click', function() {
      setTimeout(() => {
        ToastManager.success('Navigation started', 3000);
      }, 100);
    });
  }

  const stopNavButton = document.getElementById('stop-navigation');
  if (stopNavButton) {
    stopNavButton.addEventListener('click', function() {
      ToastManager.info('Navigation ended');
    });
  }

  // Enhanced clear recents
  const clearRecentsBtn = document.getElementById('clear-recents');
  if (clearRecentsBtn) {
    const originalClick = clearRecentsBtn.onclick;
    clearRecentsBtn.onclick = function(e) {
      if (originalClick) originalClick.call(this, e);
      ToastManager.success('Recent places cleared');
    };
  }

  // Enhanced home set
  const setCurrentHomeBtn = document.getElementById('set-current-home');
  if (setCurrentHomeBtn) {
    setCurrentHomeBtn.addEventListener('click', function() {
      ToastManager.info('Setting current location as home...');
    });
  }

  // Toast for traffic refresh
  const refreshTrafficBtn = document.getElementById('refresh-traffic');
  if (refreshTrafficBtn) {
    refreshTrafficBtn.addEventListener('click', function() {
      if (!this.disabled) {
        ToastManager.info('Refreshing traffic data...');
      }
    });
  }
});

// Smooth Scroll Helpers
// ============================================
function smoothScrollToElement(element, offset = 0) {
  if (!element) return;

  const elementPosition = element.getBoundingClientRect().top;
  const offsetPosition = elementPosition + window.pageYOffset - offset;

  window.scrollTo({
    top: offsetPosition,
    behavior: 'smooth'
  });
}

// Export for use in other scripts
window.UIEnhancements = {
  toast: ToastManager,
  createPulsingLocationMarker,
  createRouteSkeleton,
  showRouteLoadingState,
  createPlaceSkeleton,
  formatDurationMinutes,
  drawRoutesWithAnimation,
  smoothScrollToElement,
  enhancedSetLocationStatus: window.enhancedSetLocationStatus
};

// Initialize on load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => ToastManager.init());
} else {
  ToastManager.init();
}

console.log('✨ UI Enhancements loaded successfully');
