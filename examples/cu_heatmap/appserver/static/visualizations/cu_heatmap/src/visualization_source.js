/*
 * Agentic Usage — Activity Heatmap (Canvas 2D custom visualization)
 *
 * Day × hour grid coloured by intensity (teal → coral for the hottest cells),
 * with a peak callout, a more/less legend and a hover tooltip. Pure Canvas 2D.
 *
 * Expected SPL columns (configurable, long format): a day column (default "d"),
 * an hour column 0–23 (default "h") and a value column (default "v") —
 * e.g. `| eval d=strftime(_time,"%a"), h=strftime(_time,"%H")
 *       | stats sum(tokens) AS v BY d h`.
 */
define([
    'api/SplunkVisualizationBase',
    'api/SplunkVisualizationUtils'
], function(SplunkVisualizationBase, SplunkVisualizationUtils) {

    var MONO = "'JetBrains Mono', ui-monospace, monospace";
    var SANS = "'IBM Plex Sans', -apple-system, sans-serif";

    function num(v) { var f = parseFloat(v); return isNaN(f) ? 0 : f; }
    function groupNum(n) {
        var s = String(n), neg = s.charAt(0) === '-';
        if (neg) { s = s.slice(1); }
        var p = s.split('.'), intPart = p[0], dec = p.length > 1 ? '.' + p[1] : '', out = '', c = 0, k;
        for (k = intPart.length - 1; k >= 0; k--) { out = intPart.charAt(k) + out; if ((++c % 3) === 0 && k > 0) { out = ',' + out; } }
        return (neg ? '-' : '') + out + dec;
    }
    function hexToRgba(hex, a) {
        if (typeof hex !== 'string' || hex.charAt(0) !== '#') { return hex; }
        return 'rgba(' + parseInt(hex.slice(1, 3), 16) + ',' + parseInt(hex.slice(3, 5), 16) + ',' + parseInt(hex.slice(5, 7), 16) + ',' + a + ')';
    }
    function roundRect(ctx, x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2); if (r < 0) { r = 0; }
        ctx.beginPath();
        ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
        ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
        ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
        ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r); ctx.closePath();
    }
    // Theme palette for canvas-drawn neutrals (cell low/high colours are kept).
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
            this.container.className = 'cu-hm-root';
            this.canvas = document.createElement('canvas');
            this.container.appendChild(this.canvas);
            this.el.appendChild(this.container);
            this._lastGoodData = null;
            this._model = null; this._cfg = null; this._geom = null;
            this._hover = null; this._mouse = null; this._statusMsg = null;

            var self = this;
            this.canvas.addEventListener('mousemove', function(e) { self._onMove(e); });
            this.canvas.addEventListener('mouseleave', function() { self._hover = null; self._mouse = null; self._draw(); });
        },

        getInitialDataParams: function() {
            return { outputMode: SplunkVisualizationBase.ROW_MAJOR_OUTPUT_MODE, count: 10000 };
        },

        formatData: function(data) {
            if (!data || !data.rows || data.rows.length === 0) {
                if (this._lastGoodData) { return this._lastGoodData; }
                throw new SplunkVisualizationBase.VisualizationError('Awaiting data — Heatmap');
            }
            var fields = data.fields, colIdx = {}, i;
            for (i = 0; i < fields.length; i++) { colIdx[fields[i].name] = i; }
            if (colIdx._status !== undefined) {
                var sRow = data.rows[data.rows.length - 1];
                if (sRow[colIdx._status]) { return { _status: sRow[colIdx._status] }; }
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
            if (data && data._status) { this._statusMsg = data._status; this._model = null; this._drawStatus(); return; }
            if (!data) { if (this._lastGoodData) { data = this._lastGoodData; } else { return; } }
            this._statusMsg = null;
            function cfg(k, d) { var v = config[ns + k]; return (v === undefined || v === null || v === '') ? d : v; }
            this._cfg = {
                title: cfg('title', 'Activity Heatmap'),
                subtitle: cfg('subtitle', 'tokens by date & hour'),
                dayField: cfg('dayField', 'd'),
                hourField: cfg('hourField', 'h'),
                valueField: cfg('valueField', 'v'),
                lowColor: cfg('lowColor', '#28b6a4'),
                highColor: cfg('highColor', '#f2643d'),
                valueDivisor: parseFloat(cfg('valueDivisor', '1')) || 1,
                valueUnit: cfg('valueUnit', ''),
                valueNoun: cfg('valueNoun', 'tokens')
            };

            var ci = data.colIdx, rows = data.rows, o = this._cfg, i;
            var dayList = [], dayIdx = {}, cells = {}, maxV = 0, peak = { di: 0, h: 0, v: -1 };
            for (i = 0; i < rows.length; i++) {
                var d = ci[o.dayField] !== undefined ? rows[i][ci[o.dayField]] : '';
                var hh = ci[o.hourField] !== undefined ? parseInt(rows[i][ci[o.hourField]], 10) : NaN;
                var v = ci[o.valueField] !== undefined ? num(rows[i][ci[o.valueField]]) : 0;
                if (d === '' || d === null || d === undefined || isNaN(hh)) { continue; }
                if (dayIdx[d] === undefined) { dayIdx[d] = dayList.length; dayList.push(d); }
                var di = dayIdx[d];
                cells[di + '_' + hh] = v;
                if (v > maxV) { maxV = v; }
                if (v > peak.v) { peak = { di: di, h: hh, v: v }; }
            }
            if (maxV <= 0) { maxV = 1; }
            this._model = { dayList: dayList, cells: cells, maxV: maxV, peak: peak };
            this._draw();
        },

        _colorFor: function(v) {
            var o = this._cfg, t = v / this._model.maxV;
            if (t > 0.82) { return hexToRgba(o.highColor, 0.5 + (t - 0.82) / 0.18 * 0.5); }
            return hexToRgba(o.lowColor, 0.05 + t * 0.85);
        },
        _fmt: function(v) { var o = this._cfg, x = v / o.valueDivisor; var s = (x >= 100 || x === Math.round(x)) ? String(Math.round(x)) : x.toFixed(1); return groupNum(s) + (o.valueUnit || ''); },

        _draw: function() {
            var m = this._model, o = this._cfg;
            if (!m || !o) { return; }
            var rect = this.el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) { return; }
            var dpr = window.devicePixelRatio || 1;
            this.canvas.width = rect.width * dpr; this.canvas.height = rect.height * dpr;
            var ctx = this.canvas.getContext('2d'); if (!ctx) { return; }
            ctx.scale(dpr, dpr);
            var w = rect.width, h = rect.height; ctx.clearRect(0, 0, w, h);
            var P = this._isLight ? THEME.light : THEME.dark;

            var pad = 16, cols = 24, rows = m.dayList.length || 1, gap = 3, i, col;

            // header
            ctx.textBaseline = 'alphabetic';
            ctx.font = '600 15px ' + SANS; ctx.fillStyle = P.text; ctx.textAlign = 'left';
            var tx = pad; ctx.fillText(o.title, tx, pad + 12);
            if (o.subtitle) {
                var titW = ctx.measureText(o.title).width;
                ctx.font = '13px ' + SANS; ctx.fillStyle = P.muted;
                ctx.fillText(' · ' + o.subtitle, tx + titW + 2, pad + 12);
            }
            // peak (right)
            ctx.font = '11px ' + MONO; ctx.fillStyle = P.muted; ctx.textAlign = 'right';
            var pk = m.peak;
            if (pk.v >= 0) {
                var pkLab = 'peak ' + m.dayList[pk.di] + ' ' + (pk.h < 10 ? '0' + pk.h : pk.h) + ':00 · ' + this._fmt(pk.v);
                ctx.fillText(pkLab, w - pad, pad + 12);
            }

            var dayLabelW = 40, legendW = 30, bottomH = 16;
            var gridX = pad + dayLabelW, gridY = pad + 28;
            var gridRight = w - pad - legendW, gridBottom = h - pad - bottomH;
            var gridW = gridRight - gridX, gridH = gridBottom - gridY;
            if (gridW < 24 || gridH < 14) { return; }
            var cellW = (gridW - (cols - 1) * gap) / cols;
            var cellH = (gridH - (rows - 1) * gap) / rows;
            if (cellW < 1) { cellW = 1; } if (cellH < 1) { cellH = 1; }
            var cellR = Math.min(3, cellW * 0.25, cellH * 0.25);

            // day labels + cells
            ctx.textBaseline = 'middle';
            for (i = 0; i < rows; i++) {
                var cy = gridY + i * (cellH + gap);
                ctx.font = '500 9.5px ' + MONO; ctx.fillStyle = P.muted; ctx.textAlign = 'right';
                ctx.fillText(String(m.dayList[i]).split(' ')[0].toUpperCase(), gridX - 8, cy + cellH / 2);
                for (col = 0; col < cols; col++) {
                    var cx = gridX + col * (cellW + gap);
                    var v = m.cells[i + '_' + col]; if (v === undefined) { v = 0; }
                    roundRect(ctx, cx, cy, cellW, cellH, cellR); ctx.fillStyle = this._colorFor(v); ctx.fill();
                    var on = this._hover && this._hover.di === i && this._hover.h === col;
                    if (on) { roundRect(ctx, cx, cy, cellW, cellH, cellR); ctx.strokeStyle = P.readout; ctx.lineWidth = 1.5; ctx.stroke(); }
                }
            }

            // hour labels (every 3h)
            ctx.font = '8.5px ' + MONO; ctx.fillStyle = P.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
            for (col = 0; col < cols; col += 3) {
                var hx = gridX + col * (cellW + gap) + cellW / 2;
                ctx.fillText(col < 10 ? '0' + col : String(col), hx, gridBottom + 4);
            }

            // more/less legend (right)
            var lx = w - pad - 12;
            ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
            ctx.font = '8.5px ' + MONO; ctx.fillStyle = P.muted;
            var stops = [1, 0.85, 0.6, 0.35, 0.12], sH = 9, sGap = 2;
            var stackH = stops.length * (sH + sGap);
            var ly = gridY + (gridH - stackH) / 2;
            ctx.fillText('more', lx + 6, ly - 4);
            for (i = 0; i < stops.length; i++) {
                roundRect(ctx, lx, ly + i * (sH + sGap), 12, sH, 2);
                ctx.fillStyle = this._colorFor(stops[i] * m.maxV); ctx.fill();
            }
            ctx.fillStyle = P.muted;
            ctx.fillText('less', lx + 6, ly + stackH + 9);

            this._geom = { gridX: gridX, gridY: gridY, cellW: cellW, cellH: cellH, gap: gap, cols: cols, rows: rows };

            if (this._hover && this._mouse) { this._tooltip(ctx, w, h); }
            ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
        },

        _onMove: function(e) {
            if (!this._geom || !this._model) { return; }
            var g = this._geom, mx = e.offsetX, my = e.offsetY;
            this._mouse = { x: mx, y: my };
            var col = Math.floor((mx - g.gridX) / (g.cellW + g.gap));
            var row = Math.floor((my - g.gridY) / (g.cellH + g.gap));
            var hit = null;
            if (col >= 0 && col < g.cols && row >= 0 && row < g.rows) {
                var cx = g.gridX + col * (g.cellW + g.gap), cy = g.gridY + row * (g.cellH + g.gap);
                if (mx <= cx + g.cellW && my <= cy + g.cellH) { hit = { di: row, h: col }; }
            }
            this._hover = hit;
            this._draw();
        },

        _tooltip: function(ctx, w, h) {
            var P = this._isLight ? THEME.light : THEME.dark;
            var m = this._model, hv = this._hover;
            var v = m.cells[hv.di + '_' + hv.h]; if (v === undefined) { v = 0; }
            var l1 = m.dayList[hv.di] + ' · ' + (hv.h < 10 ? '0' + hv.h : hv.h) + ':00';
            var l2 = this._fmt(v) + ' ' + this._cfg.valueNoun;
            ctx.font = '11px ' + MONO; var tw = ctx.measureText(l1).width;
            ctx.font = '600 16px ' + MONO; tw = Math.max(tw, ctx.measureText(l2).width);
            var bw = tw + 22, bh = 44, x = this._mouse.x + 14, y = this._mouse.y + 14;
            if (x + bw > w - 4) { x = this._mouse.x - bw - 14; }
            if (y + bh > h - 4) { y = h - bh - 4; }
            if (x < 4) { x = 4; } if (y < 4) { y = 4; }
            ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 20; ctx.shadowOffsetY = 8;
            roundRect(ctx, x, y, bw, bh, 8); ctx.fillStyle = P.tipBg; ctx.fill(); ctx.restore();
            roundRect(ctx, x, y, bw, bh, 8); ctx.strokeStyle = P.tipBorder; ctx.lineWidth = 1; ctx.stroke();
            ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
            ctx.fillStyle = P.secondary; ctx.font = '11px ' + MONO; ctx.fillText(l1, x + 11, y + 17);
            ctx.fillStyle = P.readout; ctx.font = '600 16px ' + MONO; ctx.fillText(l2, x + 11, y + 36);
        },

        _drawStatus: function() {
            var rect = this.el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) { return; }
            var dpr = window.devicePixelRatio || 1;
            this.canvas.width = rect.width * dpr; this.canvas.height = rect.height * dpr;
            var ctx = this.canvas.getContext('2d'); if (!ctx) { return; }
            ctx.scale(dpr, dpr);
            var w = rect.width, h = rect.height; ctx.clearRect(0, 0, w, h);
            var fs = Math.max(10, Math.min(18, Math.min(w, h) * 0.08));
            ctx.font = fs + 'px ' + MONO; ctx.fillStyle = (this._isLight ? THEME.light : THEME.dark).statusText;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText('⏳ ' + (this._statusMsg || 'Awaiting data'), w / 2, h / 2);
            ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
        },

        reflow: function() {
            if (this._statusMsg) { this._drawStatus(); }
            else if (this._model) { this._draw(); }
        },

        destroy: function() {
            SplunkVisualizationBase.prototype.destroy.apply(this, arguments);
        }
    });
});
