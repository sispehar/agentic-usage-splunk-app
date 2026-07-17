/*
 * Agentic Usage — KPI Tile (DOM custom visualization)
 *
 * HUD bracket tile: uppercase label, big display value (+ optional unit), and a
 * signed delta. Hybrid-DOM renderer — builds real DOM/CSS instead of a <canvas>,
 * so web-font text stays crisp and selectable. No HiDPI handling needed.
 *
 * Expected SPL columns: value (string or number), delta (number, optional).
 * The value is shown verbatim, so SPL may pre-format it (e.g. "5.6B", "$4,553.84").
 */
define([
    'api/SplunkVisualizationBase',
    'api/SplunkVisualizationUtils'
], function(SplunkVisualizationBase, SplunkVisualizationUtils) {

    function esc(s) {
        s = (s === undefined || s === null) ? '' : String(s);
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

    return SplunkVisualizationBase.extend({

        initialize: function() {
            SplunkVisualizationBase.prototype.initialize.apply(this, arguments);
            this.el.classList.add('agentic-usage');
            this.container = document.createElement('div');
            this.container.className = 'cu-kpi-root';
            this.el.appendChild(this.container);
            this._lastGoodData = null;
        },

        getInitialDataParams: function() {
            return {
                outputMode: SplunkVisualizationBase.ROW_MAJOR_OUTPUT_MODE,
                count: 50
            };
        },

        // Data parsing only — never read config here (Rule 21).
        formatData: function(data) {
            if (!data || !data.rows || data.rows.length === 0) {
                if (this._lastGoodData) { return this._lastGoodData; }
                throw new SplunkVisualizationBase.VisualizationError('Awaiting data — KPI Tile');
            }
            var fields = data.fields, colIdx = {}, i;
            for (i = 0; i < fields.length; i++) { colIdx[fields[i].name] = i; }

            // appendpipe no-data fallback (Rule 27)
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

            function cfg(k, d) {
                var v = config[ns + k];
                return (v === undefined || v === null || v === '') ? d : v;
            }
            // JS defaults MUST match formatter.html defaults (Rule 19)
            var label = cfg('label', 'METRIC');
            var unit = cfg('unit', '');
            var hero = cfg('hero', 'false') === 'true';
            var accent = cfg('accentColor', '#28b6a4');
            var frame = cfg('frame', 'bracket');
            var valueField = cfg('valueField', 'value');
            var deltaField = cfg('deltaField', 'delta');

            var ci = data.colIdx, row = data.rows[data.rows.length - 1];
            var value = (ci[valueField] !== undefined) ? row[ci[valueField]] : '';
            var delta = (ci[deltaField] !== undefined) ? parseFloat(row[ci[deltaField]]) : NaN;

            this._renderTile(label, value, unit, delta, hero, accent, frame);
        },

        _renderTile: function(label, value, unit, delta, hero, accent, frame) {
            var root = this.container;
            root.className = 'cu-kpi-root';
            root.setAttribute('data-frame', frame);
            root.setAttribute('data-hero', hero ? '1' : '0');
            root.style.setProperty('--cu-accent', accent);

            var deltaHtml = '';
            if (!isNaN(delta)) {
                var up = delta >= 0;
                deltaHtml = '<span class="cu-kpi-delta ' + (up ? 'pos' : 'neg') + '">' +
                    (up ? '▲' : '▼') + Math.abs(delta) + '%</span>';
            }
            var unitHtml = unit ? '<span class="cu-kpi-unit">' + esc(unit) + '</span>' : '';

            root.innerHTML =
                '<span class="cu-corner tl"></span><span class="cu-corner tr"></span>' +
                '<span class="cu-corner bl"></span><span class="cu-corner br"></span>' +
                '<div class="cu-kpi-label">' + esc(label) + '</div>' +
                '<div class="cu-kpi-valrow">' +
                    '<span class="cu-kpi-value">' + esc(value) + unitHtml + '</span>' +
                    deltaHtml +
                '</div>';
        },

        _renderStatus: function(message) {
            this.container.className = 'cu-kpi-root';
            this.container.removeAttribute('data-hero');
            this.container.innerHTML = '<div class="cu-status">⏳ ' + esc(message) + '</div>';
        },

        reflow: function() {},

        destroy: function() {
            SplunkVisualizationBase.prototype.destroy.apply(this, arguments);
        }
    });
});
