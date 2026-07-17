/*
 * Agentic Usage — Live Session Ticker (Canvas custom visualization)
 *
 * Broadcast-style horizontal scrolling strip of the most recent Claude
 * session activity. Each entry renders as a colour-coded [KIND] token,
 * the event text, and a dim time-ago suffix, separated by accent dots.
 * A pulsing LIVE badge sits next to the title on the left.
 *
 * Expected SPL columns (multi-row): _time, kind (PROMPT/ERROR/COMPACT/START),
 * text. Field names for kind/text are configurable.
 */
define([
    'api/SplunkVisualizationBase',
    'api/SplunkVisualizationUtils'
], function(SplunkVisualizationBase, SplunkVisualizationUtils) {

    // Canvas can't read CSS custom properties — keep both theme palettes here,
    // matching the .agentic-usage design tokens used by the DOM vizs.
    var PALETTES = {
        dark:  { bg: '#14181f', line: 'rgba(255,255,255,.10)', txt: '#e9eef4', low: '#5d6773' },
        light: { bg: '#ffffff', line: 'rgba(15,23,32,.12)',   txt: '#1a1d24', low: '#8a95a3' }
    };
    var KIND_COLORS = {
        PROMPT: '#28b6a4', ERROR: '#f2643d', FAILED: '#f2643d',
        COMPACT: '#e6b24a', MODE: '#e6b24a', START: '#3aa6c2', AGENT: '#3aa6c2'
    };
    var MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace';

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
    function kindColor(kind, fallback) {
        var k = (kind === undefined || kind === null) ? '' : String(kind).toUpperCase().replace(/^\s+|\s+$/g, '');
        return KIND_COLORS[k] || fallback;
    }
    function hexToRgba(hex, alpha) {
        if (!hex || hex === 'transparent') { return 'rgba(0,0,0,0)'; }
        hex = hex.replace('#', '');
        if (hex.length === 3) { hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]; }
        var r = parseInt(hex.slice(0, 2), 16);
        var g = parseInt(hex.slice(2, 4), 16);
        var b = parseInt(hex.slice(4, 6), 16);
        return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
    }
    function formatTimeAgo(epochSeconds) {
        if (!epochSeconds || isNaN(epochSeconds)) { return ''; }
        var now = Date.now() / 1000;
        var diff = Math.max(0, Math.floor(now - epochSeconds));
        if (diff < 60) { return diff + 's ago'; }
        if (diff < 3600) { return Math.floor(diff / 60) + 'm ago'; }
        if (diff < 86400) { return Math.floor(diff / 3600) + 'h ago'; }
        return Math.floor(diff / 86400) + 'd ago';
    }
    function roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.arcTo(x + w, y, x + w, y + r, r);
        ctx.lineTo(x + w, y + h - r);
        ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
        ctx.lineTo(x + r, y + h);
        ctx.arcTo(x, y + h, x, y + h - r, r);
        ctx.lineTo(x, y + r);
        ctx.arcTo(x, y, x + r, y, r);
        ctx.closePath();
    }

    return SplunkVisualizationBase.extend({

        initialize: function() {
            SplunkVisualizationBase.prototype.initialize.apply(this, arguments);
            this.el.classList.add('cu-ticker-viz');

            this.canvas = document.createElement('canvas');
            this.canvas.style.width = '100%';
            this.canvas.style.height = '100%';
            this.canvas.style.display = 'block';
            this.el.appendChild(this.canvas);

            this._lastGoodData = null;
            this._scrollOffset = 0;
            this._lastFrame = 0;
            this._animating = false;
            this._pulsePhase = 0;

            // Webfont metrics differ from the fallback font; re-measure once
            // JetBrains Mono has loaded so segment widths don't overlap.
            var self = this;
            if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
                document.fonts.ready.then(function() { self.invalidateUpdateView(); });
            }
        },

        getInitialDataParams: function() {
            return {
                outputMode: SplunkVisualizationBase.ROW_MAJOR_OUTPUT_MODE,
                count: 100
            };
        },

        formatData: function(data) {
            if (!data || !data.rows || data.rows.length === 0) {
                if (this._lastGoodData) { return this._lastGoodData; }
                throw new SplunkVisualizationBase.VisualizationError('Awaiting data — Ticker');
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
            function cfg(k, d) { var v = config[ns + k]; return (v === undefined || v === null || v === '') ? d : v; }

            var isLight = cuIsLight(cfg('theme', 'dark'));
            var pal = isLight ? PALETTES.light : PALETTES.dark;

            if (data && data._status) {
                this._stopAnim();
                this._ensureCanvas();
                this._drawStatusMessage(data._status, pal);
                return;
            }
            if (!data) {
                if (this._lastGoodData) { data = this._lastGoodData; } else { return; }
            }

            var o = {
                title: cfg('title', 'SESSIONS'),
                kindField: cfg('kindField', 'kind'),
                textField: cfg('textField', 'text'),
                scrollSpeed: cfg('scrollSpeed', 'medium'),
                maxItems: parseInt(cfg('maxItems', '30'), 10) || 30,
                accent: cfg('accentColor', '#28b6a4'),
                live: cfg('liveColor', '#f2643d')
            };
            var speedMap = { slow: 30, medium: 60, fast: 100 };
            var pxPerSec = speedMap[o.scrollSpeed] || 60;

            var ci = data.colIdx, rows = data.rows;
            var entries = [], i;
            for (i = 0; i < rows.length; i++) {
                var r = rows[i];
                var text = (ci[o.textField] !== undefined) ? r[ci[o.textField]] : undefined;
                if (text === undefined || text === null || text === '') { continue; }
                var kind = (ci[o.kindField] !== undefined) ? r[ci[o.kindField]] : '';
                var t = (ci._time !== undefined) ? (parseFloat(r[ci._time]) || 0) : 0;
                entries.push({ kind: String(kind || '').toUpperCase(), text: String(text), time: t });
            }
            entries.sort(function(a, b) { return b.time - a.time; });
            if (entries.length > o.maxItems) { entries = entries.slice(0, o.maxItems); }

            var rect = this.el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) { return; }
            var dpr = window.devicePixelRatio || 1;
            this.canvas.width = rect.width * dpr;
            this.canvas.height = rect.height * dpr;
            var ctx = this.canvas.getContext('2d');
            if (!ctx) { return; }

            this._renderState = {
                w: rect.width, h: rect.height, dpr: dpr,
                title: o.title, accent: o.accent, live: o.live,
                pal: pal, entries: entries, pxPerSec: pxPerSec
            };

            if (entries.length === 0) {
                this._stopAnim();
                this._drawStatusMessage('No recent activity', pal);
                return;
            }
            if (!this._animating) {
                this._animating = true;
                this._lastFrame = performance.now();
                this._startAnimLoop();
            }
            this._drawFrame(performance.now());
        },

        _startAnimLoop: function() {
            var self = this;
            function loop(ts) {
                if (!self._animating) { return; }
                self._drawFrame(ts);
                self._rafId = requestAnimationFrame(loop);
            }
            self._rafId = requestAnimationFrame(loop);
        },

        _stopAnim: function() {
            this._animating = false;
            if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
        },

        _drawFrame: function(timestamp) {
            var s = this._renderState;
            if (!s) { return; }

            var dt = Math.min(0.1, (timestamp - this._lastFrame) / 1000);
            this._lastFrame = timestamp;
            this._scrollOffset += s.pxPerSec * dt;
            this._pulsePhase += dt * 2.5;

            var ctx = this.canvas.getContext('2d');
            if (!ctx) { return; }
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.scale(s.dpr, s.dpr);

            var w = s.w, h = s.h, pal = s.pal;
            var cy = h / 2;

            // ── Panel ──
            ctx.clearRect(0, 0, w, h);
            roundRect(ctx, 0.5, 0.5, w - 1, h - 1, 8);
            ctx.fillStyle = pal.bg;
            ctx.fill();
            ctx.strokeStyle = pal.line;
            ctx.lineWidth = 1;
            ctx.stroke();

            var fontSize = Math.max(10, Math.min(13, h * 0.23));
            var padX = 14;

            // ── Title + LIVE badge ──
            ctx.font = '700 ' + (fontSize + 1) + 'px ' + MONO;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = s.accent;
            var titleW = ctx.measureText(s.title).width;
            ctx.fillText(s.title, padX, cy);

            var badgeFont = Math.max(8, fontSize - 3);
            ctx.font = '700 ' + badgeFont + 'px ' + MONO;
            var badgeTextW = ctx.measureText('LIVE').width;
            var badgeW = badgeTextW + badgeFont;
            var badgeH = badgeFont + badgeFont * 0.7;
            var badgeX = padX + titleW + 9;
            var badgeY = cy - badgeH / 2;
            var pulseAlpha = 0.65 + 0.35 * Math.sin(this._pulsePhase * Math.PI);
            ctx.globalAlpha = pulseAlpha;
            ctx.fillStyle = s.live;
            roundRect(ctx, badgeX, badgeY, badgeW, badgeH, badgeH / 2);
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.fillText('LIVE', badgeX + badgeW / 2, cy + badgeFont * 0.05);
            ctx.textAlign = 'left';

            // ── Separator ──
            var sepX = badgeX + badgeW + padX;
            ctx.beginPath();
            ctx.moveTo(sepX, h * 0.22);
            ctx.lineTo(sepX, h * 0.78);
            ctx.strokeStyle = pal.line;
            ctx.stroke();

            // ── Scrolling area ──
            var tickerX = sepX + padX;
            var tickerW = w - tickerX - 8;
            if (tickerW <= 0) { return; }

            ctx.save();
            ctx.beginPath();
            ctx.rect(tickerX, 2, tickerW, h - 4);
            ctx.clip();

            var kindFont = '700 ' + fontSize + 'px ' + MONO;
            var textFont = '500 ' + fontSize + 'px ' + MONO;
            var agoFont = '400 ' + (fontSize - 1) + 'px ' + MONO;
            var segGap = 7;
            var dotSep = '●';
            ctx.font = textFont;
            var dotW = ctx.measureText(dotSep).width + segGap * 3;

            // Measure entries (per frame, like live_ticker — cheap for ≤30 entries).
            var entries = s.entries, widths = [], totalW = 0, i;
            for (i = 0; i < entries.length; i++) {
                var e = entries[i];
                var kindTok = e.kind ? '[' + e.kind + ']' : '';
                ctx.font = kindFont;
                var wKind = kindTok ? ctx.measureText(kindTok).width + segGap : 0;
                ctx.font = textFont;
                var wText = ctx.measureText(e.text).width;
                var ago = formatTimeAgo(e.time);
                ctx.font = agoFont;
                var wAgo = ago ? segGap + ctx.measureText(ago).width : 0;
                var ew = wKind + wText + wAgo;
                widths.push({ kindTok: kindTok, wKind: wKind, wText: wText, ago: ago, total: ew });
                totalW += ew + dotW;
            }
            if (totalW > 0) { this._scrollOffset = this._scrollOffset % totalW; }

            for (var pass = 0; pass < 2; pass++) {
                var drawX = tickerX + tickerW - this._scrollOffset + pass * totalW;
                for (i = 0; i < entries.length; i++) {
                    var en = entries[i], m = widths[i];
                    if (drawX > tickerX + tickerW + 60) { drawX += m.total + dotW; continue; }
                    if (drawX + m.total + dotW < tickerX - 60) { drawX += m.total + dotW; continue; }

                    if (m.kindTok) {
                        ctx.font = kindFont;
                        ctx.fillStyle = kindColor(en.kind, pal.txt);
                        ctx.fillText(m.kindTok, drawX, cy);
                    }
                    ctx.font = textFont;
                    ctx.fillStyle = pal.txt;
                    ctx.fillText(en.text, drawX + m.wKind, cy);
                    if (m.ago) {
                        ctx.font = agoFont;
                        ctx.fillStyle = pal.low;
                        ctx.fillText(m.ago, drawX + m.wKind + m.wText + segGap, cy);
                    }
                    drawX += m.total;

                    ctx.font = textFont;
                    ctx.fillStyle = hexToRgba(s.accent, 0.7);
                    ctx.fillText(dotSep, drawX + segGap * 1.5, cy);
                    drawX += dotW;
                }
            }
            ctx.restore();

            // ── Edge fades over the scroll area ──
            var fadeW = Math.min(36, tickerW * 0.1);
            var gradL = ctx.createLinearGradient(tickerX, 0, tickerX + fadeW, 0);
            gradL.addColorStop(0, pal.bg);
            gradL.addColorStop(1, hexToRgba(pal.bg, 0));
            ctx.fillStyle = gradL;
            ctx.fillRect(tickerX, 2, fadeW, h - 4);

            var gradR = ctx.createLinearGradient(w - 8 - fadeW, 0, w - 8, 0);
            gradR.addColorStop(0, hexToRgba(pal.bg, 0));
            gradR.addColorStop(1, pal.bg);
            ctx.fillStyle = gradR;
            ctx.fillRect(w - 8 - fadeW, 2, fadeW + 6, h - 4);
        },

        _ensureCanvas: function() {
            if (!this.canvas) {
                this.el.innerHTML = '';
                this.canvas = document.createElement('canvas');
                this.canvas.style.width = '100%';
                this.canvas.style.height = '100%';
                this.canvas.style.display = 'block';
                this.el.appendChild(this.canvas);
            }
            var rect = this.el.getBoundingClientRect();
            var dpr = window.devicePixelRatio || 1;
            this.canvas.width = rect.width * dpr;
            this.canvas.height = rect.height * dpr;
        },

        _drawStatusMessage: function(message, pal) {
            pal = pal || PALETTES.dark;
            var rect = this.el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) { return; }
            var dpr = window.devicePixelRatio || 1;
            var ctx = this.canvas.getContext('2d');
            if (!ctx) { return; }
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.scale(dpr, dpr);
            var w = rect.width, h = rect.height;
            ctx.clearRect(0, 0, w, h);

            roundRect(ctx, 0.5, 0.5, w - 1, h - 1, 8);
            ctx.fillStyle = pal.bg;
            ctx.fill();
            ctx.strokeStyle = pal.line;
            ctx.lineWidth = 1;
            ctx.stroke();

            var fontSize = Math.max(10, Math.min(13, h * 0.23));
            ctx.font = '500 ' + fontSize + 'px ' + MONO;
            while (ctx.measureText(message).width > w * 0.85 && fontSize > 8) {
                fontSize -= 1;
                ctx.font = '500 ' + fontSize + 'px ' + MONO;
            }
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = pal.low;
            ctx.fillText('⏳ ' + message, w / 2, h / 2);
            ctx.textAlign = 'start';
            ctx.textBaseline = 'alphabetic';
        },

        reflow: function() {
            this.invalidateUpdateView();
        },

        destroy: function() {
            this._stopAnim();
            SplunkVisualizationBase.prototype.destroy.apply(this, arguments);
        }
    });
});
