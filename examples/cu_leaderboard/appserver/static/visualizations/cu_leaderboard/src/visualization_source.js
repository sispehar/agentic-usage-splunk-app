/*
 * Agentic Usage — Team Leaderboard (DOM custom visualization)
 *
 * Top-3 podium (gold / silver / bronze, #1 elevated + glow) plus ranked rows
 * with avatar and a value bar. A top-right segmented control switches the
 * ranking metric between tokens and cost; the podium, bar and the secondary
 * column all follow the active metric. All users are shown via client-side
 * pagination (numbered pages), so the panel never needs a scrollbar.
 *
 * Expected SPL columns (configurable): User, Service, the metric column
 * (default "Tokens (M)"), Cost ($), Cache %.
 */
define([
    'api/SplunkVisualizationBase',
    'api/SplunkVisualizationUtils'
], function(SplunkVisualizationBase, SplunkVisualizationUtils) {

    var RANK_CLASS = ['gold', 'silver', 'bronze'];
    // Chrome heights (px), calibrated against the rendered CSS — used to auto-fit
    // ranked rows to the panel so the leaderboard never needs a scrollbar.
    var ROW_H = 44;       // height of one ranked row
    var ROOT_PAD = 36;    // root vertical padding (20 + 16)
    var HEAD_H = 37;      // header (title + sort switch)
    var COLHEAD_H = 26;   // column header row
    var PAGER_H = 36;     // pager strip (always reserved)
    var PODIUM_H = 296;   // top-3 podium block incl. margin

    function esc(s) {
        s = (s === undefined || s === null) ? '' : String(s);
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function initials(name) {
        name = (name || '').replace(/^\s+|\s+$/g, '');
        if (!name) { return '?'; }
        var parts = name.split(/\s+/);
        if (parts.length === 1) { return parts[0].charAt(0).toUpperCase(); }
        return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
    }
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
    function num(v) { var f = parseFloat(v); return isNaN(f) ? null : f; }
    // Theme: the dashboard passes the page-background hex (or "light"/"dark") as
    // the `theme` option; classify it so the viz can flip the data-theme attr.
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

    // Build the {start..end} window of page indices, with -1 marking a gap (…).
    function pageWindow(count, cur) {
        var s = [], i, lo, hi;
        if (count <= 7) { for (i = 0; i < count; i++) { s.push(i); } return s; }
        s.push(0);
        lo = Math.max(1, cur - 1);
        hi = Math.min(count - 2, cur + 1);
        if (lo > 1) { s.push(-1); }
        for (i = lo; i <= hi; i++) { s.push(i); }
        if (hi < count - 2) { s.push(-1); }
        s.push(count - 1);
        return s;
    }

    return SplunkVisualizationBase.extend({

        initialize: function() {
            SplunkVisualizationBase.prototype.initialize.apply(this, arguments);
            this.el.classList.add('agentic-usage');
            this.container = document.createElement('div');
            this.container.className = 'cu-lb-root';
            this.el.appendChild(this.container);
            this._lastGoodData = null;
            // Interactive state — initialized once so it survives data refreshes.
            this._sortKey = 'tokens';
            this._page = 0;
            this._list = null;
            this._o = null;
            this.container.addEventListener('click', this._onClick.bind(this));
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
                throw new SplunkVisualizationBase.VisualizationError('Awaiting data — Leaderboard');
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
            this.el.setAttribute('data-theme', cuIsLight(config[ns + 'theme']) ? 'light' : 'dark');
            if (data && data._status) { this._renderStatus(data._status); return; }
            if (!data) {
                if (this._lastGoodData) { data = this._lastGoodData; } else { return; }
            }
            function cfg(k, d) { var v = config[ns + k]; return (v === undefined || v === null || v === '') ? d : v; }

            var o = {
                title: cfg('title', 'Team Leaderboard'),
                nameField: cfg('nameField', 'User'),
                serviceField: cfg('serviceField', 'Service'),
                metricField: cfg('metricField', 'Tokens (M)'),
                metricColLabel: cfg('metricColLabel', 'Tokens (M)'),
                metricLabel: cfg('metricLabel', 'tokens'),
                metricUnit: cfg('metricUnit', 'M'),
                metricPrefix: cfg('metricPrefix', ''),
                costField: cfg('costField', 'Cost ($)'),
                cacheField: cfg('cacheField', 'Cache %'),
                showPodium: cfg('showPodium', 'true') === 'true',
                rowsPerPage: parseInt(cfg('rowsPerPage', '8'), 10) || 8
            };

            var ci = data.colIdx, rows = data.rows, list = [], i;
            for (i = 0; i < rows.length; i++) {
                var r = rows[i];
                var nm = ci[o.nameField] !== undefined ? r[ci[o.nameField]] : '';
                if (nm === null || nm === undefined || nm === '') { continue; }
                list.push({
                    name: nm,
                    svc: ci[o.serviceField] !== undefined ? r[ci[o.serviceField]] : '',
                    metric: ci[o.metricField] !== undefined ? num(r[ci[o.metricField]]) : null,
                    cost: ci[o.costField] !== undefined ? num(r[ci[o.costField]]) : null,
                    cache: ci[o.cacheField] !== undefined ? num(r[ci[o.cacheField]]) : null
                });
            }
            this._list = list;
            this._o = o;
            this._render();
        },

        // Metric descriptors for the two sortable metrics.
        _metrics: function() {
            var o = this._o;
            return {
                tokens: {
                    key: 'tokens', seg: o.metricLabel || 'tokens', short: 'Tokens',
                    colLabel: o.metricColLabel, prefix: o.metricPrefix, unit: o.metricUnit,
                    round: false, get: function(u) { return u.metric; }
                },
                cost: {
                    key: 'cost', seg: 'cost', short: 'Cost',
                    colLabel: o.costField || 'Cost ($)', prefix: '$', unit: '',
                    round: true, get: function(u) { return u.cost; }
                }
            };
        },

        // Value with optional unit suffix (used by the podium big number).
        _fmtVal: function(v, d) {
            if (v === null || v === undefined || isNaN(v)) { return '—'; }
            var n = d.round ? Math.round(v) : v;
            return esc(d.prefix) + groupNum(n) +
                (d.unit ? ('<span class="cu-unit">' + esc(d.unit) + '</span>') : '');
        },
        // Compact value (no unit) used inside the ranked rows.
        _fmtCompact: function(v, d) {
            if (v === null || v === undefined || isNaN(v)) { return '—'; }
            var n = d.round ? Math.round(v) : v;
            return esc(d.prefix) + groupNum(n);
        },

        // Rows per page: auto-fit to the panel height so the list never needs a
        // scrollbar, capped by rowsPerPage so the page size stays consistent
        // (and so an unconstrained/auto-height container still paginates).
        _fitRows: function(hasPodium) {
            var cap = this._o.rowsPerPage;
            var h = this.container.clientHeight;
            if (!h) { return cap; }
            var avail = h - ROOT_PAD - HEAD_H - COLHEAD_H - PAGER_H - (hasPodium ? PODIUM_H : 0);
            var n = Math.floor(avail / ROW_H);
            if (n < 1) { n = 1; }
            return n < cap ? n : cap;
        },

        _podium: function(u, rank, active, other) {
            if (!u) { return ''; }
            var c = RANK_CLASS[rank];
            var first = rank === 0;
            return '<div class="cu-podium ' + c + (first ? ' first' : '') + '">' +
                '<div class="cu-podium-rank">#' + (rank + 1) + '</div>' +
                '<div class="cu-podium-av-wrap"><span class="cu-av ' + c + (first ? ' big' : '') + '">' + esc(initials(u.name)) + '</span></div>' +
                '<div class="cu-podium-name">' + esc(u.name) + '</div>' +
                '<div class="cu-podium-svc">' + esc(u.svc || '') + '</div>' +
                '<div class="cu-podium-val cu-num">' + this._fmtVal(active.get(u), active) + '</div>' +
                '<div class="cu-podium-mlabel">' + esc(active.seg) + '</div>' +
                '<div class="cu-podium-foot">' +
                    '<div><div class="cu-num cu-foot-v">' + this._fmtCompact(other.get(u), other) + '</div><div class="cu-foot-l">' + esc(other.seg) + '</div></div>' +
                    '<div><div class="cu-num cu-foot-v green">' + (u.cache === null ? '—' : (u.cache.toFixed(1) + '%')) + '</div><div class="cu-foot-l">cache</div></div>' +
                '</div>' +
            '</div>';
        },

        _render: function() {
            if (!this._list || !this._o) { return; }
            var root = this.container, o = this._o, i;
            root.className = 'cu-lb-root';

            var reg = this._metrics();
            var active = reg[this._sortKey] || reg.tokens;
            var other = this._sortKey === 'cost' ? reg.tokens : reg.cost;

            var list = this._list.slice();
            list.sort(function(a, b) { return (active.get(b) || 0) - (active.get(a) || 0); });

            var maxV = 0;
            for (i = 0; i < list.length; i++) { var v = active.get(list[i]) || 0; if (v > maxV) { maxV = v; } }
            if (maxV <= 0) { maxV = 1; }

            var hasPodium = o.showPodium && list.length >= 3;
            var podiumCount = hasPodium ? 3 : 0;
            var tailLen = Math.max(0, list.length - podiumCount);
            var pageSize = this._fitRows(hasPodium);
            var pageCount = Math.max(1, Math.ceil(tailLen / pageSize));
            if (this._page >= pageCount) { this._page = pageCount - 1; }
            if (this._page < 0) { this._page = 0; }

            var html = '';
            html += '<div class="cu-lb-head"><div class="cu-lb-title">🏆 ' + esc(o.title) + '</div>' +
                '<div class="cu-seg">' +
                    '<button type="button" data-sort="tokens" class="' + (this._sortKey === 'tokens' ? 'on' : '') + '">' + esc(reg.tokens.seg) + '</button>' +
                    '<button type="button" data-sort="cost" class="' + (this._sortKey === 'cost' ? 'on' : '') + '">' + esc(reg.cost.seg) + '</button>' +
                '</div></div>';

            if (hasPodium) {
                html += '<div class="cu-podium-row">' +
                    this._podium(list[1], 1, active, other) +
                    this._podium(list[0], 0, active, other) +
                    this._podium(list[2], 2, active, other) +
                '</div>';
            }

            html += '<div class="cu-lb-colhead">' +
                '<div class="c-rank">#</div><div>User</div><div>' + esc(active.colLabel) + '</div>' +
                '<div class="r">' + esc(other.short) + '</div><div class="r">Cache</div></div>';

            html += '<div class="cu-lb-rows">';
            var startIdx = podiumCount + this._page * pageSize;
            var endIdx = Math.min(list.length, startIdx + pageSize);
            for (i = startIdx; i < endIdx; i++) {
                var u = list[i];
                var pct = Math.max(0, Math.min(100, (active.get(u) || 0) / maxV * 100));
                html += '<div class="cu-lb-row">' +
                    '<div class="c-rank cu-num">' + (i + 1) + '</div>' +
                    '<div class="c-user"><span class="cu-av sm">' + esc(initials(u.name)) + '</span><span class="cu-uname">' + esc(u.name) + '</span></div>' +
                    '<div class="c-metric"><span class="cu-num cu-mval">' + this._fmtCompact(active.get(u), active) + '</span>' +
                        '<span class="cu-bar"><span class="cu-bar-fill" style="width:' + pct.toFixed(1) + '%"></span></span></div>' +
                    '<div class="r cu-num cu-mid">' + this._fmtCompact(other.get(u), other) + '</div>' +
                    '<div class="r cu-num cu-mid">' + (u.cache === null ? '—' : (u.cache.toFixed(1) + '%')) + '</div>' +
                '</div>';
            }
            html += '</div>';

            html += this._pagerHtml(pageCount);

            root.innerHTML = html;
        },

        _pagerHtml: function(pageCount) {
            if (pageCount <= 1) { return ''; }
            var cur = this._page, parts = [], win, i, p;
            parts.push('<button type="button" class="cu-pg-arr' + (cur === 0 ? ' disabled' : '') + '" data-page="prev">‹</button>');
            win = pageWindow(pageCount, cur);
            for (i = 0; i < win.length; i++) {
                p = win[i];
                if (p === -1) { parts.push('<span class="cu-pg-gap">…</span>'); }
                else { parts.push('<button type="button" class="cu-pg' + (p === cur ? ' on' : '') + '" data-page="' + p + '">' + (p + 1) + '</button>'); }
            }
            parts.push('<button type="button" class="cu-pg-arr' + (cur === pageCount - 1 ? ' disabled' : '') + '" data-page="next">›</button>');
            return '<div class="cu-pager">' + parts.join('') + '</div>';
        },

        _onClick: function(e) {
            var t = e.target;
            if (!t || !t.closest) { return; }
            var s = t.closest('[data-sort]');
            if (s) {
                var k = s.getAttribute('data-sort');
                if (k && k !== this._sortKey) { this._sortKey = k; this._page = 0; this._render(); }
                return;
            }
            var p = t.closest('[data-page]');
            if (p) {
                var v = p.getAttribute('data-page');
                if (v === 'prev') { this._page -= 1; }
                else if (v === 'next') { this._page += 1; }
                else { this._page = parseInt(v, 10) || 0; }
                this._render();
            }
        },

        _renderStatus: function(message) {
            this.container.className = 'cu-lb-root';
            this.container.innerHTML = '<div class="cu-status">⏳ ' + esc(message) + '</div>';
        },

        reflow: function() { if (this._o) { this._render(); } },

        destroy: function() {
            SplunkVisualizationBase.prototype.destroy.apply(this, arguments);
        }
    });
});
