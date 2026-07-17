/*
 * Agentic Usage — Token Usage by Hour (Canvas 2D custom visualization)
 *
 * Stacked area chart: cacheRead (teal, front) + cacheCreation (cyan) stacked,
 * with a thin leading line, value gridlines, weekday x-ticks and a legend.
 * Hovering shows a per-hour tooltip (a vertical guide + point markers + a
 * breakdown of every token type for that hour). Pure Canvas 2D, HiDPI-aware, ES5.
 *
 * Expected SPL columns (configurable): _time, cacheRead, cacheCreation, input,
 * output — e.g. `| timechart span=1h sum(tokens) BY type`.
 */
define([
    'api/SplunkVisualizationBase',
    'api/SplunkVisualizationUtils'
], function(SplunkVisualizationBase, SplunkVisualizationUtils) {

    var MONO = "'JetBrains Mono', ui-monospace, monospace";
    var SANS = "'IBM Plex Sans', -apple-system, sans-serif";
    var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    function num(v) { var f = parseFloat(v); return isNaN(f) ? 0 : f; }
    function esc(s) {
        s = (s === undefined || s === null) ? '' : String(s);
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    function groupNum(n) {
        var s = String(n), neg = s.charAt(0) === '-';
        if (neg) { s = s.slice(1); }
        var p = s.split('.'), intPart = p[0], dec = p.length > 1 ? '.' + p[1] : '', out = '', c = 0, k;
        for (k = intPart.length - 1; k >= 0; k--) {
            out = intPart.charAt(k) + out;
            if ((++c % 3) === 0 && k > 0) { out = ',' + out; }
        }
        return (neg ? '-' : '') + out + dec;
    }
    function hexToRgba(hex, a) {
        if (typeof hex !== 'string' || hex.charAt(0) !== '#') { return hex; }
        return 'rgba(' + parseInt(hex.slice(1, 3), 16) + ',' + parseInt(hex.slice(3, 5), 16) + ',' + parseInt(hex.slice(5, 7), 16) + ',' + a + ')';
    }
    function fmtAxis(v, div, unit) {
        var x = v / (div || 1);
        var s = (x >= 100 || x === Math.round(x)) ? String(Math.round(x)) : x.toFixed(1);
        return groupNum(s) + (unit || '');
    }
    // Splunk hands _time to a custom viz either as an epoch (seconds or ms) or
    // as a formatted/ISO string. Parse all of those into a Date (or null).
    function parseTime(t) {
        if (t === null || t === undefined) { return null; }
        var s = String(t).replace(/^\s+|\s+$/g, '');
        if (s === '') { return null; }
        if (/^\d+(\.\d+)?$/.test(s)) {            // pure number → epoch
            var n = parseFloat(s);
            if (n >= 1e12) { return new Date(n); }        // milliseconds
            if (n >= 1e8) { return new Date(n * 1000); }  // seconds
            return null;                                  // too small to be a time
        }
        // normalise common Splunk variants, e.g. "YYYY-MM-DD HH:MM:SS.mmm +0200"
        var iso = s
            .replace(/^(\d{4}-\d\d-\d\d) /, '$1T')        // date/time separator → T
            .replace(/\s+([+-]\d\d:?\d\d)$/, '$1')        // drop space before TZ offset
            .replace(/([+-]\d\d)(\d\d)$/, '$1:$2');       // "+0200" → "+02:00"
        var d = new Date(iso);
        if (isNaN(d.getTime())) { d = new Date(s); }
        return isNaN(d.getTime()) ? null : d;
    }
    function fmtHour(t) {
        var d = parseTime(t);
        if (!d) { return ''; }
        return DOW[d.getDay()] + ', ' + MON[d.getMonth()] + ' ' + d.getDate() + ' · ' + pad2(d.getHours()) + ':00';
    }
    // Theme palette for canvas-drawn neutrals (data/series colours are kept).
    var THEME = {
        dark:  { text: 'rgba(233,238,244,.92)', muted: 'rgba(93,103,115,1)', secondary: 'rgba(152,163,176,1)', grid: 'rgba(255,255,255,.07)', track: 'rgba(255,255,255,.06)', tipBg: 'rgba(10,12,16,.97)', tipBorder: 'rgba(255,255,255,.16)', guide: 'rgba(255,255,255,.22)', markerStroke: '#0a0c10', readout: '#fff', statusText: 'rgba(152,163,176,.7)' },
        light: { text: 'rgba(26,29,36,.95)', muted: 'rgba(138,149,163,1)', secondary: 'rgba(86,98,112,1)', grid: 'rgba(15,23,32,.08)', track: 'rgba(15,23,32,.06)', tipBg: 'rgba(255,255,255,.98)', tipBorder: 'rgba(15,23,32,.16)', guide: 'rgba(15,23,32,.28)', markerStroke: '#ffffff', readout: '#1a1d24', statusText: 'rgba(86,98,112,.8)' }
    };
    // The dashboard passes the page-background hex (or "light"/"dark") as `theme`.
    function cuLum(c) {
        if (typeof c !== 'string') { return 0; }
        var h = c.replace(/^\s+|\s+$/g, '');
        if (h.charAt(0) !== '#') { return 0; }
        if (h.length === 4) { h = '#' + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2) + h.charAt(3) + h.charAt(3); }
        var r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16);
        return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    }
    function cuIsLight(v) {
        v = (v === undefined || v === null) ? '' : String(v);
        if (v.charAt(0) === '#') { return cuLum(v) > 0.6; }
        return v.toLowerCase() === 'light';
    }

    return SplunkVisualizationBase.extend({

        initialize: function() {
            SplunkVisualizationBase.prototype.initialize.apply(this, arguments);
            this.el.classList.add('agentic-usage');
            this.container = document.createElement('div');
            this.container.className = 'cu-area-root';
            this.canvas = document.createElement('canvas');
            this.container.appendChild(this.canvas);
            this.tip = document.createElement('div');
            this.tip.className = 'cu-area-tip';
            this.tip.style.display = 'none';
            this.container.appendChild(this.tip);
            this.el.appendChild(this.container);
            this._lastGoodData = null;
            this._data = null;
            this._cfg = null;
            this._statusMsg = null;
            // Hover state
            this._hoverIdx = null;
            this._raf = null;
            this._geom = null;
            this._tipItems = null;
            this._times = null;
            var self = this;
            this.canvas.addEventListener('mousemove', function(e) { self._onMove(e); });
            this.canvas.addEventListener('mouseleave', function() { self._clearHover(); });
        },

        getInitialDataParams: function() {
            return {
                outputMode: SplunkVisualizationBase.ROW_MAJOR_OUTPUT_MODE,
                count: 10000
            };
        },

        formatData: function(data) {
            if (!data || !data.rows || data.rows.length === 0) {
                if (this._lastGoodData) { return this._lastGoodData; }
                throw new SplunkVisualizationBase.VisualizationError('Awaiting data — Token Usage');
            }
            var fields = data.fields, colIdx = {}, i;
            for (i = 0; i < fields.length; i++) { colIdx[fields[i].name] = i; }
            if (colIdx._status !== undefined) {
                var sRow = data.rows[data.rows.length - 1];
                var sVal = sRow[colIdx._status];
                if (sVal) { return { _status: sVal }; }
            }
            var result = { rows: data.rows, colIdx: colIdx };
            this._lastGoodData = result;
            return result;
        },

        updateView: function(data, config) {
            var ns = this.getPropertyNamespaceInfo().propertyNamespace;
            // Apply theme before the no-data guard so the status state is themed too.
            this._isLight = cuIsLight(config[ns + 'theme']);
            this.el.setAttribute('data-theme', this._isLight ? 'light' : 'dark');
            if (data && data._status) { this._statusMsg = data._status; this._clearHover(); this._drawStatus(); return; }
            if (!data) {
                if (this._lastGoodData) { data = this._lastGoodData; } else { return; }
            }
            this._statusMsg = null;
            function cfg(k, d) { var v = config[ns + k]; return (v === undefined || v === null || v === '') ? d : v; }
            this._cfg = {
                title: cfg('title', 'Token Usage by Hour'),
                timeField: cfg('timeField', '_time'),
                labelField: cfg('labelField', 'hourLabel'),
                tickLabelField: cfg('tickLabelField', 'tickLabel'),
                readField: cfg('readField', 'cacheRead'),
                createField: cfg('createField', 'cacheCreation'),
                inputField: cfg('inputField', 'input'),
                outputField: cfg('outputField', 'output'),
                readLabel: cfg('readLabel', 'cacheRead'),
                createLabel: cfg('createLabel', 'cacheCreation'),
                readColor: cfg('readColor', '#28b6a4'),
                createColor: cfg('createColor', '#3aa6c2'),
                inputColor: cfg('inputColor', '#f2643d'),
                outputColor: cfg('outputColor', '#e6b24a'),
                valueDivisor: parseFloat(cfg('valueDivisor', '1')) || 1,
                valueUnit: cfg('valueUnit', ''),
                showLegend: cfg('showLegend', 'true') === 'true'
            };
            this._data = data;
            this._hoverIdx = null;
            this.tip.style.display = 'none';
            this._draw();
        },

        _draw: function() {
            var data = this._data, o = this._cfg;
            if (!data || !o) { return; }
            var rect = this.el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) { return; }
            var dpr = window.devicePixelRatio || 1;
            this.canvas.width = rect.width * dpr;
            this.canvas.height = rect.height * dpr;
            var ctx = this.canvas.getContext('2d');
            if (!ctx) { return; }
            ctx.scale(dpr, dpr);
            var w = rect.width, h = rect.height;
            ctx.clearRect(0, 0, w, h);
            var P = this._isLight ? THEME.light : THEME.dark;

            var ci = data.colIdx, rows = data.rows, n = rows.length, i;
            var read = [], create = [], input = [], output = [], times = [], labels = [], tlabels = [], maxTotal = 0;
            for (i = 0; i < n; i++) {
                var r = rows[i];
                var rd = ci[o.readField] !== undefined ? num(r[ci[o.readField]]) : 0;
                var cr = ci[o.createField] !== undefined ? num(r[ci[o.createField]]) : 0;
                read.push(rd); create.push(cr);
                input.push(ci[o.inputField] !== undefined ? num(r[ci[o.inputField]]) : 0);
                output.push(ci[o.outputField] !== undefined ? num(r[ci[o.outputField]]) : 0);
                times.push(ci[o.timeField] !== undefined ? r[ci[o.timeField]] : null);
                labels.push(ci[o.labelField] !== undefined ? r[ci[o.labelField]] : null);
                tlabels.push(ci[o.tickLabelField] !== undefined ? r[ci[o.tickLabelField]] : null);
                if (rd + cr > maxTotal) { maxTotal = rd + cr; }
            }
            if (maxTotal <= 0) { maxTotal = 1; }

            // Series present in the data (read+create always; input/output if their
            // columns exist). Labels are configurable so the same viz can show
            // token types (cacheRead/…) or other series (e.g. Claude/Manual).
            var items = [
                { k: o.readLabel, c: o.readColor, vals: read },
                { k: o.createLabel, c: o.createColor, vals: create }
            ];
            if (ci[o.inputField] !== undefined) { items.push({ k: 'input', c: o.inputColor, vals: input }); }
            if (ci[o.outputField] !== undefined) { items.push({ k: 'output', c: o.outputColor, vals: output }); }

            var pad = 14;
            var titleH = o.title ? 22 : 0;
            var legendH = o.showLegend ? 20 : 0;
            var L = pad + 38, R = pad, T = pad + titleH, B = pad + 18 + legendH;
            var iw = w - L - R, ih = h - T - B;
            if (iw < 10 || ih < 10) { return; }

            function X(idx) { return L + (n <= 1 ? 0 : (idx / (n - 1)) * iw); }
            function Y(v) { return T + ih - (v / maxTotal) * ih; }

            // Title
            if (o.title) {
                ctx.font = '600 14px ' + SANS; ctx.fillStyle = P.text;
                ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
                ctx.fillText(o.title, pad, pad + 13);
            }

            // Gridlines + y labels
            var glines = 4;
            ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.font = '10px ' + MONO;
            for (i = 0; i <= glines; i++) {
                var val = maxTotal * (i / glines), gy = Y(val);
                ctx.strokeStyle = P.grid; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(L, gy); ctx.lineTo(w - R, gy); ctx.stroke();
                ctx.fillStyle = P.muted;
                ctx.fillText(fmtAxis(val, o.valueDivisor, o.valueUnit), L - 8, gy);
            }

            function areaPath(topFn) {
                ctx.beginPath();
                var j;
                for (j = 0; j < n; j++) { var x = X(j), y = topFn(j); if (j === 0) { ctx.moveTo(x, y); } else { ctx.lineTo(x, y); } }
                ctx.lineTo(X(n - 1), T + ih); ctx.lineTo(X(0), T + ih); ctx.closePath();
            }
            // cacheCreation band (stack top), then cacheRead front
            var gC = ctx.createLinearGradient(0, T, 0, T + ih);
            gC.addColorStop(0, hexToRgba(o.createColor, 0.55)); gC.addColorStop(1, hexToRgba(o.createColor, 0.08));
            areaPath(function(j) { return Y(read[j] + create[j]); }); ctx.fillStyle = gC; ctx.fill();

            var gR = ctx.createLinearGradient(0, T, 0, T + ih);
            gR.addColorStop(0, hexToRgba(o.readColor, 0.95)); gR.addColorStop(1, hexToRgba(o.readColor, 0.18));
            areaPath(function(j) { return Y(read[j]); }); ctx.fillStyle = gR; ctx.fill();

            // leading line
            ctx.beginPath();
            for (i = 0; i < n; i++) { var lx = X(i), ly = Y(read[i]); if (i === 0) { ctx.moveTo(lx, ly); } else { ctx.lineTo(lx, ly); } }
            ctx.strokeStyle = o.readColor; ctx.lineWidth = 1.4; ctx.stroke();

            // x labels (weekday ticks)
            ctx.fillStyle = P.muted; ctx.font = '10px ' + MONO;
            ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
            var ticks = Math.min(7, n); if (ticks < 1) { ticks = 1; }
            for (i = 0; i < ticks; i++) {
                var idx = Math.round((ticks === 1 ? 0 : (i / (ticks - 1))) * (n - 1));
                var lab = (tlabels[idx] !== null && tlabels[idx] !== undefined && tlabels[idx] !== '') ? tlabels[idx] : this._tick(times[idx]);
                if (lab) { ctx.fillText(lab, X(idx), T + ih + 16); }
            }

            if (o.showLegend) { this._legend(ctx, w, h, items); }

            // Hover guide + markers
            var hi = this._hoverIdx;
            if (hi !== null && hi >= 0 && hi < n) {
                var hx = X(hi), topV = read[hi] + create[hi];
                ctx.strokeStyle = P.guide; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(hx, T); ctx.lineTo(hx, T + ih); ctx.stroke();
                ctx.lineWidth = 1.5; ctx.strokeStyle = P.markerStroke;
                ctx.beginPath(); ctx.arc(hx, Y(topV), 3.5, 0, 6.2832); ctx.fillStyle = o.createColor; ctx.fill(); ctx.stroke();
                ctx.beginPath(); ctx.arc(hx, Y(read[hi]), 3, 0, 6.2832); ctx.fillStyle = o.readColor; ctx.fill(); ctx.stroke();
            }

            // Stash geometry + series for hover interaction
            this._tipItems = items;
            this._times = times;
            this._labels = labels;
            this._geom = { L: L, iw: iw, n: n };
        },

        _onMove: function(e) {
            if (this._statusMsg) { return; }
            var g = this._geom;
            if (!g || !this._tipItems || g.iw <= 0) { return; }
            var mx = e.offsetX;
            var idx = (g.n <= 1) ? 0 : Math.round((mx - g.L) / g.iw * (g.n - 1));
            if (idx < 0 || idx > g.n - 1) { this._clearHover(); return; }
            if (idx !== this._hoverIdx) { this._hoverIdx = idx; this._scheduleDraw(); this._fillTip(idx); }
            this._positionTip(e.offsetX, e.offsetY);
        },

        _clearHover: function() {
            if (this._hoverIdx !== null) { this._hoverIdx = null; this._scheduleDraw(); }
            if (this.tip) { this.tip.style.display = 'none'; }
        },

        _scheduleDraw: function() {
            var self = this;
            if (self._raf) { return; }
            self._raf = window.requestAnimationFrame(function() {
                self._raf = null;
                if (self._data && !self._statusMsg) { self._draw(); }
            });
        },

        _fillTip: function(idx) {
            var o = this._cfg, items = this._tipItems, html = '', total = 0, m;
            var hd = (this._labels && this._labels[idx]) ? this._labels[idx] : fmtHour(this._times[idx]);
            html += '<div class="cu-tip-hd">' + esc(hd) + '</div>';
            for (m = 0; m < items.length; m++) {
                var v = items[m].vals[idx] || 0;
                total += v;
                html += '<div class="cu-tip-row"><span class="cu-tip-dot" style="background:' + esc(items[m].c) + '"></span>' +
                    '<span class="cu-tip-k">' + esc(items[m].k) + '</span>' +
                    '<span class="cu-tip-v">' + esc(fmtAxis(v, o.valueDivisor, o.valueUnit)) + '</span></div>';
            }
            html += '<div class="cu-tip-row cu-tip-total"><span class="cu-tip-dot" style="visibility:hidden"></span>' +
                '<span class="cu-tip-k">total</span>' +
                '<span class="cu-tip-v">' + esc(fmtAxis(total, o.valueDivisor, o.valueUnit)) + '</span></div>';
            this.tip.innerHTML = html;
            this.tip.style.display = 'block';
        },

        _positionTip: function(mx, my) {
            var c = this.container, cw = c.clientWidth, ch = c.clientHeight;
            var tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
            var x = mx + 14, y = my + 14;
            if (x + tw > cw - 4) { x = mx - tw - 14; }
            if (x < 4) { x = 4; }
            if (y + th > ch - 4) { y = ch - th - 4; }
            if (y < 4) { y = 4; }
            this.tip.style.left = x + 'px';
            this.tip.style.top = y + 'px';
        },

        _tick: function(t) {
            var d = parseTime(t);
            return d ? DOW[d.getDay()] : '';
        },

        _legend: function(ctx, w, h, items) {
            ctx.font = '10px ' + MONO; ctx.textBaseline = 'middle';
            var sw = 9, pad = 6, gap = 14, total = 0, i;
            for (i = 0; i < items.length; i++) {
                total += sw + pad + ctx.measureText(items[i].k).width + (i < items.length - 1 ? gap : 0);
            }
            var x = (w - total) / 2, y = h - 11;
            for (i = 0; i < items.length; i++) {
                ctx.fillStyle = items[i].c; ctx.fillRect(x, y - sw / 2, sw, sw); x += sw + pad;
                ctx.fillStyle = (this._isLight ? THEME.light : THEME.dark).secondary; ctx.textAlign = 'left'; ctx.fillText(items[i].k, x, y);
                x += ctx.measureText(items[i].k).width + gap;
            }
        },

        _drawStatus: function() {
            var rect = this.el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) { return; }
            var dpr = window.devicePixelRatio || 1;
            this.canvas.width = rect.width * dpr; this.canvas.height = rect.height * dpr;
            var ctx = this.canvas.getContext('2d'); if (!ctx) { return; }
            ctx.scale(dpr, dpr);
            var w = rect.width, h = rect.height;
            ctx.clearRect(0, 0, w, h);
            var fs = Math.max(10, Math.min(20, Math.min(w, h) * 0.08));
            ctx.font = fs + 'px ' + MONO; ctx.fillStyle = (this._isLight ? THEME.light : THEME.dark).statusText;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText('⏳ ' + (this._statusMsg || 'Awaiting data'), w / 2, h / 2);
            ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
        },

        reflow: function() {
            if (this._statusMsg) { this._drawStatus(); }
            else if (this._data) { this._draw(); }
        },

        destroy: function() {
            SplunkVisualizationBase.prototype.destroy.apply(this, arguments);
        }
    });
});
