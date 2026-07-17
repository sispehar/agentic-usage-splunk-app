/*
 * Agentic Usage — Stat Panel (DOM custom visualization)
 *
 * A reusable single-value panel: uppercase label, big accent value (+ optional
 * unit / inline suffix), then EITHER an optional progress bar + footnote OR a
 * set of key/value rows. One viz, three roles on the dashboard:
 *   • Rate-limit 429s   — big value + key/value rows (peak hour, worst user)
 *   • Claude vs Cowork  — big % + bar + footnote
 *   • Team adoption     — big value + suffix + bar + footnote
 *
 * Expected SPL columns are configurable (single row).
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
    // A pure-white accent (e.g. the adoption big value) is invisible on a light
    // panel — fall back to the light theme text colour in that case.
    function accentSafe(c, isLight) {
        if (!isLight || typeof c !== 'string') { return c; }
        var s = c.replace(/^\s+|\s+$/g, '').toLowerCase();
        return (s === '#fff' || s === '#ffffff' || s === 'white' || s === 'rgb(255,255,255)') ? '#1a1d24' : c;
    }

    return SplunkVisualizationBase.extend({

        initialize: function() {
            SplunkVisualizationBase.prototype.initialize.apply(this, arguments);
            this.el.classList.add('agentic-usage');
            this.container = document.createElement('div');
            this.container.className = 'cu-stat-root';
            this.el.appendChild(this.container);
            this._lastGoodData = null;
        },

        getInitialDataParams: function() {
            return {
                outputMode: SplunkVisualizationBase.ROW_MAJOR_OUTPUT_MODE,
                count: 50
            };
        },

        formatData: function(data) {
            if (!data || !data.rows || data.rows.length === 0) {
                if (this._lastGoodData) { return this._lastGoodData; }
                throw new SplunkVisualizationBase.VisualizationError('Awaiting data — Stat');
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
            var isLight = cuIsLight(config[ns + 'theme']);
            this.el.setAttribute('data-theme', isLight ? 'light' : 'dark');
            if (data && data._status) { this._renderStatus(data._status); return; }
            if (!data) {
                if (this._lastGoodData) { data = this._lastGoodData; } else { return; }
            }
            function cfg(k, d) { var v = config[ns + k]; return (v === undefined || v === null || v === '') ? d : v; }

            var o = {
                label: cfg('label', 'STAT'),
                bigField: cfg('bigField', 'value'),
                unit: cfg('unit', ''),
                suffix: cfg('suffix', ''),
                accent: accentSafe(cfg('accentColor', '#f2643d'), isLight),
                barField: cfg('barField', ''),
                barColor: accentSafe(cfg('barColor', '#f2643d'), isLight),
                footnoteField: cfg('footnoteField', ''),
                kv1Label: cfg('kv1Label', ''),
                kv1Field: cfg('kv1Field', ''),
                kv2Label: cfg('kv2Label', ''),
                kv2Field: cfg('kv2Field', '')
            };

            var ci = data.colIdx, row = data.rows[data.rows.length - 1];
            function val(field) { return (field && ci[field] !== undefined) ? row[ci[field]] : undefined; }

            var bigRaw = val(o.bigField);
            var bigNum = num(bigRaw);
            var bigDisp = (bigNum !== null) ? groupNum(bigNum) : esc(bigRaw === undefined ? '' : bigRaw);

            var bar = o.barField ? num(val(o.barField)) : null;
            var foot = o.footnoteField ? val(o.footnoteField) : undefined;

            var kv = [];
            if (o.kv1Field && val(o.kv1Field) !== undefined) { kv.push({ k: o.kv1Label, v: val(o.kv1Field) }); }
            if (o.kv2Field && val(o.kv2Field) !== undefined) { kv.push({ k: o.kv2Label, v: val(o.kv2Field) }); }

            this._render(o, bigDisp, bar, foot, kv);
        },

        _render: function(o, bigDisp, bar, foot, kv) {
            var html = '<div class="cu-stat-label">' + esc(o.label) + '</div>';
            html += '<div class="cu-stat-bigrow"><span class="cu-stat-big" style="color:' + esc(o.accent) + '">' +
                bigDisp + (o.unit ? '<span class="cu-stat-unit">' + esc(o.unit) + '</span>' : '') + '</span>' +
                (o.suffix ? '<span class="cu-stat-suffix">' + esc(o.suffix) + '</span>' : '') + '</div>';

            if (bar !== null) {
                var pct = Math.max(0, Math.min(100, bar));
                html += '<div class="cu-stat-bar"><span class="cu-stat-bar-fill" style="width:' + pct.toFixed(1) +
                    '%;background:' + esc(o.barColor) + '"></span></div>';
            }
            if (foot !== undefined && foot !== '') {
                html += '<div class="cu-stat-foot">' + esc(foot) + '</div>';
            }
            if (kv.length) {
                html += '<div class="cu-stat-kv">';
                for (var i = 0; i < kv.length; i++) {
                    html += '<div class="cu-kv-row"><span class="cu-kv-k">' + esc(kv[i].k) + '</span><span class="cu-kv-v">' + esc(kv[i].v) + '</span></div>';
                }
                html += '</div>';
            }
            this.container.className = 'cu-stat-root';
            this.container.innerHTML = html;
        },

        _renderStatus: function(message) {
            this.container.className = 'cu-stat-root';
            this.container.innerHTML = '<div class="cu-status">⏳ ' + esc(message) + '</div>';
        },

        reflow: function() {},

        destroy: function() {
            SplunkVisualizationBase.prototype.destroy.apply(this, arguments);
        }
    });
});
