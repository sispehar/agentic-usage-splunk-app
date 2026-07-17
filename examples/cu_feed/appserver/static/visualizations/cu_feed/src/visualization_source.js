/*
 * Agentic Usage — Activity Feed (DOM custom visualization)
 *
 * A scrollable, terminal-style log of events — one row per data row, rendered as
 *   time · [BADGE] · user → project · text · (ⓘ)
 * The optional badge column is colour-coded (FAILED/ERROR → coral, FORCE/WARN →
 * amber, anything else → teal). When a row carries a non-empty `detailField`
 * value, a clickable ⓘ icon appears on the right; clicking it opens a small
 * popover with troubleshooting key/values (the detail string is "||"-separated
 * "Label: value" segments). Built for the GitLab push timeline (failed pushes
 * expose session id / prompt id / work dir / outcome), but fully generic.
 *
 * Expected SPL columns (configurable, multi-row): Time, User, Project, Command,
 * Badge, Detail.
 */
define([
    'api/SplunkVisualizationBase',
    'api/SplunkVisualizationUtils'
], function(SplunkVisualizationBase, SplunkVisualizationUtils) {

    function esc(s) {
        s = (s === undefined || s === null) ? '' : String(s);
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
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
    function accentSafe(c, isLight) {
        if (!isLight || typeof c !== 'string') { return c; }
        var s = c.replace(/^\s+|\s+$/g, '').toLowerCase();
        return (s === '#fff' || s === '#ffffff' || s === 'white' || s === 'rgb(255,255,255)') ? '#1a1d24' : c;
    }
    function badgeClass(b) {
        var s = (b === undefined || b === null) ? '' : String(b).toLowerCase();
        if (s.indexOf('fail') !== -1 || s.indexOf('error') !== -1 || s.indexOf('reject') !== -1) { return 'b-fail'; }
        if (s.indexOf('force') !== -1 || s.indexOf('warn') !== -1) { return 'b-warn'; }
        return 'b-ok';
    }
    // Render a "||"-separated "Label: value" detail string into key/value rows.
    function popHtml(detail) {
        var parts = String(detail).split('||'), html = '', i;
        for (i = 0; i < parts.length; i++) {
            var seg = parts[i].replace(/^\s+|\s+$/g, '');
            if (!seg) { continue; }
            var ci = seg.indexOf(':');
            if (ci > 0) {
                var k = seg.slice(0, ci).replace(/\s+$/, '');
                var v = seg.slice(ci + 1).replace(/^\s+/, '');
                html += '<div class="cu-pop-row"><span class="cu-pop-k">' + esc(k) + '</span><span class="cu-pop-v">' + esc(v) + '</span></div>';
            } else {
                html += '<div class="cu-pop-row"><span class="cu-pop-v">' + esc(seg) + '</span></div>';
            }
        }
        return html || '<div class="cu-pop-row"><span class="cu-pop-v">No details</span></div>';
    }

    return SplunkVisualizationBase.extend({

        initialize: function() {
            SplunkVisualizationBase.prototype.initialize.apply(this, arguments);
            this.el.classList.add('agentic-usage');
            this.container = document.createElement('div');
            this.container.className = 'cu-feed-root';
            // Body holds head + scrolling list (replaced each render); the popover
            // is a sibling so it survives re-renders.
            this.body = document.createElement('div');
            this.body.className = 'cu-feed-body';
            this.popover = document.createElement('div');
            this.popover.className = 'cu-feed-pop';
            this.container.appendChild(this.body);
            this.container.appendChild(this.popover);
            this.el.appendChild(this.container);
            this._lastGoodData = null;
            this._details = [];
            this._openIdx = null;

            var self = this;
            // One document-level handler: clicks on our ⓘ toggle the popover;
            // clicks elsewhere (outside the popover) close it.
            this._onDocDown = function(e) {
                var t = e.target;
                if (!t || !t.closest) { self._hidePop(); return; }
                var btn = t.closest('.cu-feed-info');
                if (btn && self.container.contains(btn)) { e.preventDefault(); self._togglePop(btn); return; }
                if (self.popover.contains(t)) { return; }
                self._hidePop();
            };
            document.addEventListener('mousedown', this._onDocDown, true);
            // Scrolling the list invalidates the popover anchor → close it.
            this._onScroll = function() { self._hidePop(); };
            this.container.addEventListener('scroll', this._onScroll, true);
        },

        getInitialDataParams: function() {
            return {
                outputMode: SplunkVisualizationBase.ROW_MAJOR_OUTPUT_MODE,
                count: 200
            };
        },

        formatData: function(data) {
            if (!data || !data.rows || data.rows.length === 0) {
                if (this._lastGoodData) { return this._lastGoodData; }
                throw new SplunkVisualizationBase.VisualizationError('Awaiting data — Feed');
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
            var isLight = cuIsLight(config[ns + 'theme']);
            this.el.setAttribute('data-theme', isLight ? 'light' : 'dark');
            if (data && data._status) { this._renderStatus(data._status); return; }
            if (!data) {
                if (this._lastGoodData) { data = this._lastGoodData; } else { return; }
            }
            function cfg(k, d) { var v = config[ns + k]; return (v === undefined || v === null || v === '') ? d : v; }

            var o = {
                title: cfg('title', 'Activity Feed'),
                subtitle: cfg('subtitle', ''),
                timeField: cfg('timeField', 'Time'),
                userField: cfg('userField', 'User'),
                projectField: cfg('projectField', 'Project'),
                textField: cfg('textField', 'Command'),
                badgeField: cfg('badgeField', ''),
                detailField: cfg('detailField', ''),
                accent: accentSafe(cfg('accentColor', '#28b6a4'), isLight),
                maxRows: parseInt(cfg('maxRows', '100'), 10) || 100
            };

            var ci = data.colIdx, rows = data.rows;
            function cell(r, field) { return (field && ci[field] !== undefined) ? r[ci[field]] : undefined; }

            var items = [], i;
            for (i = 0; i < rows.length && items.length < o.maxRows; i++) {
                var r = rows[i];
                items.push({
                    time: cell(r, o.timeField),
                    user: cell(r, o.userField),
                    project: cell(r, o.projectField),
                    text: cell(r, o.textField),
                    badge: o.badgeField ? cell(r, o.badgeField) : undefined,
                    detail: o.detailField ? cell(r, o.detailField) : undefined
                });
            }
            this._render(o, items);
        },

        _render: function(o, items) {
            this._hidePop();
            this._details = [];
            var html = '<div class="cu-feed-head">' +
                '<span class="cu-feed-title">' + esc(o.title) + '</span>' +
                (o.subtitle ? '<span class="cu-feed-sub">' + esc(o.subtitle) + '</span>' : '') +
                '<span class="cu-feed-count">' + items.length + '</span>' +
            '</div>';
            html += '<div class="cu-feed-list">';
            if (!items.length) {
                html += '<div class="cu-feed-empty">No events in range</div>';
            }
            for (var i = 0; i < items.length; i++) {
                var it = items[i];
                var hasDetail = it.detail !== undefined && it.detail !== '' && it.detail !== null;
                this._details[i] = hasDetail ? it.detail : null;
                html += '<div class="cu-feed-row">';
                if (it.time !== undefined && it.time !== '' && it.time !== null) {
                    html += '<span class="cu-feed-time">' + esc(it.time) + '</span>';
                }
                if (it.badge !== undefined && it.badge !== '' && it.badge !== null) {
                    html += '<span class="cu-feed-badge ' + badgeClass(it.badge) + '">' + esc(it.badge) + '</span>';
                }
                if (it.user !== undefined && it.user !== '' && it.user !== null) {
                    html += '<span class="cu-feed-user">' + esc(it.user) + '</span>';
                }
                if (it.project !== undefined && it.project !== '' && it.project !== null && it.project !== '—') {
                    html += '<span class="cu-feed-arrow">→</span>' +
                        '<span class="cu-feed-project" style="color:' + esc(o.accent) + '">' + esc(it.project) + '</span>';
                }
                if (it.text !== undefined && it.text !== '' && it.text !== null) {
                    html += '<span class="cu-feed-text">' + esc(it.text) + '</span>';
                }
                if (hasDetail) {
                    html += '<button type="button" class="cu-feed-info ' + badgeClass(it.badge) + '" data-detail-idx="' + i + '" title="Troubleshooting details" aria-label="Details">i</button>';
                }
                html += '</div>';
            }
            html += '</div>';
            this.body.innerHTML = html;
        },

        _togglePop: function(btn) {
            var idx = btn.getAttribute('data-detail-idx');
            if (this._openIdx === idx && this.popover.className.indexOf('on') !== -1) { this._hidePop(); return; }
            var detail = this._details[parseInt(idx, 10)];
            if (detail === undefined || detail === null || detail === '') { this._hidePop(); return; }
            this.popover.innerHTML = '<div class="cu-feed-pop-hd">Push details</div>' + popHtml(detail);
            this.popover.className = 'cu-feed-pop on';
            this._openIdx = idx;
            this._positionPop(btn);
        },

        _positionPop: function(btn) {
            var br = btn.getBoundingClientRect();
            var cr = this.container.getBoundingClientRect();
            var pw = this.popover.offsetWidth, ph = this.popover.offsetHeight;
            // Prefer opening to the LEFT of the icon (it sits on the right edge).
            var left = (br.left - cr.left) - pw - 8;
            if (left < 6) { left = (br.right - cr.left) + 8; }
            if (left + pw > cr.width - 6) { left = cr.width - pw - 6; }
            if (left < 6) { left = 6; }
            var top = (br.top - cr.top) + br.height / 2 - ph / 2;
            if (top < 6) { top = 6; }
            if (top + ph > cr.height - 6) { top = cr.height - ph - 6; }
            this.popover.style.left = left + 'px';
            this.popover.style.top = top + 'px';
        },

        _hidePop: function() {
            if (this.popover) { this.popover.className = 'cu-feed-pop'; }
            this._openIdx = null;
        },

        _renderStatus: function(message) {
            this._hidePop();
            this._details = [];
            this.body.innerHTML = '<div class="cu-status">⏳ ' + esc(message) + '</div>';
        },

        reflow: function() { this._hidePop(); },

        destroy: function() {
            if (this._onDocDown) { document.removeEventListener('mousedown', this._onDocDown, true); }
            SplunkVisualizationBase.prototype.destroy.apply(this, arguments);
        }
    });
});
