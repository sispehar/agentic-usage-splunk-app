/*
 * Agentic Usage — Donut (Canvas 2D custom visualization)
 *
 * Donut ring + legend + center readout, with a hand-drawn hover tooltip and
 * segment highlight (hover a ring slice or a legend row). Pure Canvas 2D, ES5.
 *
 * Expected SPL columns (configurable): a label column (default "model") and a
 * numeric value column (default "value"). Percentages are computed from the
 * value total — e.g. `| stats sum(tokens) AS value BY model`.
 */
define([
    'api/SplunkVisualizationBase',
    'api/SplunkVisualizationUtils'
], function(SplunkVisualizationBase, SplunkVisualizationUtils) {

    var MONO = "'JetBrains Mono', ui-monospace, monospace";
    var SANS = "'IBM Plex Sans', -apple-system, sans-serif";
    var TAU = Math.PI * 2;

    function num(v) { var f = parseFloat(v); return isNaN(f) ? 0 : f; }
    function groupNum(n) {
        var s = String(n), neg = s.charAt(0) === '-';
        if (neg) { s = s.slice(1); }
        var p = s.split('.'), intPart = p[0], dec = p.length > 1 ? '.' + p[1] : '', out = '', c = 0, k;
        for (k = intPart.length - 1; k >= 0; k--) { out = intPart.charAt(k) + out; if ((++c % 3) === 0 && k > 0) { out = ',' + out; } }
        return (neg ? '-' : '') + out + dec;
    }
    function roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
        ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
        ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
        ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r); ctx.closePath();
    }
    // Theme palette for canvas-drawn neutrals (segment/data colours are kept).
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
            this.container.className = 'cu-donut-root';
            this.canvas = document.createElement('canvas');
            this.container.appendChild(this.canvas);
            this.el.appendChild(this.container);
            this._lastGoodData = null;
            this._segs = null;
            this._cfg = null;
            this._geom = null;
            this._hover = null;
            this._mouse = null;
            this._statusMsg = null;

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
                throw new SplunkVisualizationBase.VisualizationError('Awaiting data — Donut');
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
            if (data && data._status) { this._statusMsg = data._status; this._segs = null; this._drawStatus(); return; }
            if (!data) { if (this._lastGoodData) { data = this._lastGoodData; } else { return; } }
            this._statusMsg = null;
            function cfg(k, d) { var v = config[ns + k]; return (v === undefined || v === null || v === '') ? d : v; }

            this._cfg = {
                title: cfg('title', 'AI Models Used'),
                sublabel: cfg('sublabel', 'token share'),
                labelField: cfg('labelField', 'model'),
                valueField: cfg('valueField', 'value'),
                valueDivisor: parseFloat(cfg('valueDivisor', '1')) || 1,
                valueUnit: cfg('valueUnit', ''),
                colors: cfg('colors', '#f2643d,#28b6a4,#e6b24a,#3aa6c2,#52b487,#b9c4d0').split(',')
            };

            var ci = data.colIdx, rows = data.rows, segs = [], total = 0, i;
            for (i = 0; i < rows.length; i++) {
                var lbl = ci[this._cfg.labelField] !== undefined ? rows[i][ci[this._cfg.labelField]] : '';
                if (lbl === null || lbl === undefined || lbl === '') { continue; }
                var v = ci[this._cfg.valueField] !== undefined ? num(rows[i][ci[this._cfg.valueField]]) : 0;
                segs.push({ label: lbl, value: v, color: this._cfg.colors[segs.length % this._cfg.colors.length].replace(/^\s+|\s+$/g, '') });
                total += v;
            }
            if (total <= 0) { total = 1; }
            for (i = 0; i < segs.length; i++) { segs[i].pct = segs[i].value / total * 100; }
            this._segs = segs;
            this._total = total;
            this._draw();
        },

        _onMove: function(e) {
            if (!this._geom || !this._segs) { return; }
            var mx = e.offsetX, my = e.offsetY;
            this._mouse = { x: mx, y: my };
            var g = this._geom, hit = null, i;
            // ring hit-test
            var dx = mx - g.cx, dy = my - g.cy, dist = Math.sqrt(dx * dx + dy * dy);
            if (dist >= g.r - g.stroke / 2 - 3 && dist <= g.r + g.stroke / 2 + 3) {
                var aTop = Math.atan2(dy, dx) + Math.PI / 2;
                while (aTop < 0) { aTop += TAU; }
                while (aTop >= TAU) { aTop -= TAU; }
                var frac = aTop / TAU, acc = 0;
                for (i = 0; i < this._segs.length; i++) {
                    var f = this._segs[i].pct / 100;
                    if (frac >= acc && frac < acc + f) { hit = i; break; }
                    acc += f;
                }
            }
            // legend hit-test
            if (hit === null && g.legend) {
                for (i = 0; i < g.legend.length; i++) {
                    var lr = g.legend[i];
                    if (mx >= lr.x0 && mx <= lr.x1 && my >= lr.y0 && my <= lr.y1) { hit = i; break; }
                }
            }
            if (hit !== this._hover || true) { this._hover = hit; this._draw(); }
        },

        _draw: function() {
            var segs = this._segs, o = this._cfg;
            if (!segs || !o) { return; }
            var rect = this.el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) { return; }
            var dpr = window.devicePixelRatio || 1;
            this.canvas.width = rect.width * dpr; this.canvas.height = rect.height * dpr;
            var ctx = this.canvas.getContext('2d'); if (!ctx) { return; }
            ctx.scale(dpr, dpr);
            var w = rect.width, h = rect.height; ctx.clearRect(0, 0, w, h);
            var P = this._isLight ? THEME.light : THEME.dark;

            var pad = 16, titleH = o.title ? 24 : 4;

            // header
            if (o.title) {
                ctx.font = '600 14px ' + SANS; ctx.fillStyle = P.text;
                ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
                ctx.fillText(o.title, pad, pad + 12);
            }
            if (o.sublabel) {
                ctx.font = '11px ' + MONO; ctx.fillStyle = P.muted;
                ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
                ctx.fillText(o.sublabel.toUpperCase(), w - pad, pad + 12);
            }

            var plotTop = pad + titleH, plotH = h - plotTop - pad;
            var stroke = Math.max(12, Math.min(18, plotH * 0.09));
            var donutZoneW = Math.min(w * 0.46, plotH + stroke);
            var r = Math.max(28, Math.min(donutZoneW, plotH) / 2 - stroke / 2 - 4);
            var cx = pad + Math.max(r + stroke / 2, donutZoneW / 2);
            var cy = plotTop + plotH / 2;

            // track
            ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.strokeStyle = P.track; ctx.lineWidth = stroke; ctx.stroke();

            // segments
            var start = -Math.PI / 2, acc = 0, i, segArcs = [];
            for (i = 0; i < segs.length; i++) {
                var f = segs[i].pct / 100;
                var a0 = start + acc * TAU, a1 = start + (acc + f) * TAU;
                segArcs.push({ a0: a0, a1: a1 });
                var on = this._hover === i, dim = this._hover !== null && !on;
                ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1);
                ctx.strokeStyle = segs[i].color; ctx.lineWidth = on ? stroke + 3 : stroke;
                ctx.globalAlpha = dim ? 0.3 : 1;
                if (on) { ctx.shadowColor = segs[i].color; ctx.shadowBlur = 8; }
                ctx.stroke();
                ctx.shadowBlur = 0; ctx.globalAlpha = 1;
                acc += f;
            }

            // center readout
            var center = (this._hover !== null) ? segs[this._hover] : segs[0];
            ctx.textAlign = 'center';
            ctx.fillStyle = (this._hover !== null) ? center.color : P.readout;
            ctx.font = '600 ' + Math.round(r * 0.42) + 'px ' + MONO; ctx.textBaseline = 'alphabetic';
            ctx.fillText(Math.round(center.pct) + '%', cx, cy + r * 0.06);
            ctx.fillStyle = P.muted; ctx.font = '10px ' + MONO; ctx.textBaseline = 'top';
            ctx.fillText(String(center.label).toUpperCase(), cx, cy + r * 0.16);

            // legend (right of donut)
            var lx0 = cx + r + stroke / 2 + 22, lx1 = w - pad;
            var rowH = Math.min(30, plotH / Math.max(segs.length, 1));
            var startY = cy - (segs.length * rowH) / 2;
            var legend = [];
            ctx.textBaseline = 'middle';
            for (i = 0; i < segs.length; i++) {
                var ry = startY + i * rowH + rowH / 2;
                var dimL = this._hover !== null && this._hover !== i;
                ctx.globalAlpha = dimL ? 0.4 : 1;
                ctx.fillStyle = segs[i].color;
                roundRect(ctx, lx0, ry - 5, 10, 10, 3); ctx.fill();
                ctx.fillStyle = P.text; ctx.font = '13px ' + SANS; ctx.textAlign = 'left';
                ctx.fillText(String(segs[i].label), lx0 + 18, ry);
                ctx.fillStyle = P.secondary; ctx.font = '13px ' + MONO; ctx.textAlign = 'right';
                ctx.fillText(Math.round(segs[i].pct) + '%', lx1, ry);
                ctx.globalAlpha = 1;
                legend.push({ x0: lx0, x1: lx1, y0: ry - rowH / 2, y1: ry + rowH / 2 });
            }

            this._geom = { cx: cx, cy: cy, r: r, stroke: stroke, segArcs: segArcs, legend: legend };

            // tooltip
            if (this._hover !== null && this._mouse) { this._tooltip(ctx, w, h, segs[this._hover]); }

            ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
        },

        _tooltip: function(ctx, w, h, seg) {
            var P = this._isLight ? THEME.light : THEME.dark;
            var valStr = groupNum(seg.value / this._cfg.valueDivisor) + (this._cfg.valueUnit || '');
            var l1 = String(seg.label), l2 = valStr, l3 = Math.round(seg.pct) + '% of total';
            ctx.font = '600 12.5px ' + SANS;
            var tw = ctx.measureText(l1).width + 18;
            ctx.font = '600 17px ' + MONO; tw = Math.max(tw, ctx.measureText(l2).width);
            ctx.font = '10.5px ' + MONO; tw = Math.max(tw, ctx.measureText(l3).width);
            var bw = tw + 22, bh = 58;
            var x = this._mouse.x + 14, y = this._mouse.y + 14;
            if (x + bw > w - 4) { x = this._mouse.x - bw - 14; }
            if (y + bh > h - 4) { y = h - bh - 4; }
            if (x < 4) { x = 4; }
            if (y < 4) { y = 4; }
            ctx.save();
            ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 20; ctx.shadowOffsetY = 8;
            roundRect(ctx, x, y, bw, bh, 8); ctx.fillStyle = P.tipBg; ctx.fill();
            ctx.restore();
            roundRect(ctx, x, y, bw, bh, 8); ctx.strokeStyle = P.tipBorder; ctx.lineWidth = 1; ctx.stroke();
            ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
            ctx.fillStyle = seg.color; roundRect(ctx, x + 11, y + 12, 9, 9, 2); ctx.fill();
            ctx.fillStyle = P.readout; ctx.font = '600 12.5px ' + SANS; ctx.fillText(l1, x + 26, y + 21);
            ctx.fillStyle = P.readout; ctx.font = '600 17px ' + MONO; ctx.fillText(l2, x + 11, y + 41);
            ctx.fillStyle = P.muted; ctx.font = '10.5px ' + MONO; ctx.fillText(l3, x + 11, y + 53);
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
            else if (this._segs) { this._draw(); }
        },

        destroy: function() {
            SplunkVisualizationBase.prototype.destroy.apply(this, arguments);
        }
    });
});
