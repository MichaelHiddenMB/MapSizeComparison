// ─────────────────────────────────────────────────────────────────────────────
// Map setup
// ─────────────────────────────────────────────────────────────────────────────

const map = L.map('map', {
  center: [20, 0],
  zoom: 3,
  doubleClickZoom: false,
  zoomSnap: 0.5,
});

L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
  attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a> © <a href="https://carto.com">CARTO</a>',
  subdomains: 'abcd',
  maxZoom: 19,
}).addTo(map);

// ─────────────────────────────────────────────────────────────────────────────
// Constants & state
// ─────────────────────────────────────────────────────────────────────────────

const COLORS = ['#f87171','#60a5fa','#34d399','#fbbf24','#c084fc','#f472b6','#2dd4bf','#fb923c'];
const EARTH_R = 6371000; // metres

let shapes   = [];
let colorIdx = 0;
let shapeNum = 0;
let nextId   = 1;

let drawMode    = false;
let pickMode    = false;
let vertices    = [];       // [[lat,lng], ...]
let previewPoly = null;

const draftGroup = L.layerGroup().addTo(map);
let drag = null;            // active drag state

// ─────────────────────────────────────────────────────────────────────────────
// Geo utilities
// ─────────────────────────────────────────────────────────────────────────────

function centroid(pts) {
  const n = pts.length;
  return pts.reduce((a, p) => [a[0] + p[0] / n, a[1] + p[1] / n], [0, 0]);
}

function toMeters(cLat, cLng, lat, lng) {
  const dy = (lat - cLat) * (Math.PI / 180) * EARTH_R;
  const dx = (lng - cLng) * (Math.PI / 180) * EARTH_R * Math.cos(cLat * Math.PI / 180);
  return [dx, dy];
}

function fromMeters(cLat, cLng, dx, dy) {
  const cosLat = Math.cos(cLat * Math.PI / 180);
  if (Math.abs(cosLat) < 0.001) return [cLat, cLng]; // near-pole guard
  const lat = cLat + (dy / EARTH_R) * (180 / Math.PI);
  const lng = cLng + (dx / EARTH_R) * (180 / Math.PI) / cosLat;
  return [Math.max(-85, Math.min(85, lat)), lng];
}

function areaM2(pts) {
  const c = centroid(pts);
  const m = pts.map(p => toMeters(c[0], c[1], p[0], p[1]));
  let area = 0;
  for (let i = 0; i < m.length; i++) {
    const j = (i + 1) % m.length;
    area += m[i][0] * m[j][1] - m[j][0] * m[i][1];
  }
  return Math.abs(area / 2);
}

function formatArea(m2) {
  const km2 = m2 / 1e6;
  if (km2 >= 1e6) return `${(km2 / 1e6).toFixed(2)}M km²`;
  if (km2 >= 1000) return `${(km2 / 1000).toFixed(0)}k km²`;
  if (km2 >= 1)    return `${Math.round(km2).toLocaleString()} km²`;
  return `${Math.round(m2 / 10000)} ha`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shape management
// ─────────────────────────────────────────────────────────────────────────────

function createShape(pts, cloneOf) {
  shapeNum++;
  const color   = cloneOf ? cloneOf.color : COLORS[colorIdx++ % COLORS.length];
  const center  = centroid(pts);
  const offsets = pts.map(p => toMeters(center[0], center[1], p[0], p[1]));
  const area    = areaM2(pts);
  const label   = cloneOf ? `${cloneOf.label} (copy)` : `Region ${shapeNum}`;
  const id      = nextId++;

  const poly = L.polygon(pts, {
    color,
    fillColor: color,
    fillOpacity: 0.2,
    weight: 2,
    interactive: true,
  }).addTo(map);

  poly.bindTooltip(`<strong>${label}</strong><br>${formatArea(area)}`, {
    sticky: true,
    className: 'shape-tip',
    offset: [0, -6],
  });

  const shape = { id, poly, center: [...center], offsets, color, area, label };
  shapes.push(shape);

  const el = poly.getElement();
  if (el) el.style.cursor = 'grab';

  poly.on('mousedown', (e) => {
    if (drawMode || pickMode) return;
    L.DomEvent.stopPropagation(e);
    L.DomEvent.preventDefault(e);
    map.dragging.disable();
    drag = {
      shape,
      startLat: e.latlng.lat,
      startLng: e.latlng.lng,
      startCenter: [...shape.center],
    };
    const el2 = poly.getElement();
    if (el2) el2.style.cursor = 'grabbing';
  });

  renderPanel();
  return shape;
}

function deleteShape(id) {
  const idx = shapes.findIndex(s => s.id === id);
  if (idx < 0) return;
  map.removeLayer(shapes[idx].poly);
  shapes.splice(idx, 1);
  renderPanel();
}

function duplicateShape(id) {
  const src = shapes.find(s => s.id === id);
  if (!src) return;
  const newCenter = [src.center[0] - 3, src.center[1] + 5];
  const pts = src.offsets.map(([dx, dy]) => fromMeters(newCenter[0], newCenter[1], dx, dy));
  createShape(pts, src);
}

function bringShapeHere(id) {
  const shape = shapes.find(s => s.id === id);
  if (!shape) return;
  const c = map.getCenter();
  moveShape(shape, [c.lat, c.lng]);
}

function moveShape(shape, newCenter) {
  const [cLat, cLng] = newCenter;
  const pts = shape.offsets.map(([dx, dy]) => fromMeters(cLat, cLng, dx, dy));
  shape.poly.setLatLngs(pts);
  shape.center = [...newCenter];
}

// ─────────────────────────────────────────────────────────────────────────────
// Shape panel
// ─────────────────────────────────────────────────────────────────────────────

function renderPanel() {
  const panel = document.getElementById('shape-panel');
  panel.innerHTML = '';

  shapes.forEach(s => {
    const card = document.createElement('div');
    card.className = 'shape-card';
    card.innerHTML = `
      <div class="shape-dot" style="background:${s.color}"></div>
      <div class="shape-info">
        <div class="shape-name">${s.label}</div>
        <div class="shape-area">${formatArea(s.area)}</div>
      </div>
      <div class="shape-actions">
        <button class="icon-btn here" data-action="here" data-id="${s.id}" title="Bring to current view">◎</button>
        <button class="icon-btn"      data-action="dup"  data-id="${s.id}" title="Duplicate">⧉</button>
        <button class="icon-btn del"  data-action="del"  data-id="${s.id}" title="Delete">✕</button>
      </div>
    `;
    panel.appendChild(card);
  });

  panel.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.id);
      if (btn.dataset.action === 'del')  deleteShape(id);
      if (btn.dataset.action === 'dup')  duplicateShape(id);
      if (btn.dataset.action === 'here') bringShapeHere(id);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Drag
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener('mousemove', (e) => {
  if (!drag) return;
  const ll   = map.mouseEventToLatLng(e);
  const dlat = ll.lat - drag.startLat;
  const dlng = ll.lng - drag.startLng;
  moveShape(drag.shape, [
    Math.max(-85, Math.min(85, drag.startCenter[0] + dlat)),
    drag.startCenter[1] + dlng,
  ]);
});

document.addEventListener('mouseup', () => {
  if (!drag) return;
  const el = drag.shape.poly.getElement();
  if (el) el.style.cursor = 'grab';
  drag = null;
  map.dragging.enable();
});

// ─────────────────────────────────────────────────────────────────────────────
// Pick Region mode
// ─────────────────────────────────────────────────────────────────────────────

const ADMIN_LEVEL_LABELS = {
  '2': 'Country', '3': 'Region', '4': 'State / Province',
  '5': 'Substate', '6': 'County', '7': 'Municipality',
  '8': 'City', '9': 'Subdistrict', '10': 'District',
  '11': 'Ward', '12': 'Neighborhood',
};

const OVERPASS_SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/cgi/interpreter',
];

async function fetchOverpass(query) {
  for (const server of OVERPASS_SERVERS) {
    try {
      const r = await fetch(`${server}?data=${encodeURIComponent(query)}`);
      if (r.ok) return await r.json();
      console.warn(`[MapSize] Overpass ${server} returned ${r.status}`);
    } catch (e) {
      console.warn(`[MapSize] Overpass ${server} failed:`, e);
    }
  }
  throw new Error('All Overpass servers unavailable');
}

function assembleRing(members) {
  const outerWays = (members || [])
    .filter(m => m.type === 'way' && (m.role === 'outer' || m.role === '') && m.geometry?.length >= 2);
  if (!outerWays.length) return null;
  if (outerWays.length === 1) return outerWays[0].geometry.map(p => [p.lat, p.lon]);

  const remaining = outerWays.map(w => w.geometry.slice());
  const rings = [];
  const EPS = 1e-5;

  while (remaining.length) {
    const ring = remaining.splice(0, 1)[0];
    let changed = true;
    while (changed && remaining.length) {
      changed = false;
      const tail = ring[ring.length - 1];
      for (let i = 0; i < remaining.length; i++) {
        const w = remaining[i];
        if (Math.abs(w[0].lat - tail.lat) < EPS && Math.abs(w[0].lon - tail.lon) < EPS) {
          ring.push(...w.slice(1)); remaining.splice(i, 1); changed = true; break;
        }
        if (Math.abs(w[w.length-1].lat - tail.lat) < EPS && Math.abs(w[w.length-1].lon - tail.lon) < EPS) {
          ring.push(...[...w].reverse().slice(1)); remaining.splice(i, 1); changed = true; break;
        }
      }
    }
    if (ring.length >= 4) rings.push(ring);
  }

  if (!rings.length) return null;
  // Return the largest ring by point count (main landmass)
  return rings.reduce((a, b) => a.length >= b.length ? a : b).map(p => [p.lat, p.lon]);
}



function geoJsonToLatLngs(geojson) {
  if (!geojson) return null;
  if (geojson.type === 'Polygon') {
    const ring = geojson.coordinates[0];
    if (!ring || ring.length < 4) return null;
    return ring.map(([lng, lat]) => [lat, lng]);
  }
  if (geojson.type === 'MultiPolygon') {
    const rings = geojson.coordinates.map(poly => poly[0]).filter(Boolean);
    if (!rings.length) return null;
    const largest = rings.reduce((a, b) => (a.length >= b.length ? a : b));
    if (largest.length < 4) return null;
    return largest.map(([lng, lat]) => [lat, lng]);
  }
  return null;
}

function setPickMode(on) {
  pickMode = on;
  const btn  = document.getElementById('pick-btn');
  const hint = document.getElementById('pick-hint');
  closePickPopup();

  if (on) {
    if (drawMode) setDrawMode(false);
    btn.classList.add('picking');
    btn.innerHTML = cancelIcon() + ' Cancel';
    map.getContainer().style.cursor = 'crosshair';
    hint.style.display = 'block';
  } else {
    btn.classList.remove('picking');
    btn.innerHTML = pinIcon() + ' Pick Region';
    map.getContainer().style.cursor = '';
    hint.style.display = 'none';
  }
}

function closePickPopup() {
  document.getElementById('pick-popup').style.display = 'none';
}

async function fetchRegionPolygon(osmRelationId) {
  const url = `https://nominatim.openstreetmap.org/lookup?osm_ids=R${osmRelationId}&polygon_geojson=1&format=json`;
  const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
  const data = await res.json();
  if (!data.length || !data[0].geojson) return null;
  return geoJsonToLatLngs(data[0].geojson);
}

async function doPickRegion(lat, lng, containerPoint) {
  const popup = document.getElementById('pick-popup');
  const body  = document.getElementById('pick-popup-body');

  const mapRect = map.getContainer().getBoundingClientRect();
  let left = containerPoint.x + 12;
  let top  = containerPoint.y + 12;
  if (left + 270 > mapRect.width)  left = containerPoint.x - 272;
  if (top  + 320 > mapRect.height) top  = containerPoint.y - 322;
  popup.style.left    = `${left}px`;
  popup.style.top     = `${top}px`;
  popup.style.display = 'block';
  body.innerHTML = '<div class="pick-loading">Detecting regions…</div>';

  try {
    // Overpass: find which admin boundaries contain this point (tags only, no geometry)
    const q = `[out:json][timeout:25];is_in(${lat},${lng})->.a;rel(pivot.a)["boundary"="administrative"]["admin_level"~"^([2-9]|10)$"];out tags;`;
    const data = await fetchOverpass(q);

    const options = (data.elements || [])
      .sort((a, b) => parseInt(a.tags?.admin_level || 99) - parseInt(b.tags?.admin_level || 99))
      .map(rel => ({
        id:    rel.id,
        label: ADMIN_LEVEL_LABELS[rel.tags?.admin_level] || `Admin ${rel.tags?.admin_level}`,
        name:  rel.tags?.['name:en'] || rel.tags?.name || 'Unknown',
      }));

    if (!options.length) {
      body.innerHTML = '<div class="pick-empty">No boundaries found here.</div>';
      return;
    }

    body.innerHTML = options.map((opt, i) =>
      `<div class="pick-option" data-idx="${i}">
        <span class="pick-badge">${opt.label}</span>
        <span class="pick-name" title="${opt.name}">${opt.name}</span>
        <button class="pick-add">Add</button>
      </div>`
    ).join('');

    body.querySelectorAll('.pick-option').forEach((el, i) => {
      el.querySelector('.pick-add').addEventListener('click', async (e) => {
        e.stopPropagation();
        const addBtn = el.querySelector('.pick-add');
        addBtn.textContent = '…';
        addBtn.disabled = true;
        try {
          const pts = await fetchRegionPolygon(options[i].id);
          if (!pts) { addBtn.textContent = 'Error'; addBtn.disabled = false; return; }
          const shape = createShape(pts);
          shape.label = options[i].name;
          shape.poly.setTooltipContent(`<strong>${options[i].name}</strong><br>${formatArea(shape.area)}`);
          renderPanel();
          closePickPopup();
        } catch (err) {
          console.warn('[MapSize] Polygon fetch error:', err);
          addBtn.textContent = 'Error';
          addBtn.disabled = false;
        }
      });
    });
  } catch (err) {
    console.warn('[MapSize] Error:', err);
    body.innerHTML = '<div class="pick-empty">Could not load region data.</div>';
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Draw mode
// ─────────────────────────────────────────────────────────────────────────────

function setDrawMode(on) {
  drawMode = on;
  const btn  = document.getElementById('draw-btn');
  const hint = document.getElementById('draw-hint');

  if (on) {
    if (pickMode) setPickMode(false);
    btn.innerHTML = cancelIcon() + ' Cancel';
    btn.classList.add('drawing');
    map.getContainer().style.cursor = 'crosshair';
    hint.style.display = 'block';
  } else {
    vertices = [];
    draftGroup.clearLayers();
    previewPoly = null;

    btn.innerHTML = drawIcon() + ' Draw Region';
    btn.classList.remove('drawing');
    map.getContainer().style.cursor = '';
    hint.style.display = 'none';

    shapes.forEach(s => {
      const el = s.poly.getElement();
      if (el) el.style.cursor = 'grab';
    });
  }
}

function refreshPreview(extraPt) {
  const pts = extraPt ? [...vertices, extraPt] : [...vertices];
  if (pts.length < 2) return;

  if (previewPoly) {
    previewPoly.setLatLngs(pts);
  } else {
    previewPoly = L.polygon(pts, {
      color: '#818cf8',
      fillColor: '#818cf8',
      fillOpacity: 0.15,
      weight: 2,
      dashArray: '6 4',
      interactive: false,
    }).addTo(draftGroup);
  }
}

map.on('click', (e) => {
  if (pickMode) {
    doPickRegion(e.latlng.lat, e.latlng.lng, e.containerPoint);
    return;
  }
  if (!drawMode) return;

  const pt = [e.latlng.lat, e.latlng.lng];
  vertices.push(pt);

  L.circleMarker(pt, {
    radius: 5,
    color: '#818cf8',
    fillColor: '#fff',
    fillOpacity: 1,
    weight: 2,
    interactive: false,
  }).addTo(draftGroup);

  refreshPreview();
});

map.on('dblclick', (e) => {
  if (!drawMode) return;
  vertices.pop(); // remove duplicate from the single-click that preceded dblclick

  if (vertices.length < 3) {
    alert('Place at least 3 points to create a region.');
    return;
  }

  const pts = [...vertices];
  setDrawMode(false);
  createShape(pts);
});

map.on('mousemove', (e) => {
  if (!drawMode || vertices.length === 0) return;
  refreshPreview([e.latlng.lat, e.latlng.lng]);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (drawMode) setDrawMode(false);
    if (pickMode) setPickMode(false);
    closePickPopup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Search (Nominatim geocoder)
// ─────────────────────────────────────────────────────────────────────────────

const searchInput   = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');
const searchClear   = document.getElementById('search-clear');

let searchDebounce = null;
let activeIdx      = -1;

function showResults(html) {
  searchResults.innerHTML    = html;
  searchResults.style.display = 'block';
}

function hideResults() {
  searchResults.style.display = 'none';
  activeIdx = -1;
}

function setSearchStatus(msg) {
  showResults(`<div class="search-status">${msg}</div>`);
}

async function doSearch(query) {
  if (!query.trim()) { hideResults(); return; }
  setSearchStatus('Searching…');

  try {
    const url  = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=6&addressdetails=1`;
    const res  = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    const data = await res.json();

    if (!data.length) { setSearchStatus('No results found.'); return; }

    showResults(data.map((item, i) => {
      const addr = item.address || {};
      const sub  = [addr.country, addr.state].filter(Boolean).join(', ');
      return `<div class="search-result" data-idx="${i}" data-lat="${item.lat}" data-lon="${item.lon}" data-bbox='${JSON.stringify(item.boundingbox)}'>
        <div class="search-result-name">${item.display_name.split(',')[0]}</div>
        ${sub ? `<div class="search-result-sub">${sub}</div>` : ''}
      </div>`;
    }).join(''));

    searchResults.querySelectorAll('.search-result').forEach(el => {
      el.addEventListener('click', () => selectResult(el));
    });
  } catch {
    setSearchStatus('Search unavailable.');
  }
}

function selectResult(el) {
  const [s, n, w, e] = JSON.parse(el.dataset.bbox); // Nominatim: [south, north, west, east]
  map.fitBounds([[+s, +w], [+n, +e]], { maxZoom: 13, animate: true });
  searchInput.value          = el.querySelector('.search-result-name').textContent;
  searchClear.style.display  = 'block';
  hideResults();
}

searchInput.addEventListener('input', () => {
  const q = searchInput.value;
  searchClear.style.display = q ? 'block' : 'none';
  clearTimeout(searchDebounce);
  if (!q.trim()) { hideResults(); return; }
  searchDebounce = setTimeout(() => doSearch(q), 350);
});

searchInput.addEventListener('keydown', (e) => {
  const items = searchResults.querySelectorAll('.search-result');
  if (!items.length) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeIdx = Math.min(activeIdx + 1, items.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeIdx = Math.max(activeIdx - 1, 0);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (activeIdx >= 0) selectResult(items[activeIdx]);
    else if (items.length) selectResult(items[0]);
    return;
  } else if (e.key === 'Escape') {
    hideResults();
    searchInput.blur();
    return;
  }

  items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
});

searchClear.addEventListener('click', () => {
  searchInput.value         = '';
  searchClear.style.display = 'none';
  hideResults();
  searchInput.focus();
});

document.addEventListener('click', (e) => {
  if (!document.getElementById('search-wrap').contains(e.target)) hideResults();
});

// ─────────────────────────────────────────────────────────────────────────────
// Toolbar buttons
// ─────────────────────────────────────────────────────────────────────────────

document.getElementById('draw-btn').addEventListener('click', () => setDrawMode(!drawMode));
document.getElementById('pick-btn').addEventListener('click', () => setPickMode(!pickMode));

document.getElementById('clear-btn').addEventListener('click', () => {
  shapes.forEach(s => map.removeLayer(s.poly));
  shapes   = [];
  colorIdx = 0;
  shapeNum = 0;
  renderPanel();
  if (drawMode) setDrawMode(false);
  if (pickMode) setPickMode(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// SVG icon helpers
// ─────────────────────────────────────────────────────────────────────────────

function cancelIcon() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
}

function drawIcon() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>`;
}

function pinIcon() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>`;
}
