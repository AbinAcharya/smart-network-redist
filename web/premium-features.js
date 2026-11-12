// ============================================
// PREMIUM FEATURES - Interactive Functionality
// ============================================

// 1. NUMBER COUNTER ANIMATIONS
// ============================================
function animateNumber(element, newValue, duration = 600) {
  if (!element || element.textContent === newValue) return;

  const oldText = element.textContent;
  const oldNumber = parseFloat(oldText.replace(/[^0-9.]/g, ''));
  const newNumber = parseFloat(newValue.replace(/[^0-9.]/g, ''));

  if (isNaN(oldNumber) || isNaN(newNumber)) {
    element.textContent = newValue;
    return;
  }

  element.classList.add('updating');

  const startTime = performance.now();
  const diff = newNumber - oldNumber;
  const suffix = newValue.replace(/[0-9.,]/g, '');

  function update(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic

    const current = oldNumber + (diff * eased);
    const formatted = Math.round(current).toLocaleString('en-IN');
    element.textContent = formatted + suffix;

    if (progress < 1) {
      requestAnimationFrame(update);
    } else {
      element.classList.remove('updating');
      element.textContent = newValue;
    }
  }

  requestAnimationFrame(update);
}

// Wrap route rendering to add number animations
const originalRenderRoutes = window.renderRoutes;
if (typeof originalRenderRoutes === 'function') {
  window.renderRoutes = function(...args) {
    const result = originalRenderRoutes.apply(this, args);

    // Animate the numbers after rendering
    setTimeout(() => {
      document.querySelectorAll('.route-time').forEach(timeEl => {
        const textContent = timeEl.textContent;
        if (textContent) {
          timeEl.style.opacity = '0';
          setTimeout(() => {
            timeEl.style.opacity = '1';
          }, 50);
        }
      });
    }, 100);

    return result;
  };
}

// 2. ROUTE HOVER HIGHLIGHTING
// ============================================
let routePolylines = [];
let routeCards = [];

function setupRouteHoverHighlighting() {
  const routeOptions = document.getElementById('route-options');
  if (!routeOptions) return;

  routeCards = Array.from(routeOptions.querySelectorAll('.route-option'));

  routeCards.forEach((card, index) => {
    // Hover on card → highlight map route
    card.addEventListener('mouseenter', () => {
      card.classList.add('route-highlighted');
      highlightMapRoute(index, true);
    });

    card.addEventListener('mouseleave', () => {
      card.classList.remove('route-highlighted');
      highlightMapRoute(index, false);
    });
  });
}

function highlightMapRoute(index, highlight) {
  // Find the corresponding polyline on the map
  const routeLayer = window.routeLayer;
  if (!routeLayer) return;

  let polylineIndex = 0;
  routeLayer.eachLayer((layer) => {
    if (layer instanceof L.Polyline) {
      if (polylineIndex === index) {
        const element = layer.getElement();
        if (element) {
          if (highlight) {
            element.classList.add('route-hover-highlight');
            element.style.strokeWidth = '8';
            layer.bringToFront();
          } else {
            element.classList.remove('route-hover-highlight');
            element.style.strokeWidth = index === window.selectedRouteIndex ? '6' : '4';
          }
        }
      }
      polylineIndex++;
    }
  });
}

// Re-setup highlighting when routes are drawn
const originalDrawRoutes = window.drawRoutes;
if (typeof originalDrawRoutes === 'function') {
  window.drawRoutes = function(...args) {
    const result = originalDrawRoutes.apply(this, args);
    setTimeout(() => setupRouteHoverHighlighting(), 100);
    return result;
  };
}

// 3. EMPTY STATE ILLUSTRATIONS
// ============================================
function createEmptyState(config) {
  const container = document.createElement('div');
  container.className = 'empty-state-container';

  const icon = document.createElement('div');
  icon.className = 'empty-state-icon';
  icon.innerHTML = config.icon || '📍';

  const title = document.createElement('h3');
  title.className = 'empty-state-title';
  title.textContent = config.title;

  const description = document.createElement('p');
  description.className = 'empty-state-description';
  description.textContent = config.description;

  container.appendChild(icon);
  container.appendChild(title);
  container.appendChild(description);

  if (config.action) {
    const button = document.createElement('button');
    button.className = 'empty-state-action';
    button.textContent = config.action.label;
    button.onclick = config.action.onClick;
    container.appendChild(button);
  }

  return container;
}

// Apply empty states
function setupEmptyStates() {
  const recentList = document.getElementById('recent-list');
  const nearbyList = document.getElementById('nearby-list');

  if (recentList && recentList.children.length === 0) {
    const emptyNote = document.getElementById('recent-empty');
    if (emptyNote && !emptyNote.hidden) {
      emptyNote.replaceWith(createEmptyState({
        icon: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3m10-10h-3M5 12H2m16.364-6.364l-2.121 2.121M7.757 16.243L5.636 18.364m12.728 0l-2.121-2.121M7.757 7.757L5.636 5.636"/></svg>`,
        title: 'No recent places yet',
        description: 'Places you visit will appear here for quick access later'
      }));
    }
  }
}

// 4. PULL TO REFRESH
// ============================================
class PullToRefresh {
  constructor() {
    this.container = null;
    this.pullElement = null;
    this.startY = 0;
    this.currentY = 0;
    this.isDragging = false;
    this.threshold = 80;
    this.isRefreshing = false;

    this.init();
  }

  init() {
    // Create pull to refresh UI
    this.container = document.createElement('div');
    this.container.className = 'pull-to-refresh-container';

    this.pullElement = document.createElement('div');
    this.pullElement.className = 'pull-to-refresh';
    this.pullElement.innerHTML = `
      <svg class="pull-to-refresh-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M1 4v6h6M23 20v-6h-6"/>
        <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>
      </svg>
    `;

    this.container.appendChild(this.pullElement);
    document.body.appendChild(this.container);

    // Only enable on mobile
    const isMobile = window.matchMedia('(max-width: 680px)').matches;
    if (!isMobile) return;

    this.setupListeners();
  }

  setupListeners() {
    const mapPanel = document.querySelector('.map-panel');
    if (!mapPanel) return;

    mapPanel.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: true });
    mapPanel.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
    mapPanel.addEventListener('touchend', () => this.onTouchEnd());
  }

  onTouchStart(e) {
    if (this.isRefreshing) return;

    // Only start if at top of page
    if (window.scrollY === 0) {
      this.startY = e.touches[0].clientY;
      this.isDragging = true;
    }
  }

  onTouchMove(e) {
    if (!this.isDragging || this.isRefreshing) return;

    this.currentY = e.touches[0].clientY;
    const distance = this.currentY - this.startY;

    if (distance > 0 && distance < 150) {
      e.preventDefault();

      const progress = Math.min(distance / this.threshold, 1);
      const translateY = -80 + (progress * 104);

      this.pullElement.style.transform = `translateX(-50%) translateY(${translateY}px)`;
      this.pullElement.classList.add('visible');

      if (distance >= this.threshold) {
        this.pullElement.classList.add('pull-ready');
      } else {
        this.pullElement.classList.remove('pull-ready');
      }
    }
  }

  async onTouchEnd() {
    if (!this.isDragging) return;

    const distance = this.currentY - this.startY;

    if (distance >= this.threshold && !this.isRefreshing) {
      await this.refresh();
    } else {
      this.reset();
    }

    this.isDragging = false;
  }

  async refresh() {
    this.isRefreshing = true;
    this.pullElement.classList.add('refreshing');
    this.pullElement.classList.remove('pull-ready');

    // Show toast
    if (window.UIEnhancements && window.UIEnhancements.toast) {
      window.UIEnhancements.toast.info('Refreshing traffic data...', 2000);
    }

    // Refresh traffic if routes are available
    const refreshButton = document.getElementById('refresh-traffic');
    if (refreshButton && !refreshButton.disabled) {
      refreshButton.click();
    }

    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 1500));

    this.reset();
    this.isRefreshing = false;
  }

  reset() {
    this.pullElement.style.transform = 'translateX(-50%) translateY(-80px)';
    this.pullElement.classList.remove('visible', 'pull-ready', 'refreshing');
  }
}

// PROGRESS BAR
// ============================================
class ProgressBar {
  constructor() {
    this.bar = null;
    this.fill = null;
    this.init();
  }

  init() {
    this.bar = document.createElement('div');
    this.bar.className = 'progress-bar';

    this.fill = document.createElement('div');
    this.fill.className = 'progress-bar-fill';

    this.bar.appendChild(this.fill);
    document.body.appendChild(this.bar);
  }

  start() {
    this.bar.classList.add('active', 'loading');
    this.fill.style.width = '0%';
    setTimeout(() => {
      this.fill.style.width = '70%';
    }, 50);
  }

  complete() {
    this.bar.classList.remove('loading');
    this.bar.classList.add('complete');
    this.fill.style.width = '100%';

    setTimeout(() => {
      this.bar.classList.remove('active', 'complete');
      this.fill.style.width = '0%';
    }, 400);
  }
}

// INITIALIZE ALL PREMIUM FEATURES
// ============================================
document.addEventListener('DOMContentLoaded', function() {
  // Setup empty states
  setTimeout(() => setupEmptyStates(), 500);

  // Initialize pull to refresh
  const pullToRefresh = new PullToRefresh();

  // Initialize progress bar
  const progressBar = new ProgressBar();

  // Hook into route loading
  const originalLoadRoutes = window.loadRoutes;
  if (typeof originalLoadRoutes === 'function') {
    window.loadRoutes = async function(...args) {
      progressBar.start();
      try {
        const result = await originalLoadRoutes.apply(this, args);
        progressBar.complete();
        return result;
      } catch (error) {
        progressBar.complete();
        throw error;
      }
    };
  }

  // Setup route hover highlighting after routes load
  const observer = new MutationObserver(() => {
    const routeOptions = document.getElementById('route-options');
    if (routeOptions && routeOptions.children.length > 0) {
      setupRouteHoverHighlighting();
    }
  });

  const routeSection = document.getElementById('route-section');
  if (routeSection) {
    observer.observe(routeSection, { childList: true, subtree: true });
  }

  // Export for external use
  window.PremiumFeatures = {
    animateNumber,
    setupRouteHoverHighlighting,
    createEmptyState,
    setupEmptyStates,
    pullToRefresh,
    progressBar
  };
});

console.log('✨ Premium features loaded successfully');
