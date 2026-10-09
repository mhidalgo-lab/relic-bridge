// SPDX-License-Identifier: Apache-2.0
// relic-bridge NRQL chart (P7-04): an MCP Apps view (spec 2026-01-26) for `run_nrql` / `get_query_result`.
// Speaks the spec's JSON-RPC over postMessage without the SDK and draws the tool's own `structuredContent`.
//
// Safety rules (THREAT_MODEL T6 / T13 / P7-04):
// - Every label, value and query text comes from New Relic and is untrusted. The DOM is built with createElement /
//   createElementNS and textContent only; attribute names are literals of this file and attribute values are numbers
//   or constants. No HTML sink, no dynamic code, no URL built from data.
// - Messages are accepted only from `window.parent` and only as JSON-RPC 2.0. Nothing from the result is ever sent
//   back: the view sends protocol messages (initialize, initialized, size) and nothing else.
// - No network: no fetch, no XHR, no image or font loads; the resource declares no CSP domains.
(() => {
  const PROTOCOL_VERSION = '2026-01-26';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  /** Work and DOM bounds: the result is at most 1000 rows, the view draws far less. */
  const MAX_SERIES = 10;
  const MAX_POINTS = 500;
  const MAX_BARS = 25;
  const MAX_ROWS = 100;
  const MAX_COLUMNS = 12;
  const MAX_LABEL = 80;
  const MAX_CELL = 200;
  const MAX_NRQL = 400;
  const MAX_DOTS = 120;
  const TIME_COLUMNS = ['beginTimeSeconds', 'endTimeSeconds', 'timestamp'];
  const PALETTE = [
    '#2a78d6',
    '#e8702a',
    '#1f9e6e',
    '#c43c76',
    '#7a5cd6',
    '#b8860b',
    '#17a2b8',
    '#d64545',
    '#5c7a29',
    '#8c6d62',
  ];
  /** Host theme variables applied (spec standard names); anything else the host sends is ignored. */
  const THEME_VARS = [
    '--color-background-primary',
    '--color-text-primary',
    '--color-text-secondary',
    '--color-border-primary',
    '--font-sans',
    '--font-mono',
  ];
  const SAFE_CSS_VALUE = /^[^;{}<>\\]*$/;

  const parent = window.parent;
  const app = document.getElementById('app');
  const state = {
    result: undefined,
    view: 'chart',
    metric: undefined,
    hidden: new Set(),
    locale: undefined,
    timeZone: undefined,
  };
  const waiting = new Map();
  let nextId = 1;

  // ---- protocol ------------------------------------------------------------------------------------------------

  function send(message) {
    parent.postMessage(message, '*');
  }

  function request(method, params) {
    const id = nextId++;
    send({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve) => waiting.set(id, resolve));
  }

  function respond(id, result) {
    send({ jsonrpc: '2.0', id, result });
  }

  function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== parent) return;
    const msg = event.data;
    if (!isObject(msg) || msg.jsonrpc !== '2.0') return;
    const hasId = typeof msg.id === 'number' || typeof msg.id === 'string';
    if (typeof msg.method === 'string') {
      if (hasId) onRequest(msg.id, msg.method);
      else onNotification(msg.method, msg.params);
    } else if (hasId && waiting.has(msg.id)) {
      const done = waiting.get(msg.id);
      waiting.delete(msg.id);
      done(msg);
    }
  });

  function onRequest(id, method) {
    if (method === 'ui/resource-teardown' || method === 'ping') {
      respond(id, {});
      return;
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  }

  function onNotification(method, params) {
    if (method === 'ui/notifications/tool-result') {
      if (!isObject(params)) return;
      if (params.isError === true) {
        state.result = undefined;
        showMessage('The query failed. The error is in the conversation.');
        return;
      }
      state.result = params.structuredContent;
      state.metric = undefined;
      state.hidden = new Set();
      render();
    } else if (method === 'ui/notifications/tool-input') {
      if (state.result === undefined) showMessage('Running the query…');
    } else if (method === 'ui/notifications/tool-cancelled') {
      if (state.result === undefined) showMessage('The query was cancelled.');
    } else if (method === 'ui/notifications/host-context-changed') {
      applyContext(params);
      if (state.result !== undefined) render();
    }
  }

  function applyContext(ctx) {
    if (!isObject(ctx)) return;
    const root = document.documentElement;
    if (ctx.theme === 'light' || ctx.theme === 'dark') root.setAttribute('data-theme', ctx.theme);
    const vars = isObject(ctx.styles) && isObject(ctx.styles.variables) ? ctx.styles.variables : undefined;
    if (vars) {
      for (const name of THEME_VARS) {
        const value = Object.hasOwn(vars, name) ? vars[name] : undefined;
        if (
          typeof value === 'string' &&
          value.length <= 200 &&
          SAFE_CSS_VALUE.test(value) &&
          !/url\(|image/i.test(value)
        ) {
          root.style.setProperty(name, value);
        }
      }
    }
    if (typeof ctx.locale === 'string' && ctx.locale.length <= 35) {
      try {
        if (Intl.DateTimeFormat.supportedLocalesOf([ctx.locale]).length > 0) state.locale = ctx.locale;
      } catch {
        // invalid tag: keep the default
      }
    }
    if (typeof ctx.timeZone === 'string' && ctx.timeZone.length <= 64) {
      try {
        new Intl.DateTimeFormat('en', { timeZone: ctx.timeZone });
        state.timeZone = ctx.timeZone;
      } catch {
        // unknown zone: keep the default
      }
    }
  }

  let lastSize = '';
  /** Set once the host answered `ui/initialize`: nothing but that request is sent before. */
  let ready = false;
  function reportSize() {
    if (!ready) return;
    const rect = document.body.getBoundingClientRect();
    const size = { width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
    const key = `${size.width}x${size.height}`;
    if (key === lastSize) return;
    lastSize = key;
    send({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: size });
  }

  // ---- DOM helpers (text only) ---------------------------------------------------------------------------------

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function svgEl(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  }

  function svgText(x, y, text, anchor) {
    const node = svgEl('text', { x: x.toFixed(1), y: y.toFixed(1), 'text-anchor': anchor || 'start' });
    node.textContent = text;
    return node;
  }

  function tooltip(node, text) {
    const title = svgEl('title');
    title.textContent = text;
    node.appendChild(title);
    return node;
  }

  /** Display form of untrusted text: control characters removed, length capped. */
  function label(value, max) {
    const limit = max || MAX_LABEL;
    let text;
    if (typeof value === 'string') text = value;
    else if (value === null || value === undefined) text = '';
    else if (typeof value === 'number' || typeof value === 'boolean') text = String(value);
    else {
      try {
        text = JSON.stringify(value) || '';
      } catch {
        text = '';
      }
    }
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    text = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  }

  function showMessage(text) {
    app.replaceChildren(el('p', 'msg', text));
    reportSize();
  }

  function own(row, key) {
    return Object.hasOwn(row, key) ? row[key] : undefined;
  }

  /** A finite number, or a single-key object holding one (percentile results); otherwise null. */
  function toNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (isObject(value)) {
      const keys = Object.keys(value);
      if (keys.length === 1) {
        const inner = value[keys[0]];
        if (typeof inner === 'number' && Number.isFinite(inner)) return inner;
      }
    }
    return null;
  }

  function formatNumber(n) {
    try {
      return new Intl.NumberFormat(state.locale, { maximumFractionDigits: 2, notation: 'compact' }).format(n);
    } catch {
      return String(Math.round(n * 100) / 100);
    }
  }

  function formatTime(seconds, withDate) {
    const options = withDate
      ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { hour: '2-digit', minute: '2-digit' };
    if (state.timeZone) options.timeZone = state.timeZone;
    try {
      return new Intl.DateTimeFormat(state.locale, options).format(new Date(seconds * 1000));
    } catch {
      return new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ');
    }
  }

  // ---- model ---------------------------------------------------------------------------------------------------

  function strings(v) {
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  }

  function facetLabel(row, facets) {
    const f = own(row, 'facet');
    if (typeof f === 'string' || typeof f === 'number') return label(f);
    if (Array.isArray(f)) return label(f.map((x) => label(x, MAX_CELL)).join(', '));
    return label(facets.map((name) => label(own(row, name), MAX_CELL)).join(', '));
  }

  /** What to draw for a result: line, bar, table or a message. Pure (no DOM). */
  function analyse(result) {
    if (!isObject(result)) return { kind: 'message', text: 'This result has no rows to chart.' };
    if (result.status === 'pending') {
      return {
        kind: 'message',
        text: 'The query is still running: the chart appears with get_query_result.',
      };
    }
    const rows = Array.isArray(result.rows) ? result.rows.filter(isObject) : [];
    if (rows.length === 0) return { kind: 'message', text: 'The query returned no rows.' };
    let columns = strings(result.columns);
    if (columns.length === 0) columns = Object.keys(rows[0]);
    const facets = strings(result.facets);
    const skip = new Set([...TIME_COLUMNS, 'facet', ...facets]);
    const metrics = columns
      .filter((c) => !skip.has(c) && rows.some((r) => toNumber(own(r, c)) !== null))
      .slice(0, MAX_COLUMNS);
    const timed =
      result.timeseries === true && rows.some((r) => typeof own(r, 'beginTimeSeconds') === 'number');
    if (timed && metrics.length > 0) return { kind: 'line', rows, columns, facets, metrics };
    if (facets.length > 0 && metrics.length > 0) return { kind: 'bar', rows, columns, facets, metrics };
    return { kind: 'table', rows, columns };
  }

  function lineSeries(model, metric) {
    const byKey = new Map();
    let dropped = 0;
    const add = (key, t, v) => {
      let s = byKey.get(key);
      if (s === undefined) {
        if (byKey.size >= MAX_SERIES) {
          dropped++;
          return;
        }
        s = { key, points: [] };
        byKey.set(key, s);
      }
      s.points.push([t, v]);
    };
    for (const row of model.rows) {
      const t = own(row, 'beginTimeSeconds');
      if (typeof t !== 'number' || !Number.isFinite(t)) continue;
      if (model.facets.length > 0) {
        const v = toNumber(own(row, metric));
        if (v !== null) add(facetLabel(row, model.facets), t, v);
      } else {
        for (const m of model.metrics) {
          const v = toNumber(own(row, m));
          if (v !== null) add(label(m), t, v);
        }
      }
    }
    const series = [...byKey.values()];
    for (const s of series) {
      s.points.sort((a, b) => a[0] - b[0]);
      if (s.points.length > MAX_POINTS) {
        const step = s.points.length / MAX_POINTS;
        s.points = Array.from({ length: MAX_POINTS }, (_, i) => s.points[Math.floor(i * step)]);
      }
    }
    return { series, dropped };
  }

  // ---- views ---------------------------------------------------------------------------------------------------

  const W = 640;
  const H = 260;
  const M = { left: 56, right: 12, top: 10, bottom: 26 };

  function niceTicks(min, max, count) {
    const span = max - min;
    const raw = span / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => span / s <= count) || raw;
    const ticks = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9 && ticks.length < 12; v += step) {
      ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    }
    return ticks;
  }

  function drawLine(model, metric) {
    const { series, dropped } = lineSeries(model, metric);
    const visible = series.filter((s) => !state.hidden.has(s.key));
    const wrap = el('div');
    if (series.length === 0) {
      wrap.appendChild(el('p', 'msg', 'No numeric values to chart.'));
      return wrap;
    }
    let tMin = Number.POSITIVE_INFINITY;
    let tMax = Number.NEGATIVE_INFINITY;
    let yMin = 0;
    let yMax = Number.NEGATIVE_INFINITY;
    for (const s of visible.length > 0 ? visible : series) {
      for (const [t, v] of s.points) {
        tMin = Math.min(tMin, t);
        tMax = Math.max(tMax, t);
        yMin = Math.min(yMin, v);
        yMax = Math.max(yMax, v);
      }
    }
    if (tMax === tMin) tMax = tMin + 60;
    if (!(yMax > yMin)) yMax = yMin + 1;
    const ticks = niceTicks(yMin, yMax, 4);
    yMax = Math.max(yMax, ticks[ticks.length - 1] || yMax);
    const x = (t) => M.left + ((t - tMin) / (tMax - tMin)) * (W - M.left - M.right);
    const y = (v) => H - M.bottom - ((v - yMin) / (yMax - yMin)) * (H - M.top - M.bottom);
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
    svg.appendChild(svgEl('title')).textContent = `Line chart of ${label(metric)}`;
    for (const v of ticks) {
      svg.appendChild(svgEl('line', { class: 'grid', x1: M.left, x2: W - M.right, y1: y(v), y2: y(v) }));
      svg.appendChild(svgText(M.left - 6, y(v) + 3, formatNumber(v), 'end'));
    }
    svg.appendChild(
      svgEl('line', { class: 'axis', x1: M.left, x2: W - M.right, y1: H - M.bottom, y2: H - M.bottom }),
    );
    const multiDay = tMax - tMin > 86_400;
    for (let i = 0; i <= 4; i++) {
      const t = tMin + ((tMax - tMin) * i) / 4;
      const anchor = i === 0 ? 'start' : i === 4 ? 'end' : 'middle';
      svg.appendChild(svgText(x(t), H - 8, formatTime(t, multiDay), anchor));
    }
    series.forEach((s, i) => {
      if (state.hidden.has(s.key)) return;
      const color = PALETTE[i % PALETTE.length];
      const d = s.points
        .map(([t, v], j) => `${j === 0 ? 'M' : 'L'}${x(t).toFixed(1)} ${y(v).toFixed(1)}`)
        .join(' ');
      const path = svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.75 });
      svg.appendChild(tooltip(path, s.key));
      if (s.points.length <= MAX_DOTS) {
        for (const [t, v] of s.points) {
          const dot = svgEl('circle', { cx: x(t).toFixed(1), cy: y(v).toFixed(1), r: 2.5, fill: color });
          svg.appendChild(tooltip(dot, `${s.key} · ${formatTime(t, true)}: ${formatNumber(v)}`));
        }
      }
    });
    wrap.appendChild(svg);
    const legend = el('div', 'bar');
    series.forEach((s, i) => {
      const button = el('button', 'series');
      button.type = 'button';
      button.setAttribute('aria-pressed', state.hidden.has(s.key) ? 'false' : 'true');
      const swatch = el('span', 'swatch');
      swatch.style.background = PALETTE[i % PALETTE.length];
      button.append(swatch, document.createTextNode(s.key));
      button.addEventListener('click', () => {
        if (state.hidden.has(s.key)) state.hidden.delete(s.key);
        else state.hidden.add(s.key);
        render();
      });
      legend.appendChild(button);
    });
    wrap.appendChild(legend);
    if (dropped > 0) wrap.appendChild(el('p', 'note', `Only the first ${MAX_SERIES} series are drawn.`));
    return wrap;
  }

  function drawBars(model, metric) {
    const items = [];
    for (const row of model.rows) {
      const v = toNumber(own(row, metric));
      if (v !== null) items.push({ name: facetLabel(row, model.facets), v });
      if (items.length >= MAX_BARS) break;
    }
    const wrap = el('div');
    if (items.length === 0) {
      wrap.appendChild(el('p', 'msg', 'No numeric values to chart.'));
      return wrap;
    }
    const rowH = 22;
    const labelW = 200;
    const height = items.length * rowH + 8;
    let lo = 0;
    let hi = 0;
    for (const it of items) {
      lo = Math.min(lo, it.v);
      hi = Math.max(hi, it.v);
    }
    if (hi === lo) hi = lo + 1;
    const plotW = W - labelW - 70;
    const x = (v) => labelW + ((v - lo) / (hi - lo)) * plotW;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${height}`, role: 'img' });
    svg.appendChild(svgEl('title')).textContent = `Bar chart of ${label(metric)}`;
    items.forEach((it, i) => {
      const top = 4 + i * rowH;
      svg.appendChild(svgText(labelW - 6, top + 14, label(it.name, 32), 'end'));
      const x0 = x(Math.min(0, it.v));
      const x1 = x(Math.max(0, it.v));
      const rect = svgEl('rect', {
        x: x0.toFixed(1),
        y: top + 3,
        width: Math.max(1, x1 - x0).toFixed(1),
        height: rowH - 8,
        fill: PALETTE[0],
        rx: 2,
      });
      svg.appendChild(tooltip(rect, `${it.name}: ${formatNumber(it.v)}`));
      svg.appendChild(svgText(x1 + 4, top + 14, formatNumber(it.v)));
    });
    wrap.appendChild(svg);
    return wrap;
  }

  function drawTable(model) {
    const columns = model.columns.slice(0, MAX_COLUMNS);
    const wrap = el('div', 'table-wrap');
    const table = el('table');
    const head = el('tr');
    for (const c of columns) head.appendChild(el('th', '', label(c)));
    table.appendChild(el('thead')).appendChild(head);
    const body = el('tbody');
    for (const row of model.rows.slice(0, MAX_ROWS)) {
      const tr = el('tr');
      for (const c of columns) {
        const v = own(row, c);
        const td = el('td', typeof v === 'number' ? 'num' : '', label(v, MAX_CELL));
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    table.appendChild(body);
    wrap.appendChild(table);
    const notes = [];
    if (model.rows.length > MAX_ROWS) notes.push(`first ${MAX_ROWS} rows`);
    if (model.columns.length > MAX_COLUMNS) notes.push(`first ${MAX_COLUMNS} columns`);
    if (notes.length > 0) wrap.appendChild(el('p', 'note', `Showing the ${notes.join(' and ')}.`));
    return wrap;
  }

  function render() {
    const result = state.result;
    const model = analyse(result);
    if (model.kind === 'message') {
      showMessage(model.text);
      return;
    }
    const parts = [];
    if (typeof result.nrql === 'string') parts.push(el('p', 'nrql', label(result.nrql, MAX_NRQL)));
    const chartable = model.kind === 'line' || model.kind === 'bar';
    const controls = el('div', 'bar');
    if (chartable) {
      for (const view of ['chart', 'table']) {
        const button = el('button', '', view === 'chart' ? 'Chart' : 'Table');
        button.type = 'button';
        button.setAttribute('aria-pressed', state.view === view ? 'true' : 'false');
        button.addEventListener('click', () => {
          state.view = view;
          render();
        });
        controls.appendChild(button);
      }
    }
    const metric = model.metrics?.includes(state.metric) ? state.metric : model.metrics?.[0];
    const perMetric = model.kind === 'bar' || (model.kind === 'line' && model.facets.length > 0);
    if (chartable && state.view === 'chart' && perMetric && model.metrics.length > 1) {
      const select = el('select');
      select.setAttribute('aria-label', 'Metric');
      model.metrics.forEach((m, i) => {
        const option = el('option', '', label(m));
        option.value = String(i);
        option.selected = m === metric;
        select.appendChild(option);
      });
      select.addEventListener('change', () => {
        state.metric = model.metrics[Number(select.value)];
        render();
      });
      controls.appendChild(select);
    }
    if (controls.childNodes.length > 0) parts.push(controls);
    if (!chartable || state.view === 'table') parts.push(drawTable(model));
    else if (model.kind === 'line') parts.push(drawLine(model, metric));
    else parts.push(drawBars(model, metric));
    const total = typeof result.totalRows === 'number' ? result.totalRows : model.rows.length;
    let note = `${total} ${total === 1 ? 'row' : 'rows'}`;
    if (isObject(result.summary)) note += `, summarized to ${model.rows.length} for display`;
    else if (result.truncated === true) note += `, ${model.rows.length} shown`;
    parts.push(el('p', 'note', `${note}. Labels and values come from New Relic.`));
    app.replaceChildren(...parts);
    reportSize();
  }

  // ---- start ---------------------------------------------------------------------------------------------------

  if (typeof ResizeObserver === 'function') new ResizeObserver(reportSize).observe(document.body);
  request('ui/initialize', {
    appInfo: { name: 'relic-bridge-nrql-chart', version: '1' },
    appCapabilities: { availableDisplayModes: ['inline'] },
    protocolVersion: PROTOCOL_VERSION,
  }).then((msg) => {
    if (!isObject(msg.result)) return;
    applyContext(msg.result.hostContext);
    send({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
    ready = true;
    if (state.result !== undefined) render();
    else reportSize();
  });
})();
