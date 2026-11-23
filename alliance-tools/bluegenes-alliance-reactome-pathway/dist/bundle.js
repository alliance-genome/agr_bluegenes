/*
 * Reactome pathway diagram, a BlueGenes tool (tool API version 2).
 * Plain JavaScript without dependencies, so this file is both the source and
 * the bundle. BlueGenes loads it as a script and calls
 * bluegenesAllianceReactomePathway.main(el, service, entity, state, config, navigate, context).
 */
(function (root) {
    'use strict';

    var IMAGE_URL = 'https://reactome.org/ContentService/exporter/diagram/';
    var BROWSER_URL = 'https://reactome.org/PathwayBrowser/#/';
    var REACTOME_ID = /^R-(HSA|MMU|RNO|DRE|DME|CEL|SCE)-\d+$/;
    var MAX_GENES = 5000;
    var PAGE_SIZE = 200;
    var MAX_FLAGGED = 100;
    var VIEW = [
        'Pathway.identifier',
        'Pathway.name',
        'Pathway.genes.id',
        'Pathway.genes.primaryIdentifier',
        'Pathway.genes.symbol'
    ];
    var timing = { requestMs: 30000, iframeMs: 15000, backoffMs: [1000, 2000, 4000] };

    // BlueGenes passes the mine root (for example https://host/mine); the web
    // services live under /service. Accept either form.
    function serviceRoot(rootUrl) {
        var r = String(rootUrl || '').replace(/\/+$/, '');
        return /\/service$/.test(r) ? r : r + '/service';
    }

    function isReactomeId(id) {
        return typeof id === 'string' && REACTOME_ID.test(id);
    }

    function isHuman(id) {
        return /^R-HSA-/.test(id);
    }

    function diagramImageUrl(id) {
        return IMAGE_URL + id + '.png';
    }

    function browserUrl(id, flags) {
        return BROWSER_URL + id + (flags && flags.length ? '&FLG=' + flags.map(encodeURIComponent).join(',') : '');
    }

    function escapeXml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function buildQuery(id) {
        return (
            '<query model="genomic" view="' + VIEW.join(' ') + '" sortOrder="Pathway.genes.symbol asc">' +
            '<constraint path="Pathway.id" op="=" value="' + escapeXml(id) + '"/>' +
            '</query>'
        );
    }

    function requestBody(id) {
        return 'format=json&size=' + (MAX_GENES + 1) + '&query=' + encodeURIComponent(buildQuery(id));
    }

    function buildProteinQuery(geneIds) {
        return (
            '<query model="genomic" view="Gene.id Gene.proteins.primaryAccession">' +
            '<constraint path="Gene.id" op="ONE OF">' +
            geneIds.map(function (i) { return '<value>' + escapeXml(i) + '</value>'; }).join('') +
            '</constraint></query>'
        );
    }

    function proteinRequestBody(geneIds) {
        return 'format=json&query=' + encodeURIComponent(buildProteinQuery(geneIds));
    }

    // Rows are (gene id, accession). Isoform suffixes (P18824-2) are dropped and repeats removed.
    function accessionsOf(rows) {
        var seen = {};
        var out = [];
        rows.forEach(function (r) {
            if (r[1] == null) return;
            var acc = String(r[1]).replace(/-\d+$/, '');
            if (!seen[acc]) {
                seen[acc] = true;
                out.push(acc);
            }
        });
        return out;
    }

    function cmp(a, b) {
        a = a == null ? '' : String(a);
        b = b == null ? '' : String(b);
        return a < b ? -1 : a > b ? 1 : 0;
    }

    function toGenes(rows) {
        var seen = {};
        return rows
            .filter(function (r) {
                if (r[2] == null || seen[r[2]]) return false;
                seen[r[2]] = true;
                return true;
            })
            .map(function (r) { return { id: r[2], identifier: r[3], symbol: r[4] }; })
            .sort(function (a, b) {
                return cmp(a.symbol || a.identifier, b.symbol || b.identifier) || cmp(a.identifier, b.identifier);
            });
    }

    function filterGenes(genes, text) {
        var t = String(text || '').trim().toLowerCase();
        if (!t) return genes;
        return genes.filter(function (g) {
            return String(g.symbol || '').toLowerCase().indexOf(t) !== -1 ||
                String(g.identifier || '').toLowerCase().indexOf(t) !== -1;
        });
    }

    function plural(n, one, many) {
        return n + ' ' + (n === 1 ? one : many);
    }

    function node(tag, text, className) {
        var e = document.createElement(tag);
        if (text !== undefined && text !== null) e.textContent = String(text);
        if (className) e.className = className;
        return e;
    }

    function clear(el) {
        while (el.firstChild) el.removeChild(el.firstChild);
    }

    var MESSAGE_CLASS = { loading: 'agr-loading', empty: 'agr-empty', error: 'agr-error' };

    function messageNode(kind, text) {
        var span = node('span', text, MESSAGE_CLASS[kind]);
        if (span.setAttribute) span.setAttribute('role', kind === 'error' ? 'alert' : 'status');
        return span;
    }

    function message(el, kind, text, retry) {
        clear(el);
        var wrap = node('div', null, 'alliance-reactome');
        wrap.appendChild(messageNode(kind, text));
        if (retry) {
            var btn = node('button', 'Retry', 'btn btn-default btn-xs');
            btn.addEventListener('click', retry);
            wrap.appendChild(node('span', ' '));
            wrap.appendChild(btn);
        }
        el.appendChild(wrap);
    }

    function externalLink(text, href) {
        var a = node('a', text);
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener';
        return a;
    }

    function geneRows(tbody, genes, navigate) {
        clear(tbody);
        genes.forEach(function (g) {
            var tr = node('tr');
            var a = node('a', g.symbol || g.identifier);
            a.href = '#';
            a.addEventListener('click', function (ev) {
                if (ev && ev.preventDefault) ev.preventDefault();
                if (typeof navigate === 'function') navigate('report', { type: 'Gene', id: g.id });
            });
            var symbolCell = node('td');
            symbolCell.appendChild(a);
            tr.appendChild(symbolCell);
            tr.appendChild(node('td', g.identifier || ''));
            tbody.appendChild(tr);
        });
    }

    function geneTable() {
        var table = node('table', null, 'table table-condensed table-striped');
        var headRow = node('tr');
        ['Symbol', 'Identifier'].forEach(function (h) { headRow.appendChild(node('th', h)); });
        var thead = node('thead');
        thead.appendChild(headRow);
        table.appendChild(thead);
        var tbody = node('tbody');
        table.appendChild(tbody);
        return { table: table, tbody: tbody };
    }

    function delay(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function failure(label, status) {
        var err = new Error(label);
        err.status = status;
        return err;
    }

    function timedFetch(url, opts) {
        return new Promise(function (resolve, reject) {
            var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
            var timer = setTimeout(function () {
                if (ctl) ctl.abort();
                reject(failure('timeout'));
            }, timing.requestMs);
            var init = { method: opts.method, headers: opts.headers, body: opts.body };
            if (ctl) init.signal = ctl.signal;
            fetch(url, init).then(
                function (res) { clearTimeout(timer); resolve(res); },
                function (err) { clearTimeout(timer); reject(err); }
            );
        });
    }

    // POSTs to the mine, retrying with backoff on HTTP 429.
    function postQuery(service, body) {
        var headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
        if (service.token) headers.Authorization = 'Bearer ' + service.token;
        var url = serviceRoot(service.root) + '/query/results';
        function attempt(n) {
            return timedFetch(url, { method: 'POST', headers: headers, body: body }).then(function (res) {
                if (res.status === 429 && n < timing.backoffMs.length) {
                    return delay(timing.backoffMs[n]).then(function () { return attempt(n + 1); });
                }
                if (!res.ok) throw failure('HTTP ' + res.status, res.status);
                return res.json();
            });
        }
        return attempt(0).then(function (json) { return (json && json.results) || []; });
    }

    function describeFailure(err) {
        var why = err && err.message ? err.message : 'network error';
        return 'Could not load the pathway from the mine (' + why + ').';
    }

    function showImage(holder, id) {
        var img = node('img', null, 'alliance-reactome-image');
        img.style.maxWidth = '100%';
        img.alt = 'Reactome diagram of ' + id;
        img.onerror = function () {
            clear(holder);
            holder.appendChild(messageNode('error', 'Reactome diagram unavailable (reactome.org unreachable). Use the link above.'));
        };
        img.src = diagramImageUrl(id);
        holder.appendChild(img);
    }

    // The Reactome pathway browser runs in an iframe on reactome.org, so its scripts never share the BlueGenes origin.
    function showDiagram(holder, id, flags) {
        clear(holder);
        var done = false;
        var frame = node('iframe', null, 'alliance-reactome-frame');
        frame.title = 'Reactome diagram of ' + id;
        frame.sandbox = 'allow-scripts allow-same-origin allow-popups';
        frame.referrerPolicy = 'no-referrer';
        frame.loading = 'lazy';
        frame.style.width = '100%';
        frame.style.height = '600px';
        frame.style.border = '0';
        var timer = setTimeout(function () {
            if (done) return;
            done = true;
            clear(holder);
            holder.appendChild(messageNode('error', 'Reactome diagram unavailable (reactome.org did not respond). Showing the static image.'));
            showImage(holder, id);
        }, timing.iframeMs);
        frame.onload = function () {
            done = true;
            clearTimeout(timer);
        };
        frame.src = browserUrl(id, flags);
        holder.appendChild(frame);
    }

    function saveGenes(context, name, genes, status) {
        if (!genes.length) return;
        status.textContent = 'Saving...';
        var ids = genes.map(function (g) { return g.id; });
        var saved;
        try {
            saved = context.saveList({ name: name, class: 'Gene', ids: ids, tags: ['bluegenes'] });
        } catch (err) {
            status.textContent = 'Could not save the list: ' + err.message;
            return;
        }
        Promise.resolve(saved).then(
            function (listName) { status.textContent = 'Saved ' + plural(ids.length, 'gene', 'genes') + ' as ' + listName + '.'; },
            function (err) { status.textContent = 'Could not save the list: ' + (err && err.message ? err.message : 'unknown error') + '.'; }
        );
    }

    function copySymbols(genes, status) {
        var symbols = genes.map(function (g) { return g.symbol || g.identifier; });
        var clip = typeof navigator !== 'undefined' && navigator.clipboard;
        if (!clip || typeof clip.writeText !== 'function') {
            status.textContent = 'Copying is not available in this browser.';
            return;
        }
        clip.writeText(symbols.join('\n')).then(
            function () { status.textContent = 'Copied ' + plural(symbols.length, 'symbol', 'symbols') + '.'; },
            function () { status.textContent = 'Copying was blocked by the browser.'; }
        );
    }

    function flagTokens(service, pathway, genes) {
        if (isHuman(pathway.identifier)) {
            return Promise.resolve({
                tokens: genes.map(function (g) { return g.symbol; }).filter(Boolean),
                matched: genes.filter(function (g) { return g.symbol; }).length
            });
        }
        return postQuery(service, proteinRequestBody(genes.map(function (g) { return g.id; }))).then(function (rows) {
            var withProtein = {};
            rows.forEach(function (r) { if (r[1] != null) withProtein[r[0]] = true; });
            return {
                tokens: accessionsOf(rows),
                matched: genes.filter(function (g) { return withProtein[g.id]; }).length
            };
        });
    }

    function render(el, token, service, pathway, genes, truncated, navigate, context) {
        clear(el);
        var reactome = isReactomeId(pathway.identifier);
        var wrap = node('div', null, 'alliance-reactome');
        wrap.appendChild(node('p', pathway.name + ' (' + pathway.identifier + '), ' +
            (truncated ? 'first ' : '') + plural(genes.length, 'gene', 'genes') + ' in this mine.', 'alliance-reactome-summary'));
        if (truncated) {
            wrap.appendChild(node('p', 'This pathway has more than ' + MAX_GENES + ' genes in this mine. Only the first ' +
                MAX_GENES + ' by symbol are listed.', 'agr-notice-warning'));
        }
        if (reactome) {
            wrap.appendChild(externalLink('Open in the Reactome pathway browser', browserUrl(pathway.identifier)));
            var holder = node('div', null, 'alliance-reactome-diagram');
            wrap.appendChild(holder);
            showDiagram(holder, pathway.identifier);
        } else {
            wrap.appendChild(node('p', pathway.identifier + ' is not a Reactome pathway, so there is no diagram. The genes follow.', 'agr-note'));
        }

        var shown = genes;
        var showAll = false;
        var controls = node('div', null, 'alliance-reactome-controls');
        var filter = node('input', null, 'form-control input-sm');
        filter.placeholder = 'Filter genes';
        var status = node('span', null, 'agr-note');
        var more = node('button', null, 'btn btn-default btn-xs');
        var copyBtn = node('button', null, 'btn btn-default btn-xs');
        var saveBtn = node('button', null, 'btn btn-default btn-xs');
        var flagBtn = reactome ? node('button', null, 'btn btn-default btn-xs') : null;
        var canSave = context && typeof context.saveList === 'function';
        var t = geneTable();

        function refresh() {
            shown = filterGenes(genes, filter.value);
            var visible = showAll ? shown : shown.slice(0, PAGE_SIZE);
            geneRows(t.tbody, visible, navigate);
            more.textContent = 'Show all ' + shown.length;
            more.style.display = !showAll && shown.length > PAGE_SIZE ? '' : 'none';
            copyBtn.textContent = 'Copy ' + plural(shown.length, 'symbol', 'symbols');
            saveBtn.textContent = 'Save ' + plural(shown.length, 'gene', 'genes') + ' as a list';
            if (flagBtn) flagBtn.textContent = 'Highlight ' + Math.min(shown.length, MAX_FLAGGED) + ' in the diagram';
        }

        filter.addEventListener('input', function () {
            showAll = false;
            refresh();
        });
        more.addEventListener('click', function () {
            showAll = true;
            refresh();
        });
        copyBtn.addEventListener('click', function () { copySymbols(shown, status); });
        saveBtn.addEventListener('click', function () {
            saveGenes(context, pathway.name + ' genes', shown, status);
        });
        if (flagBtn) {
            flagBtn.addEventListener('click', function () {
                var picked = shown.slice(0, MAX_FLAGGED);
                if (!picked.length) return;
                status.textContent = 'Looking up identifiers...';
                flagTokens(service, pathway, picked).then(function (res) {
                    if (el.__agrReactomeReq !== token) return;
                    status.textContent = res.matched + ' of ' + picked.length + ' genes have an identifier to highlight' +
                        (shown.length > picked.length ? ' (first ' + MAX_FLAGGED + ' of ' + shown.length + ' shown)' : '') + '.';
                    showDiagram(holder, pathway.identifier, res.tokens);
                }, function (err) {
                    if (el.__agrReactomeReq !== token) return;
                    status.textContent = 'Could not look up identifiers (' + (err && err.message ? err.message : 'network error') + ').';
                });
            });
        }

        controls.appendChild(filter);
        controls.appendChild(copyBtn);
        if (canSave) controls.appendChild(saveBtn);
        if (flagBtn) controls.appendChild(flagBtn);
        controls.appendChild(status);
        if (genes.length) {
            wrap.appendChild(controls);
            wrap.appendChild(t.table);
            wrap.appendChild(more);
        }
        refresh();
        el.appendChild(wrap);
    }

    function show(el, token, service, rows, navigate, context) {
        if (el.__agrReactomeReq !== token) return;
        if (!rows.length) {
            message(el, 'empty', 'Pathway not found in this mine');
            return;
        }
        var pathway = { identifier: rows[0][0], name: rows[0][1] };
        var truncated = rows.length > MAX_GENES;
        render(el, token, service, pathway, toGenes(truncated ? rows.slice(0, MAX_GENES) : rows), truncated, navigate, context);
    }

    function main(el, service, imEntity, state, config, navigate, context) {
        if (!el || !service || !imEntity) {
            throw new Error('Call main with correct signature');
        }
        var token = (el.__agrReactomeReq = (el.__agrReactomeReq || 0) + 1);
        var id = imEntity.Pathway && imEntity.Pathway.value;
        if (id === undefined || id === null || id === '') {
            message(el, 'empty', 'No pathway selected');
            return;
        }
        function load() {
            message(el, 'loading', 'Loading...');
            postQuery(service, requestBody(id))
                .then(function (rows) { show(el, token, service, rows, navigate, context); })
                .catch(function (err) {
                    if (el.__agrReactomeReq !== token) return;
                    message(el, 'error', describeFailure(err), load);
                });
        }
        load();
    }

    var api = {
        main: main,
        serviceRoot: serviceRoot,
        isReactomeId: isReactomeId,
        diagramImageUrl: diagramImageUrl,
        browserUrl: browserUrl,
        buildQuery: buildQuery,
        requestBody: requestBody,
        buildProteinQuery: buildProteinQuery,
        accessionsOf: accessionsOf,
        toGenes: toGenes,
        filterGenes: filterGenes,
        escapeXml: escapeXml,
        timing: timing,
        MAX_GENES: MAX_GENES,
        PAGE_SIZE: PAGE_SIZE
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.bluegenesAllianceReactomePathway = api;
})(typeof window !== 'undefined' ? window : globalThis);
