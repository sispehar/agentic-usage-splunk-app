/*
 * Agentic Usage — Live Session Board (DOM custom visualization)
 *
 * One row per active agent session: pulse dot (solid pulsing while the
 * session is active, dimmed with an "idle Xm" label otherwise), user, model
 * chip, provider, duration, animated context-usage bar (teal → gold → coral
 * as the window fills), cost, tool/subagent counts, error badge and the last
 * tool used.
 *
 * Rows are reconciled by session.id rather than re-rendered wholesale, so the
 * periodic dashboard refresh animates the context bars in place instead of
 * flashing, and the scroll position survives. A 5-second client-side tick
 * keeps the idle labels and pulse dots honest between search refreshes.
 *
 * Expected SPL columns (multi-row, fixed names):
 *   session.id user service provider model started last_seen cost tokens prompts
 *   tools errors subagents compactions ctx_tokens ctx_pct last_tool
 * (`started` / `last_seen` are epoch seconds.)
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
    function num(v) {
        var n = parseFloat(v);
        return isNaN(n) ? 0 : n;
    }
    function fmtDur(sec) {
        sec = Math.max(0, Math.floor(sec));
        if (sec < 60) { return sec + 's'; }
        var m = Math.floor(sec / 60);
        if (m < 60) { return m + 'm'; }
        var h = Math.floor(m / 60);
        return h + 'h' + (m % 60 < 10 ? '0' : '') + (m % 60) + 'm';
    }
    function fmtCost(v) {
        if (v >= 1000) { return '$' + (v / 1000).toFixed(1) + 'K'; }
        if (v >= 100) { return '$' + Math.round(v); }
        return '$' + v.toFixed(2);
    }
    function fmtTokens(v) {
        if (v >= 1e9) { return (v / 1e9).toFixed(1) + 'B'; }
        if (v >= 1e6) { return (v / 1e6).toFixed(1) + 'M'; }
        if (v >= 1e3) { return (v / 1e3).toFixed(1) + 'K'; }
        return String(Math.round(v));
    }

    var FIELDS = ['session.id', 'user', 'service', 'provider', 'model', 'started', 'last_seen',
        'cost', 'tokens', 'prompts', 'tools', 'errors', 'subagents', 'compactions',
        'ctx_tokens', 'ctx_pct', 'last_tool'];

    var COL_LABELS = ['', 'USER', 'MODEL', 'PROVIDER', 'DUR', 'CONTEXT', 'COST', 'TOOLS', 'AGENTS', 'ERR', 'LAST TOOL'];

    return SplunkVisualizationBase.extend({

        initialize: function() {
            SplunkVisualizationBase.prototype.initialize.apply(this, arguments);
            this.el.classList.add('agentic-usage');
            this.container = document.createElement('div');
            this.container.className = 'cu-sess-root';

            var headHtml = '<div class="cu-sess-head">' +
                '<span class="cu-sess-title"></span>' +
                '<span class="cu-sess-sub"></span>' +
                '<span class="cu-sess-count"></span>' +
            '</div>';
            var colsHtml = '<div class="cu-sess-cols">';
            for (var i = 0; i < COL_LABELS.length; i++) {
                colsHtml += '<span>' + COL_LABELS[i] + '</span>';
            }
            colsHtml += '</div>';
            this.container.innerHTML = headHtml + colsHtml + '<div class="cu-sess-list"></div>';
            this.el.appendChild(this.container);

            this._titleEl = this.container.querySelector('.cu-sess-title');
            this._subEl = this.container.querySelector('.cu-sess-sub');
            this._countEl = this.container.querySelector('.cu-sess-count');
            this._colsEl = this.container.querySelector('.cu-sess-cols');
            this.list = this.container.querySelector('.cu-sess-list');

            this._lastGoodData = null;
            this._rowEls = {};
            this._opts = null;

            // Client-side tick: keeps pulse dots, idle labels and the live count
            // honest between 30s search refreshes.
            var self = this;
            this._tick = setInterval(function() { self._onTick(); }, 5000);
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
                throw new SplunkVisualizationBase.VisualizationError('Awaiting data — Sessions');
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
                title: cfg('title', 'Active Sessions'),
                subtitle: cfg('subtitle', 'live · 30m window'),
                activeSec: parseInt(cfg('activeThresholdSec', '120'), 10) || 120,
                warnPct: parseFloat(cfg('ctxWarnPct', '60')) || 60,
                highPct: parseFloat(cfg('ctxHighPct', '85')) || 85,
                accent: cfg('accentColor', '#28b6a4'),
                maxRows: parseInt(cfg('maxRows', '50'), 10) || 50
            };
            this._opts = o;

            this._titleEl.textContent = o.title;
            this._subEl.textContent = o.subtitle;
            this._colsEl.style.display = '';

            var ci = data.colIdx, rows = data.rows;
            function cell(r, f) { return (ci[f] !== undefined) ? r[ci[f]] : undefined; }

            var sessions = [], i;
            for (i = 0; i < rows.length; i++) {
                var r = rows[i];
                var sid = cell(r, 'session.id');
                if (sid === undefined || sid === null || sid === '') { continue; }
                sessions.push({
                    sid: String(sid),
                    user: cell(r, 'user') || '—',
                    service: cell(r, 'service') || '',
                    provider: cell(r, 'provider') || '—',
                    model: cell(r, 'model') || '',
                    started: num(cell(r, 'started')),
                    last_seen: num(cell(r, 'last_seen')),
                    cost: num(cell(r, 'cost')),
                    tokens: num(cell(r, 'tokens')),
                    prompts: num(cell(r, 'prompts')),
                    tools: num(cell(r, 'tools')),
                    errors: num(cell(r, 'errors')),
                    subagents: num(cell(r, 'subagents')),
                    compactions: num(cell(r, 'compactions')),
                    ctx_tokens: cell(r, 'ctx_tokens'),
                    ctx_pct: num(cell(r, 'ctx_pct')),
                    last_tool: cell(r, 'last_tool') || ''
                });
            }
            sessions.sort(function(a, b) { return b.last_seen - a.last_seen; });
            if (sessions.length > o.maxRows) { sessions = sessions.slice(0, o.maxRows); }

            // Keyed reconcile: update/move rows in place; never wipe the list.
            if (this._statusShown || this._emptyShown) {
                this.list.innerHTML = '';
                this._rowEls = {};
                this._statusShown = false;
                this._emptyShown = false;
            }
            var seen = {};
            for (i = 0; i < sessions.length; i++) {
                var s = sessions[i];
                var rec = this._rowEls[s.sid];
                if (!rec) {
                    rec = this._createRow(s.sid);
                    this._rowEls[s.sid] = rec;
                }
                this._updateRow(rec, s, o);
                this.list.appendChild(rec.el); // appendChild moves existing nodes → sorted order
                seen[s.sid] = true;
            }
            for (var sid2 in this._rowEls) {
                if (this._rowEls.hasOwnProperty(sid2) && !seen[sid2]) {
                    var gone = this._rowEls[sid2];
                    if (gone.el && gone.el.parentNode) { gone.el.parentNode.removeChild(gone.el); }
                    delete this._rowEls[sid2];
                }
            }
            if (sessions.length === 0) {
                this.list.innerHTML = '<div class="cu-sess-empty">No active sessions</div>';
                this._rowEls = {};
                this._emptyShown = true;
            }
            this._refreshLive();
        },

        _createRow: function(sid) {
            var el = document.createElement('div');
            el.className = 'cu-sess-row';
            el.setAttribute('data-sid', esc(sid));
            el.innerHTML =
                '<span class="cu-sess-dotcell"><span class="cu-dot"></span></span>' +
                '<span class="cu-sess-user"><span class="cu-u"></span><span class="cu-idle"></span></span>' +
                '<span class="cu-sess-modelcell"><span class="cu-chip"></span></span>' +
                '<span class="cu-sess-term"></span>' +
                '<span class="cu-sess-dur"></span>' +
                '<span class="cu-sess-ctx"><span class="cu-ctx-bar"><span class="cu-ctx-fill"></span></span><span class="cu-ctx-pct"></span></span>' +
                '<span class="cu-sess-cost"></span>' +
                '<span class="cu-sess-num cu-sess-tools"></span>' +
                '<span class="cu-sess-num cu-sess-agents"></span>' +
                '<span class="cu-sess-errcell"><span class="cu-sess-err"></span></span>' +
                '<span class="cu-sess-last"></span>';
            return {
                el: el,
                fresh: true,
                started: 0,
                last_seen: 0,
                dot: el.querySelector('.cu-dot'),
                user: el.querySelector('.cu-u'),
                idle: el.querySelector('.cu-idle'),
                chip: el.querySelector('.cu-chip'),
                term: el.querySelector('.cu-sess-term'),
                dur: el.querySelector('.cu-sess-dur'),
                ctxFill: el.querySelector('.cu-ctx-fill'),
                ctxPct: el.querySelector('.cu-ctx-pct'),
                cost: el.querySelector('.cu-sess-cost'),
                tools: el.querySelector('.cu-sess-tools'),
                agents: el.querySelector('.cu-sess-agents'),
                err: el.querySelector('.cu-sess-err'),
                last: el.querySelector('.cu-sess-last')
            };
        },

        _updateRow: function(rec, s, o) {
            rec.started = s.started;
            rec.last_seen = s.last_seen;

            rec.user.textContent = s.user;
            rec.chip.textContent = s.model || '—';
            rec.chip.className = 'cu-chip' + (s.model ? '' : ' dim');
            rec.term.textContent = s.provider;
            rec.dur.textContent = fmtDur(s.last_seen - s.started);
            rec.cost.textContent = fmtCost(s.cost);
            rec.tools.textContent = s.tools ? String(Math.round(s.tools)) : '—';
            rec.agents.textContent = s.subagents ? String(Math.round(s.subagents)) : '—';
            rec.last.textContent = s.last_tool || '';
            rec.last.title = s.last_tool || '';

            if (s.errors > 0) {
                rec.err.textContent = String(Math.round(s.errors));
                rec.err.className = 'cu-sess-err on';
            } else {
                rec.err.textContent = '—';
                rec.err.className = 'cu-sess-err';
            }

            var hasCtx = s.ctx_tokens !== undefined && s.ctx_tokens !== null && s.ctx_tokens !== '';
            var pct = hasCtx ? Math.max(0, Math.min(100, s.ctx_pct)) : 0;
            var cls = 'cu-ctx-fill';
            if (pct >= o.highPct) { cls += ' c-high'; }
            else if (pct >= o.warnPct) { cls += ' c-warn'; }
            rec.ctxFill.className = cls;
            rec.ctxPct.textContent = hasCtx ? (Math.round(pct) + '%') : '—';
            if (rec.fresh) {
                // Animate fresh rows from 0 → value on the next frame.
                rec.ctxFill.style.width = '0%';
                (function(fill, target) {
                    requestAnimationFrame(function() {
                        requestAnimationFrame(function() { fill.style.width = target + '%'; });
                    });
                })(rec.ctxFill, pct);
                rec.fresh = false;
            } else {
                rec.ctxFill.style.width = pct + '%';
            }

            rec.el.title = 'session ' + s.sid.slice(0, 8) +
                (s.service ? ' · ' + s.service : '') +
                ' · tokens ' + fmtTokens(s.tokens) +
                ' · prompts ' + Math.round(s.prompts) +
                ' · compactions ' + Math.round(s.compactions) +
                (hasCtx ? ' · ctx ' + fmtTokens(num(s.ctx_tokens)) : '');

            this._applyLiveState(rec, o);
        },

        _applyLiveState: function(rec, o) {
            var idleSec = Math.max(0, Date.now() / 1000 - rec.last_seen);
            if (idleSec <= o.activeSec) {
                rec.dot.className = 'cu-dot live';
                rec.idle.textContent = '';
            } else {
                rec.dot.className = 'cu-dot idle';
                rec.idle.textContent = 'idle ' + fmtDur(idleSec);
            }
        },

        _refreshLive: function() {
            if (!this._opts) { return; }
            var live = 0, total = 0;
            for (var sid in this._rowEls) {
                if (!this._rowEls.hasOwnProperty(sid)) { continue; }
                total++;
                var idleSec = Math.max(0, Date.now() / 1000 - this._rowEls[sid].last_seen);
                if (idleSec <= this._opts.activeSec) { live++; }
            }
            this._countEl.textContent = total ? (live + ' live · ' + total + ' sessions') : '';
        },

        _onTick: function() {
            if (!this._opts) { return; }
            for (var sid in this._rowEls) {
                if (this._rowEls.hasOwnProperty(sid)) {
                    this._applyLiveState(this._rowEls[sid], this._opts);
                }
            }
            this._refreshLive();
        },

        _renderStatus: function(message) {
            this.list.innerHTML = '<div class="cu-status">⏳ ' + esc(message) + '</div>';
            this._rowEls = {};
            this._statusShown = true;
            this._colsEl.style.display = 'none';
            this._countEl.textContent = '';
        },

        reflow: function() {},

        destroy: function() {
            if (this._tick) { clearInterval(this._tick); this._tick = null; }
            SplunkVisualizationBase.prototype.destroy.apply(this, arguments);
        }
    });
});
