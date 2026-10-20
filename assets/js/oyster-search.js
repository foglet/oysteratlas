/*!
 * The Oyster Atlas — search by market name
 * Fogday Studios, fogday.com
 *
 * Heatmap-safe: never filters or removes the style's own layers. A picked oyster is drawn on its
 * own layer ("oa-search-hit") on top, at the style's own dot size, and its name label is bolded
 * (the only change made to the style's layers: their label font, restored when nothing is picked).
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
    detailPanel: '#oa-detail-panel', // where the picked oyster's details go; falls back to under the search bar

    nameKey: 'name',           // GeoJSON property with the market name
    speciesKey: 'species',     // GeoJSON property with the species (common or Latin name)
    regionKey: 'region',       // optional
    localeKey: 'locale',       // optional: place shown in the details
    placeKeys: ['waterBody', 'cityCounty', 'st', 'locale'],  // also searched, after names: "Kachemak", "Charleston", "South Carolina"

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

  // State and province abbreviations, so "SC" and "South Carolina" find each other.
  var STATES = {
    al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california', co: 'colorado', ct: 'connecticut',
    de: 'delaware', dc: 'district of columbia', fl: 'florida', ga: 'georgia', hi: 'hawaii', id: 'idaho', il: 'illinois',
    in: 'indiana', ia: 'iowa', ks: 'kansas', ky: 'kentucky', la: 'louisiana', me: 'maine', md: 'maryland',
    ma: 'massachusetts', mi: 'michigan', mn: 'minnesota', ms: 'mississippi', mo: 'missouri', mt: 'montana',
    ne: 'nebraska', nv: 'nevada', nh: 'new hampshire', nj: 'new jersey', nm: 'new mexico', ny: 'new york',
    nc: 'north carolina', nd: 'north dakota', oh: 'ohio', ok: 'oklahoma', or: 'oregon', pa: 'pennsylvania',
    ri: 'rhode island', sc: 'south carolina', sd: 'south dakota', tn: 'tennessee', tx: 'texas', ut: 'utah',
    vt: 'vermont', va: 'virginia', wa: 'washington', wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming',
    bc: 'british columbia', nb: 'new brunswick', ns: 'nova scotia', pe: 'prince edward island', pei: 'prince edward island',
    nl: 'newfoundland', qc: 'quebec'
  };
  var STATE_ABBR = {};
  Object.keys(STATES).forEach(function (k) { if (!STATE_ABBR[STATES[k]]) STATE_ABBR[STATES[k]] = k; });

  // An oyster's places, searchable: each field normalized, plus the other spelling of its state.
  function placesOf(p, keys) {
    var out = [];
    keys.forEach(function (k) {
      var v = norm(p[k]).trim();
      if (!v) return;
      out.push(v);
      if (STATES[v]) out.push(STATES[v]);           // "sc" → "south carolina"
      else if (STATE_ABBR[v]) out.push(STATE_ABBR[v]); // "south carolina" → "sc"
    });
    return out;
  }

  // Where a query matches an oyster's places: 0 = a field starts with it, 1 = a word does, 2 = anywhere.
  // Short queries (1–2 letters) must be a whole field or word, so "ma" finds Massachusetts, not every "Malpeque".
  function placeRank(places, t) {
    var best = -1;
    for (var i = 0; i < places.length; i++) {
      var r = rankOf(places[i], t);
      if (r < 0) continue;
      if (t.length < 3) {
        var at = places[i].indexOf(t), end = places[i].charAt(at + t.length);
        if (r === 2 || (end && !/[\s,\-.]/.test(end))) continue;
      }
      if (best < 0 || r < best) best = r;
    }
    return best;
  }

  // Order: names that start with the query or have a word that does; then places that do;
  // then names containing it mid-word ("ak" in "Baker"); then places containing it mid-word.
  var NAME_RANK = [0, 1, 4], PLACE_RANK = [2, 3, 5];
  function search(items, query, max) {
    var t = norm(query).trim();
    if (!t) return { total: 0, list: [] };
    var hits = [];
    for (var i = 0; i < items.length; i++) {
      var r = rankOf(items[i].key, t);
      var pr = placeRank(items[i].places || [], t);
      if (r >= 0 && (pr < 0 || NAME_RANK[r] <= PLACE_RANK[pr]))
        hits.push({ item: items[i], rank: NAME_RANK[r], at: items[i].key.indexOf(t), len: t.length });
      else if (pr >= 0)
        hits.push({ item: items[i], rank: PLACE_RANK[pr], at: -1, len: 0, byPlace: true });
    }
    hits.sort(function (a, b) { return a.rank - b.rank || a.item.name.localeCompare(b.item.name); });
    return { total: hits.length, list: hits.slice(0, max) };
  }

  // ---------- map pin (own source + layer; the heatmap is never touched) ----------

  // Same size as the style's own oyster dots: none until zoom 4, 1px at 5, growing to 5px (10px across) at 8 and above.
  var DOT_RADIUS = ['interpolate', ['linear'], ['zoom'], 4, 0, 5, 1, 8, 5];
  var DOT_BLUR = ['interpolate', ['linear'], ['zoom'], 0, 2, 10, 1.5, 11, 1];  // the style's soft edge, so the visible size matches too

  // Bold the picked oyster's name in the style's own label layers (any symbol layer showing {nameKey}),
  // and place it first: where labels crowd, Mapbox drops the ones that would overlap, and the picked
  // oyster's could be the one dropped. A lower symbol-sort-key wins placement, so its neighbors give way.
  var labelFonts = {};  // layer id → its original text-font
  var labelSort = {};   // layer id → its original symbol-sort-key (undefined if none)
  function boldFont(fonts) { return fonts.map(function (f) { return /Bold$/.test(f) ? f : f.replace(/\s*(Semibold|SemiBold|Medium|Regular|Light|Italic)?$/, ' Bold'); }); }
  function setBoldLabel(map, nameKey, name) {
    var layers = (map.getStyle() && map.getStyle().layers) || [];
    layers.forEach(function (l) {
      if (l.type !== 'symbol' || !l.layout || JSON.stringify(l.layout['text-field'] || '').indexOf('{' + nameKey + '}') < 0) return;
      if (!(l.id in labelSort)) labelSort[l.id] = map.getLayoutProperty(l.id, 'symbol-sort-key');
      var sortOrig = labelSort[l.id];
      try {
        map.setLayoutProperty(l.id, 'symbol-sort-key', name
          ? ['case', ['==', ['get', nameKey], name], -1e6, sortOrig === undefined ? 0 : sortOrig]
          : sortOrig);
      } catch (err) { /* leave this layer's order alone */ }
      if (!(l.id in labelFonts)) labelFonts[l.id] = map.getLayoutProperty(l.id, 'text-font') || ['Open Sans Regular', 'Arial Unicode MS Regular'];
      var orig = labelFonts[l.id];
      if (!Array.isArray(orig) || orig.some(function (f) { return typeof f !== 'string'; })) return;  // an expression: leave it alone
      map.setLayoutProperty(l.id, 'text-font', name
        ? ['case', ['==', ['get', nameKey], name], ['literal', boldFont(orig)], ['literal', orig]]
        : orig);
    });
  }

  function setHit(map, coord, color, name, nameKey) {
    var data = {
      type: 'FeatureCollection',
      features: coord ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: coord }, properties: { color: color } }] : []
    };
    function apply() {
      setBoldLabel(map, nameKey || 'name', coord ? name : null);
      var src = map.getSource(HIT_ID);
      if (src) { src.setData(data); return; }
      if (!coord) return;
      map.addSource(HIT_ID, { type: 'geojson', data: data });
      map.addLayer({
        id: HIT_ID, type: 'circle', source: HIT_ID,
        paint: {
          'circle-radius': DOT_RADIUS,      // never larger than the style's own dots
          'circle-blur': DOT_BLUR,
          'circle-opacity': 0.9,
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
    var detailPanel = $(o.detailPanel);
    // The bar can shrink to just its magnifying glass; clicking anywhere on it opens the search.
    fieldEl.addEventListener('click', function () { if (document.activeElement !== input) input.focus(); });
    fieldEl.setAttribute('title', 'Search oysters');
    if (detailPanel) detailPanel.appendChild(detail);
    else fieldEl.parentNode.insertBefore(detail, fieldEl.nextSibling);

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

    var itemsReady = ready.then(function (fc) {
      items = (fc.features || []).map(function (f) {
        var p = f.properties || {};
        var name = p[o.nameKey];
        var coord = firstCoord(f.geometry);
        if (!name || !coord) return null;
        var sp = speciesOf(p[o.speciesKey]);
        return { name: String(name), key: norm(name), species: sp.label, color: sp.color, region: p[o.regionKey] || '', locale: p[o.localeKey] || '', coord: coord,
                 places: placesOf(p, o.placeKeys) };
      }).filter(Boolean);
      if (input.value) render();
      return items;
    });
    itemsReady.catch(function (err) {
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
        // A place match shows where it's grown at right (why it's listed); a name match shows the species.
        // Kept short: first and last parts, so the state shows ("Clarence Strait, The Tongass…, AK" → "Clarence Strait, AK")
        var parts = (it.locale || '').replace(/[,\s]+$/, '').split(/\s*,\s*/).filter(Boolean);
        var where = parts.length > 2 ? parts[0] + ', ' + parts[parts.length - 1] : parts.join(', ');
        li.appendChild(h.byPlace && where ? el('span', 'oa-species oa-place', where) : el('span', 'oa-species', it.species));
        list.appendChild(li);
      });

      input.setAttribute('aria-expanded', shown.length ? 'true' : 'false');
      if (active >= 0) input.setAttribute('aria-activedescendant', 'oa-opt-' + active);
      else input.removeAttribute('aria-activedescendant');

      var t = q.trim();
      if (!t) setStatus(o.hintText);
      else if (!res.total) setStatus('No oysters or places match “' + t + '”. Try fewer letters.');
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

    function pick(i, byKeyboard) {
      var h = shown[i];
      if (!h) return;
      setActive(i);
      goTo(h.item, false);
      minimize(byKeyboard);   // phones and desktop alike: tuck the list away so the map and details are in view
    }

    // Go to one oyster: its pin, its bolded name, then its card. Zoomed to at least flyZoom (10), where its
    // name label shows. instant: jump there (page load); otherwise fly. Used by search picks and by the page.
    function goTo(it, instant) {
      // Fly first, then fade the details in once the map lands, so the card doesn't ride along mid-flight.
      // Any older card fades away as the flight starts.
      clearDetail();
      var mine = ++landing;
      var land = function () { if (mine === landing) { landing++; showDetail(it); } };
      var view = { center: it.coord, zoom: Math.max(instant ? 0 : map.getZoom(), o.flyZoom) };
      if (instant) map.jumpTo(view); else fly(view);
      // Listen only after the flight starts: starting it can end an earlier flight, and that 'moveend'
      // isn't ours. Reduced motion jumps instantly, so the map is already still and we land right away.
      if (map.isMoving()) map.once('moveend', land); else land();
      setTimeout(land, 8000);   // backstop: show the card even if no 'moveend' ever arrives
      setHit(map, it.coord, it.color, it.name, o.nameKey);
    }
    // The page's version: also clears any old search text, like a tap on an oyster does.
    function show(it, instant) {
      if (!it) return;
      input.value = ''; active = -1; render();
      goTo(it, instant);
    }
    var landing = 0;   // counts picks and taps; a flight shows its card only if nothing newer happened meanwhile

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
      var appearing = detailBox.hidden || leaving;
      detail.hidden = false;
      if (detailPanel) detailPanel.hidden = false;
      if (appearing) slideDetail(true);   // card was hidden: slide it up
      else swapDetail();                  // already up (switching oysters): the new text fades + zooms in
    }
    function clearDetail() {
      landing++;   // a card still waiting for its flight to land shouldn't appear after this
      if (detailBox.hidden || leaving) return;
      slideDetail(false, function () { detail.hidden = true; detail.textContent = ''; if (detailPanel) detailPanel.hidden = true; });
    }

    // The details card fades in like the ohlonesky.com menu overlay: 500ms, rising 16px (1rem),
    // Tailwind's ease-out (cubic-bezier(0,0,.2,1)), no scale. It leaves faster (180ms, ease-in), the
    // same speed as the search bar shrinking to its magnifying glass. Reduced-motion users get the instant show/hide.
    var DETAIL_IN_MS = 500, DETAIL_OUT_MS = 180, SWAP_MS = 250;
    var EASE_IN = 'cubic-bezier(.4,0,1,1)', EASE_OUT = 'cubic-bezier(0,0,.2,1)', SWAP_EASE = 'cubic-bezier(.16,1,.3,1)';
    var detailBox = detailPanel || detail, detailAnim = null, leaving = false;
    detailBox.style.transformOrigin = '0 100%';
    var still = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: true };
    function slideDetail(show, done) {
      if (detailAnim) { detailAnim.cancel(); detailAnim = null; }
      leaving = !show;
      if (still.matches || !detailBox.animate) { leaving = false; if (done) done(); return; }
      var a = detailBox.animate(
        [{ opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'none' }],
        { duration: show ? DETAIL_IN_MS : DETAIL_OUT_MS, easing: show ? EASE_OUT : EASE_IN,
          direction: show ? 'normal' : 'reverse', fill: 'forwards' });
      detailAnim = a;
      a.onfinish = function () {
        detailAnim = null; leaving = false;
        if (done) done();
        a.cancel();   // drop the held frame once it's hidden (or fully shown)
      };
    }

    // Switching oysters while the card is up: the new details fade in from 97% size over 250ms
    // with a soft ease-out, so the swap reads as a change instead of a reload. Animates the inner details
    // (not the card), so it never fights slideDetail. A fast second tap restarts it. Reduced-motion users get the instant swap.
    var swapAnim = null;
    function swapDetail() {
      if (still.matches || !detail.animate) return;
      if (swapAnim) swapAnim.cancel();
      var a = detail.animate(
        [{ opacity: 0, transform: 'scale(.97)' }, { opacity: 1, transform: 'none' }],
        { duration: SWAP_MS, easing: SWAP_EASE });
      swapAnim = a;
      a.onfinish = function () { if (swapAnim === a) swapAnim = null; };
    }

    function reset() {
      input.value = '';
      active = -1;
      clearDetail();
      setHit(map, null, null, null, o.nameKey);
      render();
    }

    // Opening or typing in search no longer clears the picked oyster's card: the page tucks it away while
    // search is open and brings it back when search shuts (see quiet() in index.html). Only a card still
    // waiting for its flight to land is dropped. A new pick, a tap on empty map, or Escape still clear it.
    function holdDetail() { landing++; }
    input.addEventListener('input', function () { active = -1; holdDetail(); expand(); render(); });

    // ----- details + minimizing -----
    // The details clear on a new pick or a tap elsewhere
    // (taps in the species legend don't count: they leave the picked oyster in place).
    // Dragging or pinching the map never counts as a tap, so it leaves them in place.
    // A tap outside the search also minimizes it (hides the list, drops the phone keyboard)
    // so the map can be moved freely; tapping the box brings the list back.
    var card = input.closest('.oa-search') || list.parentNode;
    // keepFocus: after a keyboard pick the cursor stays in the box (typing or ↓ brings the list back);
    // after a click or tap the box lets go of focus, which also drops a phone's keyboard.
    function minimize(keepFocus) {
      card.classList.add('oa-collapsed');
      input.setAttribute('aria-expanded', 'false');
      if (!keepFocus && document.activeElement === input) input.blur();
    }
    function expand() {
      card.classList.remove('oa-collapsed');
      if (shown.length) input.setAttribute('aria-expanded', 'true');
    }
    input.addEventListener('focus', function () {
      holdDetail();
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
      // Opening, reading or closing the species legend or the Regions button keeps the picked oyster; it only tucks the search away.
      if (t.closest && t.closest('.map-legend-panel, .oa-regions')) { minimize(); return; }
      var hit = t.closest && t.closest('.mapboxgl-canvas-container') ? nearestOyster(e) : null;
      minimize();
      if (hit) {                  // tapped an oyster on the map: it becomes the one shown
        input.value = '';          // the old search no longer applies, so clear it
        active = -1;
        render();
        setHit(map, hit.coord, hit.color, hit.name, o.nameKey);
        landing++;               // this tap wins over a search pick still in flight
        showDetail(hit);
      }
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
      var collapsed = card.classList.contains('oa-collapsed');
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && collapsed) { e.preventDefault(); expand(); return; }  // bring the list back
      if (e.key === 'ArrowDown') { e.preventDefault(); if (shown.length) setActive(Math.min(active + 1, shown.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (shown.length) setActive(Math.max(active - 1, 0)); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(active >= 0 ? active : 0, true); }
      else if (e.key === 'Escape') { e.preventDefault(); reset(); }
    });
    list.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep focus in the box
    list.addEventListener('click', function (e) {
      var li = e.target.closest('.oa-result');
      if (li) pick(Number(li.dataset.index));
    });
    if (clearBtn) clearBtn.addEventListener('click', function () { reset(); input.focus(); });

    // ready: resolves to the oysters once loaded. show(oyster, instant): go to one, as a search pick does.
    return { reset: reset, ready: itemsReady, show: show };
  }

  global.OysterSearch = { init: init, _search: search, _norm: norm, _placesOf: placesOf };
})(window);
