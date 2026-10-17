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
    url: null,                 // …URL to fetch it from
    fly: null,                 // function (view) — defaults to map.flyTo

    input: '#oa-search-input',
    results: '#oa-search-results',
    status: '#oa-search-status',
    clear: '#oa-search-clear',
    legendItems: '.map-legend li',

    nameKey: 'name',           // GeoJSON property with the market name
    speciesKey: 'species',     // GeoJSON property with the species (common or Latin name)
    regionKey: 'region',       // optional

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
    var items = [], shown = [], active = -1, popup = null;

    setStatus(o.hintText);

    var ready = o.data ? Promise.resolve(o.data)
      : fetch(o.url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });

    ready.then(function (fc) {
      items = (fc.features || []).map(function (f) {
        var p = f.properties || {};
        var name = p[o.nameKey];
        var coord = firstCoord(f.geometry);
        if (!name || !coord) return null;
        var sp = speciesOf(p[o.speciesKey]);
        return { name: String(name), key: norm(name), species: sp.label, color: sp.color, region: p[o.regionKey] || '', coord: coord };
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

      if (popup) popup.remove();
      var box = el('div', 'oa-popup');
      box.appendChild(el('strong', null, it.name));
      box.appendChild(el('span', null, [it.species, it.region].filter(Boolean).join(' · ')));
      popup = new global.mapboxgl.Popup({ offset: 14, className: 'oa-popup-wrap' })
        .setLngLat(it.coord).setDOMContent(box).addTo(map);
    }

    function reset() {
      input.value = '';
      active = -1;
      if (popup) { popup.remove(); popup = null; }
      setHit(map, null);
      render();
    }

    input.addEventListener('input', function () { active = -1; render(); });
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
