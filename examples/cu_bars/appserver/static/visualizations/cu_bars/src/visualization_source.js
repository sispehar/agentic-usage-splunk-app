/*
 * Agentic Usage — Ranked Bars (DOM custom visualization)
 *
 * A compact ranked horizontal-bar list: one row per item, sorted desc by value,
 * each row = label · proportional bar · value(+unit) · optional secondary chip.
 * Renders the top `maxRows` and a muted "+N more" footer when truncated — so it
 * stays readable with dozens of categories (unlike a donut). Built for the GitLab
 * tab's "Most AI-Active Repos" (Claude pushes per repo, AI% as secondary), but
 * generic: every column is a configurable field name.
 *
 * Expected SPL columns (configurable, multi-row): label, value [, secondary]
 */
define([
    'api/SplunkVisualizationBase',
    'api/SplunkVisualizationUtils'
], function(SplunkVisualizationBase, SplunkVisualizationUtils) {

    function esc(s) {
        s = (s === undefined || s === null) ? '' : String(s);
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function num(v) { var f = parseFloat(v); return isNaN(f) ? null : f; }
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
    // A pure-white bar colour is invisible on a light panel — fall back to teal.
    function accentSafe(c, isLight) {
        if (!isLight || typeof c !== 'string') { return c; }
        var s = c.replace(/^\s+|\s+$/g, '').toLowerCase();
        return (s === '#fff' || s === '#ffffff' || s === 'white' || s === 'rgb(255,255,255)') ? '#1f9e8e' : c;
    }

    return SplunkVisualizationBase.extend({

        initialize: function() {
            SplunkVisualizationBase.prototype.initialize.apply(this, arguments);
            this.el.classList.add('agentic-usage');
            this.container = document.createElement('div');
            this.container.className = 'cu-bars-root';
            this.el.appendChild(this.container);
            this._lastGoodData = null;
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
                throw new SplunkVisualizationBase.VisualizationError('Awaiting data — Bars');
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
            var isLight = cuIsLight(config[ns + 'theme']);
            this.el.setAttribute('data-theme', isLight ? 'light' : 'dark');
            if (data && data._status) { this._renderStatus(data._status); return; }
            if (!data) {
                if (this._lastGoodData) { data = this._lastGoodData; } else { return; }
            }
            function cfg(k, d) { var v = config[ns + k]; return (v === undefined || v === null || v === '') ? d : v; }

            var o = {
                title: cfg('title', 'Top Items'),
                subtitle: cfg('subtitle', ''),
                labelField: cfg('labelField', 'label'),
                valueField: cfg('valueField', 'value'),
                valueUnit: cfg('valueUnit', ''),
                secondaryField: cfg('secondaryField', ''),
                secondarySuffix: cfg('secondarySuffix', '%'),
                barColor: accentSafe(cfg('barColor', '#28b6a4'), isLight),
                maxRows: parseInt(cfg('maxRows', '0'), 10) || 0
            };

            var ci = data.colIdx, rows = data.rows;
            function cell(r, field) { return (field && ci[field] !== undefined) ? r[ci[field]] : undefined; }

            var list = [], i;
            for (i = 0; i < rows.length; i++) {
                var r = rows[i];
                var lbl = cell(r, o.labelField);
                if (lbl === null || lbl === undefined || lbl === '') { continue; }
                list.push({
                    label: lbl,
                    value: num(cell(r, o.valueField)),
                    secondary: o.secondaryField ? cell(r, o.secondaryField) : undefined
                });
            }
            list.sort(function(a, b) { return (b.value || 0) - (a.value || 0); });
            this._render(o, list);
        },

        _render: function(o, list) {
            var maxV = list.length ? (list[0].value || 0) : 0;
            if (maxV <= 0) { maxV = 1; }
            var total = list.length;
            var shown = (o.maxRows > 0) ? list.slice(0, o.maxRows) : list;

            var html = '<div class="cu-bars-head">' +
                '<span class="cu-bars-title">' + esc(o.title) + '</span>' +
                (o.subtitle ? '<span class="cu-bars-sub"> · ' + esc(o.subtitle) + '</span>' : '') +
            '</div>';

            html += '<div class="cu-bars-list">';
            if (!shown.length) {
                html += '<div class="cu-bars-empty">No data in range</div>';
            }
            for (var i = 0; i < shown.length; i++) {
                var it = shown[i];
                var v = it.value;
                var pct = (v !== null && v > 0) ? Math.max(2, v / maxV * 100) : 0;
                var valDisp = (v !== null) ? groupNum(v) + (o.valueUnit ? esc(o.valueUnit) : '') : '—';
                var secDisp = '';
                if (o.secondaryField && it.secondary !== undefined && it.secondary !== null && it.secondary !== '') {
                    secDisp = '<span class="cu-bars-sec">· ' + esc(it.secondary) + esc(o.secondarySuffix) + '</span>';
                }
                html += '<div class="cu-bars-row">' +
                    '<div class="cu-bars-label" title="' + esc(it.label) + '">' + esc(it.label) + '</div>' +
                    '<div class="cu-bars-track"><span class="cu-bars-fill" style="width:' + pct.toFixed(1) + '%;background:' + esc(o.barColor) + '"></span></div>' +
                    '<div class="cu-bars-val"><span class="cu-bars-num">' + valDisp + '</span>' + secDisp + '</div>' +
                '</div>';
            }
            html += '</div>';

            if (o.maxRows > 0 && total > shown.length) {
                html += '<div class="cu-bars-more">+' + (total - shown.length) + ' more</div>';
            }

            this.container.className = 'cu-bars-root';
            this.container.innerHTML = html;
        },

        _renderStatus: function(message) {
            this.container.className = 'cu-bars-root';
            this.container.innerHTML = '<div class="cu-status">⏳ ' + esc(message) + '</div>';
        },

        reflow: function() {},

        destroy: function() {
            SplunkVisualizationBase.prototype.destroy.apply(this, arguments);
        }
    });
});
