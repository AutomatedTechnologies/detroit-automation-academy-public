/* Weather overlay for the Live Transit map (2026-11-27).
   Sources are the same ones /weather uses: NOAA nowCoast NEXRAD
   radar (WMS) and the NWS API Detroit observation
   (points -> stations -> latest). Self-contained: injects its own
   styles and lazily loads Leaflet from the same CDN as /weather.
   Toggled by #wx-btn in the map bar; renders into #wx-overlay. */
(function () {
  'use strict';

  var NOWCOAST = 'https://nowcoast.noaa.gov/geoserver/observations/weather_radar/wms';
  var NWS = 'https://api.weather.gov';
  var DETROIT = [42.3314, -83.0458];
  var REFRESH_MS = 5 * 60 * 1000;

  var btn = document.getElementById('wx-btn');
  var panel = document.getElementById('wx-overlay');
  if (!btn || !panel) return;

  var css = [
    '#wx-overlay{position:absolute;left:12px;bottom:52px;width:320px;max-width:calc(100vw - 24px);',
    'background:rgba(16,16,18,.92);color:#f2f2f2;border:1px solid rgba(255,255,255,.16);',
    'border-radius:14px;overflow:hidden;z-index:30;backdrop-filter:blur(6px);',
    'font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
    '#wx-overlay[hidden]{display:none}',
    '.wx-head{display:flex;align-items:flex-start;gap:8px;padding:10px 12px 6px}',
    '.wx-cond{flex:1;min-width:0}',
    '.wx-cond strong{font-size:14px}',
    '.wx-cond .wx-sub{color:#bdbdbd;font-size:12px}',
    '#wx-close{background:none;border:0;color:#f2f2f2;font-size:16px;cursor:pointer;padding:0 2px;line-height:1}',
    '#wx-map{height:210px;background:#0b0b0c}',
    '.wx-foot{display:flex;justify-content:space-between;gap:8px;padding:7px 12px 9px;color:#bdbdbd;font-size:11.5px}',
    '.wx-foot a{color:#9ecbff;text-decoration:none}',
    '.wx-foot a:hover{text-decoration:underline}',
    '#wx-overlay .leaflet-control-attribution{background:rgba(0,0,0,.55);color:#aaa;font-size:9.5px}',
    '#wx-overlay .leaflet-control-attribution a{color:#aaa}'
  ].join('');
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  var leafletPromise = null;
  function loadLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    if (leafletPromise) return leafletPromise;
    leafletPromise = new Promise(function (resolve, reject) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(link);
      var s = document.createElement('script');
      s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      s.onload = function () { resolve(window.L); };
      s.onerror = reject;
      document.head.appendChild(s);
    });
    return leafletPromise;
  }

  var map = null, radarLayer = null, timer = null, userFix = null, userMarker = null;

  function centerOnUser() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(function (pos) {
      userFix = [pos.coords.latitude, pos.coords.longitude];
      if (map) {
        map.setView(userFix, 9);
        if (userMarker) userMarker.setLatLng(userFix);
        else if (window.L) userMarker = L.marker(userFix).addTo(map).bindPopup('You are here');
      }
    }, function () {
      var subEl = document.getElementById('wx-cond-sub');
      if (subEl && !userFix) subEl.textContent = 'Location off — showing Detroit. ' + (subEl.textContent || '');
    }, { timeout: 5000 });
  }

  function buildMap(L) {
    if (map) { map.invalidateSize(); return; }
    map = L.map('wx-map', { zoomControl: false, attributionControl: true })
      .setView(DETROIT, 8);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
    radarLayer = L.tileLayer.wms(NOWCOAST, {
      layers: 'base_reflectivity_mosaic', format: 'image/png', transparent: true,
      version: '1.3.0', opacity: 0.85,
      attribution: 'Radar: NOAA nowCoast (NEXRAD)'
    }).addTo(map);
    L.marker(DETROIT).addTo(map).bindPopup('Detroit, Michigan');
    if (userFix) {
      map.setView(userFix, 9);
      userMarker = L.marker(userFix).addTo(map).bindPopup('You are here');
    } else {
      centerOnUser();
    }
  }

  function fmtTime(iso) {
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Detroit', hour: 'numeric', minute: '2-digit'
      }).format(new Date(iso));
    } catch (e) { return ''; }
  }

  function loadConditions() {
    var condEl = document.getElementById('wx-cond');
    var subEl = document.getElementById('wx-cond-sub');
    if (!condEl) return;
    var headers = { 'Accept': 'application/geo+json' };
    fetch(NWS + '/points/' + DETROIT[0] + ',' + DETROIT[1], { headers: headers })
      .then(function (r) { return r.json(); })
      .then(function (p) { return fetch(p.properties.observationStations, { headers: headers }); })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        var id = s.features[0].properties.stationIdentifier;
        return fetch(NWS + '/stations/' + id + '/observations/latest', { headers: headers });
      })
      .then(function (r) { return r.json(); })
      .then(function (o) {
        var p = o.properties;
        function val(x) { return x && typeof x.value === 'number' ? x.value : null; }
        var tc = val(p.temperature);
        var tf = tc === null ? null : Math.round(tc * 9 / 5 + 32);
        var wsp = val(p.windSpeed);
        var wm = wsp === null ? null : Math.round(wsp * 0.621371);
        var parts = [];
        if (tf !== null) parts.push(tf + '°F');
        if (p.textDescription) parts.push(p.textDescription);
        condEl.innerHTML = '<strong>Detroit</strong> · ' + parts.join(' · ');
        var sub = [];
        if (wm !== null) sub.push('wind ' + (p.windDirection && typeof p.windDirection.value === 'number' ? Math.round(p.windDirection.value) + '° ' : '') + wm + ' mph');
        if (p.timestamp) sub.push('observed ' + fmtTime(p.timestamp));
        subEl.textContent = sub.join(' · ');
      })
      .catch(function () {
        condEl.innerHTML = '<strong>Detroit</strong> · observation unavailable';
        subEl.textContent = '';
      });
  }

  function open() {
    panel.hidden = false;
    btn.setAttribute('aria-pressed', 'true');
    loadLeaflet().then(function (L) {
      buildMap(L);
      if (radarLayer) radarLayer.redraw();
    }).catch(function () {
      document.getElementById('wx-map').innerHTML =
        '<p style="padding:12px;color:#bdbdbd">Radar could not load. Full weather: <a href="/weather/" style="color:#9ecbff">/weather</a></p>';
    });
    loadConditions();
    if (timer) clearInterval(timer);
    timer = setInterval(function () {
      if (panel.hidden) return;
      if (radarLayer) radarLayer.redraw();
      loadConditions();
    }, REFRESH_MS);
  }

  function close() {
    panel.hidden = true;
    btn.setAttribute('aria-pressed', 'false');
    if (timer) { clearInterval(timer); timer = null; }
  }

  btn.addEventListener('click', function () {
    if (panel.hidden) open(); else close();
  });
  var closeBtn = document.getElementById('wx-close');
  if (closeBtn) closeBtn.addEventListener('click', close);

  /* Locate-me coupling (Director, 2026-11-27): tapping the map's
     locate button also activates the weather overlay, centered on
     the user's position once the fix resolves. The site's own
     camera flight is the engine's job; this only mirrors the
     intent into the overlay. */
  var locateBtn = document.getElementById('view-locate');
  if (locateBtn) {
    locateBtn.addEventListener('click', function () {
      centerOnUser();
      if (panel.hidden) open();
      else if (map && userFix) map.setView(userFix, 9);
    });
  }
})();
