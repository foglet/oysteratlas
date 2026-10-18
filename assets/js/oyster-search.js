/*!
 * The Oyster Atlas — search by market name
 * Fogday Studios, fogday.com
 *
 * Heatmap-safe: never filters, restyles or removes the style's own layers.
 * A picked oyster is drawn on its own layer ("oa-search-hit") on top.
 *
 * Species names, Latin names and colors are read from the legend
 * (.map-legend li), so the legend in index.html is the one place to edit them.
 */
(function (global) {
  'use strict';

  var DEFAULTS = {
    map: null,                 // mapboxgl.Map (required)
    data: null,                // GeoJSON FeatureCollection, or…
    url: null,                 // …URL to fetch it from, or a list of URLs whose features are combined
    fly: null,                 // function (view) — defaults to map.flyTo

    input: '#oa-search-input',
    results: '#oa-search-results',
    status: '#oa-search-status',
    clear: '#oa-search-clear',
    legendItems: '.map-legend li',

    nameKey: 'name',           // GeoJSON property with the market name
    speciesKey: 'species',     // GeoJSON property with the species (common or Latin name)
    regionKey: 'region',       // optional
    localeKey: 'locale',       // optional: place shown in the details

    maxResults: 50,
    flyZoom: 10,
    fallbackColor: '#8fa3b1',
    hintText: ''               // shown when the box is empty; blank = nothing
  };

  var HIT_ID = 'oa-search-hit';

  function $(sel) { return typeof sel === 'string' ? document.querySelector(sel) : sel; }

  // Lowercase + strip accents so "beausoleil" finds "Beausoléil".
  function norm(s) {
    return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text; // never innerHTML: names come from data
    return n;
  }

  function firstCoord(geom) {
    if (!geom) return null;
    if (geom.type === 'Point') return geom.coordinates;
    if (geom.type === 'MultiPoint' && geom.coordinates.length) return geom.coordinates[0];
    return null;
  }

  // Legend rows look like: <li><span class="sp-name">Belon</span><span class="dot" style="--c:#7D12B3"></span><i>(Ostrea edulis)</i></li>
  function readLegend(selector) {
    var out = [];
    Array.prototype.forEach.call(document.querySelectorAll(selector), function (li) {
      var nameEl = li.querySelector('.sp-name');
      var dot = li.querySelector('.dot');
      var latinEl = li.querySelector('i');
      var name = nameEl ? nameEl.textContent.trim() : '';
      var color = dot ? dot.style.getPropertyValue('--c').trim() : '';
      var latin = latinEl ? latinEl.textContent.replace(/[()]/g, '').trim() : '';
      if (name && color) out.push({ name: name, latin: latin, color: color });
    });
    return out;
  }

  function speciesLookup(list, fallback) {
    var byKey = {};
    list.forEach(function (s) {
      byKey[norm(s.name)] = s;
      if (s.latin) byKey[norm(s.latin)] = s;
    });
    return function (value) {
      var s = byKey[norm(value).trim()];
      return s ? { label: s.name, color: s.color } : { label: value ? String(value) : 'Unknown', color: fallback };
    };
  }

  // 0 = name starts with query, 1 = a word starts with it ("bay" → "Fanny Bay"), 2 = anywhere.
  function rankOf(n, t) {
    var i = n.indexOf(t);
    if (i < 0) return -1;
    if (i === 0) return 0;
    return /[\s\-'’.]/.test(n.charAt(i - 1)) ? 1 : 2;
  }

  function search(items, query, max) {
    var t = norm(query).trim();
    if (!t) return { total: 0, list: [] };
    var hits = [];
    for (var i = 0; i < items.length; i++) {
      var r = rankOf(items[i].key, t);
      if (r >= 0) hits.push({ item: items[i], rank: r, at: items[i].key.indexOf(t), len: t.length });
    }
    hits.sort(function (a, b) { return a.rank - b.rank || a.item.name.localeCompare(b.item.name); });
    return { total: hits.length, list: hits.slice(0, max) };
  }

  // ---------- map pin (own source + layer; the heatmap is never touched) ----------

  function setHit(map, coord, color) {
    var data = {
      type: 'FeatureCollection',
      features: coord ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: coord }, properties: { color: color } }] : []
    };
    function apply() {
      var src = map.getSource(HIT_ID);
      if (src) { src.setData(data); return; }
      if (!coord) return;
      map.addSource(HIT_ID, { type: 'geojson', data: data });
      map.addLayer({
        id: HIT_ID, type: 'circle', source: HIT_ID,
        paint: {
          'circle-radius': 9,
          'circle-color': ['get', 'color']   // species color fill only, no outline
        }
      }); // no beforeId → above every style layer, heatmap included
    }
    if (map.isStyleLoaded()) apply(); else map.once('idle', apply);
  }

  // ---------- main ----------

  function init(options) {
    var o = Object.assign({}, DEFAULTS, options || {});
    if (!o.map) throw new Error('OysterSearch: `map` is required');
    var map = o.map;
    var fly = o.fly || function (v) { map.flyTo(v); };

    var input = $(o.input), list = $(o.results), status = $(o.status), clearBtn = $(o.clear);
    if (!input || !list) throw new Error('OysterSearch: search elements not found');

    var speciesOf = speciesLookup(readLegend(o.legendItems), o.fallbackColor);
    var items = [], shown = [], active = -1;

    // Details of the chosen oyster, shown in the search card just under the search bar.
    var detail = el('div', 'oa-detail');
    detail.hidden = true;
    detail.setAttribute('aria-live', 'polite');
    var fieldEl = input.closest('.oa-field') || input;
    fieldEl.parentNode.insertBefore(detail, fieldEl.nextSibling);

    setStatus(o.hintText);

    // One URL or several: each file's features are combined. A file that fails to load
    // is skipped (and logged) as long as at least one loads.
    var urls = [].concat(o.url || []);
    var ready = o.data ? Promise.resolve(o.data)
      : Promise.all(urls.map(function (u) {
          return fetch(u)
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .catch(function (err) { if (global.console) console.error('OysterSearch: could not load ' + u, err); return null; });
        })).then(function (all) {
          var ok = all.filter(Boolean);
          if (!ok.length) throw new Error('no oyster data loaded');
          return { type: 'FeatureCollection', features: [].concat.apply([], ok.map(function (fc) { return fc.features || []; })) };
        });

    ready.then(function (fc) {
      items = (fc.features || []).map(function (f) {
        var p = f.properties || {};
        var name = p[o.nameKey];
        var coord = firstCoord(f.geometry);
        if (!name || !coord) return null;
        var sp = speciesOf(p[o.speciesKey]);
        return { name: String(name), key: norm(name), species: sp.label, color: sp.color, region: p[o.regionKey] || '', locale: p[o.localeKey] || '', coord: coord };
      }).filter(Boolean);
      if (input.value) render();
    }).catch(function (err) {
      input.disabled = true;
      setStatus('Search is unavailable right now.');
      if (global.console) console.error('OysterSearch: could not load oyster data', err);
    });

    function setStatus(text) { if (status) status.textContent = text; }

    function render() {
      var q = input.value;
      if (clearBtn) clearBtn.hidden = q.length === 0;

      var res = search(items, q, o.maxResults);
      shown = res.list;
      if (active >= shown.length) active = shown.length - 1;

      list.textContent = '';
      shown.forEach(function (h, i) {
        var it = h.item;
        var li = el('li', 'oa-result');
        li.id = 'oa-opt-' + i;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', i === active ? 'true' : 'false');
        li.dataset.index = i;
        li.style.setProperty('--c', it.color);

        var name = el('span', 'oa-name');
        if (h.at >= 0 && it.key.length === it.name.length) { // highlight only if accent-stripping kept the length
          name.appendChild(document.createTextNode(it.name.slice(0, h.at)));
          name.appendChild(el('mark', null, it.name.slice(h.at, h.at + h.len)));
          name.appendChild(document.createTextNode(it.name.slice(h.at + h.len)));
        } else {
          name.textContent = it.name;
        }
        var dot = el('span', 'dot');
        dot.setAttribute('aria-hidden', 'true');

        li.appendChild(dot);   // same order as the legend: dot, name, species at right
        li.appendChild(name);
        li.appendChild(el('span', 'oa-species', it.species));
        list.appendChild(li);
      });

      input.setAttribute('aria-expanded', shown.length ? 'true' : 'false');
      if (active >= 0) input.setAttribute('aria-activedescendant', 'oa-opt-' + active);
      else input.removeAttribute('aria-activedescendant');

      var t = q.trim();
      if (!t) setStatus(o.hintText);
      else if (!res.total) setStatus('No oysters named “' + t + '”. Try fewer letters.');
      else if (res.total > shown.length) setStatus('Showing ' + shown.length + ' of ' + res.total + ' oysters');
      else setStatus(res.total === 1 ? '1 oyster' : res.total + ' oysters');
    }

    function setActive(i) {
      active = i;
      var nodes = list.children;
      for (var k = 0; k < nodes.length; k++) nodes[k].setAttribute('aria-selected', k === i ? 'true' : 'false');
      if (i >= 0 && nodes[i]) {
        input.setAttribute('aria-activedescendant', nodes[i].id);
        nodes[i].scrollIntoView({ block: 'nearest' });
      }
    }

    function pick(i) {
      var h = shown[i];
      if (!h) return;
      var it = h.item;
      setActive(i);
      fly({ center: it.coord, zoom: Math.max(map.getZoom(), o.flyZoom) });
      setHit(map, it.coord, it.color);
      if (lastPointer === 'touch') minimize();   // on phones, get the list out of the way
      showDetail(it);
    }

    // Details for one oyster, used by search picks and by taps on the map:
    // ● name, then where it's grown, then the region (skipped when the locale already names it).
    function showDetail(it) {
      detail.textContent = '';
      var head = el('div', 'oa-detail-name');
      var dot = el('span', 'dot');
      dot.style.setProperty('--c', it.color);
      dot.setAttribute('aria-hidden', 'true');
      head.appendChild(dot);
      head.appendChild(document.createTextNode(it.name));
      detail.appendChild(head);
      var place = (it.locale || '').replace(/[,\s]+$/, '');
      var region = it.region && place.toLowerCase().indexOf(String(it.region).toLowerCase()) < 0 ? it.region : '';
      if (place) detail.appendChild(el('div', 'oa-detail-locale', place));
      if (region) detail.appendChild(el('div', 'oa-detail-region', region));
      detail.hidden = false;
    }
    function clearDetail() { detail.hidden = true; detail.textContent = ''; }

    function reset() {
      input.value = '';
      active = -1;
      clearDetail();
      setHit(map, null);
      render();
    }

    input.addEventListener('input', function () { active = -1; clearDetail(); render(); });

    // ----- details + minimizing -----
    // The details clear only when the search box gets focus or on a tap elsewhere.
    // Dragging or pinching the map never counts as a tap, so it leaves them in place.
    // A tap outside the search also minimizes it (hides the list, drops the phone keyboard)
    // so the map can be moved freely; tapping the box brings the list back.
    var card = input.closest('.oa-search') || list.parentNode;
    function minimize() {
      card.classList.add('oa-collapsed');
      input.setAttribute('aria-expanded', 'false');
      if (document.activeElement === input) input.blur();
    }
    input.addEventListener('focus', function () {
      clearDetail();
      card.classList.remove('oa-collapsed');
      if (shown.length) input.setAttribute('aria-expanded', 'true');
    });

    // Fingers currently on the screen, by id. A new first touch (isPrimary) starts fresh,
    // so a lost pointerup can never leave taps stuck.
    var down = null, fingers = {}, lastPointer = 'mouse';
    function fingerCount() { return Object.keys(fingers).length; }
    document.addEventListener('pointerdown', function (e) {
      if (e.isPrimary) fingers = {};
      fingers[e.pointerId] = true;
      lastPointer = e.pointerType || 'mouse';
      down = fingerCount() === 1 ? { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId } : null;  // 2+ fingers = pinch
    }, true);
    function pointerEnd(e) {
      delete fingers[e.pointerId];
      var d = down; down = null;
      if (e.type !== 'pointerup' || !d || d.id !== e.pointerId) return;
      var moved = Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y);
      if (moved > 10 || Date.now() - d.t > 600) return;          // a drag or long press, not a tap
      var t = e.target;
      if (t.closest && (t.closest('.oa-detail') || t.closest('.oa-results') || t.closest('.oa-field'))) return;
      var hit = t.closest && t.closest('.mapboxgl-canvas-container') ? nearestOyster(e) : null;
      minimize();
      if (hit) showDetail(hit);   // tapped an oyster on the map: show its details in the search card
      else clearDetail();
    }
    document.addEventListener('pointerup', pointerEnd, true);

    // The oyster drawn closest to a tap, if it's within finger (or mouse) reach.
    // Which oyster was tapped. First ask the map which labels are under the finger
    // (that covers the whole width of a name, not just its point); then fall back to
    // the oyster point closest to the tap.
    function nearestOyster(e) {
      var box = map.getContainer().getBoundingClientRect();
      var x = e.clientX - box.left, y = e.clientY - box.top;
      var pad = e.pointerType === 'mouse' ? 3 : 10;
      var hit = fromRenderedFeatures([[x - pad, y - pad], [x + pad, y + pad]], x, y);
      if (hit) return hit;
      var reach = e.pointerType === 'mouse' ? 14 : 30, best = null, bestD = reach * reach;
      for (var k = 0; k < items.length; k++) {
        var p = map.project(items[k].coord);
        var d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
        if (d <= bestD) { bestD = d; best = items[k]; }
      }
      return best;
    }

    // Match a drawn map feature (label, circle, ...) back to one of our oysters: same name
    // if the feature carries one, otherwise the oyster at (almost) the same position.
    function fromRenderedFeatures(bbox, x, y) {
      var feats;
      try { feats = map.queryRenderedFeatures ? map.queryRenderedFeatures(bbox) : []; } catch (err) { feats = []; }
      var best = null, bestScore = Infinity;
      for (var i = 0; i < feats.length; i++) {
        var f = feats[i];
        if (!f.geometry || f.geometry.type !== 'Point' || f.layer && f.layer.id === HIT_ID) continue;
        var c = f.geometry.coordinates, props = f.properties || {};
        var names = {};
        for (var k in props) if (typeof props[k] === 'string') names[norm(props[k]).trim()] = true;
        for (var j = 0; j < items.length; j++) {
          var it = items[j];
          var dx = it.coord[0] - c[0], dy = it.coord[1] - c[1];
          var gap = dx * dx + dy * dy;                       // degrees²
          var sameName = names[it.key.trim()];
          if (!sameName && gap > 0.0001) continue;           // not the same name and more than ~1 km apart
          var p = map.project(it.coord);
          var score = (sameName ? 0 : 1e6) + (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
          if (score < bestScore) { bestScore = score; best = it; }
        }
      }
      return best;
    }
    document.addEventListener('pointercancel', pointerEnd, true);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (shown.length) setActive(Math.min(active + 1, shown.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (shown.length) setActive(Math.max(active - 1, 0)); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(active >= 0 ? active : 0); }
      else if (e.key === 'Escape') { e.preventDefault(); reset(); }
    });
    list.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep focus in the box
    list.addEventListener('click', function (e) {
      var li = e.target.closest('.oa-result');
      if (li) pick(Number(li.dataset.index));
    });
    if (clearBtn) clearBtn.addEventListener('click', function () { reset(); input.focus(); });

    return { reset: reset };
  }

  global.OysterSearch = { init: init, _search: search, _norm: norm };
})(window);
