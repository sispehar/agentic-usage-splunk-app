/*
 * Agentic Usage — Setup Checklist (DOM custom visualization)
 *
 * Ordered ingest health checks with status badges. Two display modes:
 *   • list   — the Data Health page centerpiece: one row per check
 *              (index · step · detail · status badge) plus setup-hint lines
 *              under any check that is not OK.
 *   • banner — an overlay strip for the Overview/Sessions dashboards: renders
 *              NOTHING while every row is OK (and lets mouse events pass
 *              through), otherwise paints an opaque strip with the first
 *              failing check and a link to the Data Health view.
 *
 * Expected SPL columns (row order = display order):
 *   step   check title                       e.g. "1 · Collector → Splunk"
 *   status OK | WAIT | WARN | FAIL           (case-insensitive)
 *   detail short right-aligned mono detail   e.g. "1,284 pts · last 12:41"
 *   hint   setup instruction; "||" separates lines; shown when status != OK
 */
define([
    'api/SplunkVisualizationBase',
    'api/SplunkVisualizationUtils'
], function(SplunkVisualizationBase, SplunkVisualizationUtils) {

    function esc(s) {
        s = (s === undefined || s === null) ? '' : String(s);
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
    // Normalized status key: "ok" | "warn" | "wait" | "fail" (unknown → "wait").
    function statusKey(s) {
        s = (s === undefined || s === null) ? '' : String(s).toLowerCase();
        if (s === 'ok' || s === 'warn' || s === 'wait' || s === 'fail') { return s; }
        return 'wait';
    }
    // A view name is the only thing we ever link to — restrict to a safe charset
    // so no scheme/path tricks can ride in via the formatter option.
    function safeViewName(v) {
        v = (v === undefined || v === null) ? '' : String(v);
        return /^[A-Za-z0-9_-]+$/.test(v) ? v : '';
    }

    return SplunkVisualizationBase.extend({

        initialize: function() {
            SplunkVisualizationBase.prototype.initialize.apply(this, arguments);
            this.el.classList.add('agentic-usage');
            this.container = document.createElement('div');
            this.container.className = 'cu-cl-root';
            this.el.appendChild(this.container);
            this._lastGoodData = null;
            // Custom vizs run inside a sandboxed iframe: target="_top" retargets
            // the anchor, and this fallback drives the top window directly when
            // it is reachable (same-origin in Splunk Web).
            var self = this;
            this.container.addEventListener('click', function(e) {
                var t = e.target;
                var a = (t && t.closest) ? t.closest('a.cu-cl-link') : null;
                if (!a) { return; }
                var href = a.getAttribute('href');
                if (!href) { return; }
                try {
                    if (window.top && window.top.location) {
                        window.top.location.href = href;
                        e.preventDefault();
                    }
                } catch (err) { /* cross-origin top — let target="_top" handle it */ }
            });
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
                // Never throw: a thrown VisualizationError paints Splunk's error
                // chrome, which a banner overlaying the KPI row must never do
                // (e.g. while the indexes don't exist yet). updateView decides
                // per display mode what "no data" looks like.
                return { _empty: true };
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
            function cfg(k, d) { var v = config[ns + k]; return (v === undefined || v === null || v === '') ? d : v; }

            var isLight = cuIsLight(config[ns + 'theme']);
            this.el.setAttribute('data-theme', isLight ? 'light' : 'dark');

            var o = {
                displayMode: String(cfg('displayMode', 'list')).toLowerCase() === 'banner' ? 'banner' : 'list',
                title: cfg('title', 'Data Health'),
                subtitle: cfg('subtitle', ''),
                stepField: cfg('stepField', 'step'),
                statusField: cfg('statusField', 'status'),
                detailField: cfg('detailField', 'detail'),
                hintField: cfg('hintField', 'hint'),
                linkView: safeViewName(cfg('linkView', 'agentic_health')),
                linkLabel: cfg('linkLabel', 'Open Data Health →')
            };

            if (data && data._status) {
                if (o.displayMode === 'banner') { this._renderNothing(); return; }
                this._renderStatus(data._status);
                return;
            }
            if (data && data._empty) {
                if (o.displayMode === 'banner') { this._renderNothing(); return; }
                this._renderStatus('Awaiting data');
                return;
            }
            if (!data || !data.rows) {
                if (this._lastGoodData) { data = this._lastGoodData; }
                else if (o.displayMode === 'banner') { this._renderNothing(); return; }
                else { return; }
            }

            var ci = data.colIdx;
            function cell(r, field) { return (field && ci[field] !== undefined) ? r[ci[field]] : undefined; }
            var items = [], i, r;
            for (i = 0; i < data.rows.length; i++) {
                r = data.rows[i];
                items.push({
                    step: cell(r, o.stepField),
                    status: statusKey(cell(r, o.statusField)),
                    statusRaw: cell(r, o.statusField),
                    detail: cell(r, o.detailField),
                    hint: cell(r, o.hintField)
                });
            }

            if (o.displayMode === 'banner') {
                var bad = null;
                for (i = 0; i < items.length; i++) {
                    if (items[i].status !== 'ok') { bad = items[i]; break; }
                }
                if (!bad) { this._renderNothing(); return; }
                this.el.style.pointerEvents = 'auto';
                this._renderBanner(bad, o);
                return;
            }

            this.el.style.pointerEvents = 'auto';
            this._renderList(items, o);
        },

        _badgeHtml: function(it) {
            var label = (it.statusRaw === undefined || it.statusRaw === null || it.statusRaw === '')
                ? it.status.toUpperCase() : String(it.statusRaw).toUpperCase();
            return '<span class="cu-cl-badge cs-' + it.status + '">' + esc(label) + '</span>';
        },

        _hintHtml: function(hint) {
            if (hint === undefined || hint === null || hint === '') { return ''; }
            var parts = String(hint).split('||'), html = '', i, seg;
            for (i = 0; i < parts.length; i++) {
                seg = parts[i].replace(/^\s+|\s+$/g, '');
                if (seg) { html += '<div class="cu-cl-hint-line">' + esc(seg) + '</div>'; }
            }
            return html ? '<div class="cu-cl-hint">' + html + '</div>' : '';
        },

        _renderList: function(items, o) {
            var okCount = 0, i;
            for (i = 0; i < items.length; i++) { if (items[i].status === 'ok') { okCount++; } }

            var html = '';
            if (o.title || o.subtitle) {
                html += '<div class="cu-cl-head">' +
                    '<div class="cu-cl-titles">' +
                        (o.title ? '<span class="cu-cl-title">' + esc(o.title) + '</span>' : '') +
                        (o.subtitle ? '<span class="cu-cl-sub">' + esc(o.subtitle) + '</span>' : '') +
                    '</div>' +
                    '<span class="cu-cl-count">' + okCount + '/' + items.length + ' ok</span>' +
                '</div>';
            }
            html += '<div class="cu-cl-rows">';
            for (i = 0; i < items.length; i++) {
                var it = items[i];
                html += '<div class="cu-cl-row st-' + it.status + '">' +
                    '<div class="cu-cl-main">' +
                        '<span class="cu-cl-step">' + esc(it.step) + '</span>' +
                        '<span class="cu-cl-detail">' + esc(it.detail === undefined ? '' : it.detail) + '</span>' +
                        this._badgeHtml(it) +
                    '</div>' +
                    (it.status !== 'ok' ? this._hintHtml(it.hint) : '') +
                '</div>';
            }
            html += '</div>';

            this.container.className = 'cu-cl-root mode-list';
            this.container.innerHTML = html;
        },

        _renderBanner: function(bad, o) {
            var html = '<div class="cu-cl-banner sev-' + (bad.status === 'fail' ? 'fail' : 'warn') + '">' +
                this._badgeHtml(bad) +
                '<div class="cu-cl-banner-txt">' +
                    '<div class="cu-cl-banner-step">' + esc(bad.step) + '</div>';
            var firstHint = '';
            if (bad.hint !== undefined && bad.hint !== null && bad.hint !== '') {
                firstHint = String(bad.hint).split('||')[0].replace(/^\s+|\s+$/g, '');
            }
            if (firstHint) { html += '<div class="cu-cl-banner-hint">' + esc(firstHint) + '</div>'; }
            html += '</div>';
            if (o.linkView) {
                html += '<a class="cu-cl-link" target="_top" href="' + esc(this._viewUrl(o.linkView)) + '">' +
                    esc(o.linkLabel) + '</a>';
            }
            html += '</div>';

            this.container.className = 'cu-cl-root mode-banner';
            this.container.innerHTML = html;
        },

        // Resolve a sibling view name against the top window's dashboard path
        // (/…/app/<app>/<view>); falls back to the bare name, which resolves
        // correctly in srcdoc iframes because they inherit the parent base URL.
        _viewUrl: function(view) {
            try {
                var p = window.top.location.pathname;
                return p.replace(/\/[^\/]*$/, '/') + view;
            } catch (e) { return view; }
        },

        _renderNothing: function() {
            this.container.className = 'cu-cl-root mode-banner';
            this.container.innerHTML = '';
            this.el.style.pointerEvents = 'none';
        },

        _renderStatus: function(message) {
            this.container.className = 'cu-cl-root mode-list';
            this.container.innerHTML = '<div class="cu-status">⏳ ' + esc(message) + '</div>';
        },

        reflow: function() {},

        destroy: function() {
            SplunkVisualizationBase.prototype.destroy.apply(this, arguments);
        }
    });
});
