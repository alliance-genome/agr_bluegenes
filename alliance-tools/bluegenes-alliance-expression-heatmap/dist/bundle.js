/*
 * Gene by anatomy expression heatmap, a BlueGenes tool (tool API version 2).
 * Based on legumeinfo/lis-expression-heatmap (MIT, see LICENSE), rewritten for
 * AllianceMine expression annotations. Plain JavaScript without dependencies,
 * so this file is both the source and the bundle. BlueGenes loads it as a
 * script and calls bluegenesAllianceExpressionHeatmap.main(el, service,
 * entity, state, config, navigate, context).
 */
(function (root) {
	'use strict';

	var TOP_TERMS = 40;
	var BINS = 5;
	var NO_ANATOMY = 'Unspecified anatomy';
	var NO_STAGE = 'Unspecified stage';
	var NO_ORGANISM = 'Other organisms';
	var BUCKETS = ['embryo', 'larva', 'adult'];
	var BUCKET_PREFIX = 'bucket:';
	var ROOT_TERM = /(anatomical entity|whole organism)$/i;
	var LIS_URL = 'https://github.com/legumeinfo/lis-expression-heatmap';
	var METRICS = [
		{ key: 'annotations', label: 'Annotation records', unit: ['annotation', 'annotations'] },
		{ key: 'stages', label: 'Distinct stages', unit: ['stage', 'stages'] },
		{ key: 'present', label: 'Present or absent', unit: ['annotation', 'annotations'] }
	];
	var VIEW = [
		'Gene.primaryIdentifier',
		'Gene.symbol',
		'Gene.expressionAnnotations.id',
		'Gene.expressionAnnotations.anatomy.name',
		'Gene.expressionAnnotations.anatomy.identifier',
		'Gene.expressionAnnotations.stageTerm',
		'Gene.id',
		'Gene.expressionAnnotations.source',
		'Gene.organism.shortName'
	];
	var GENE_VIEW = ['Gene.primaryIdentifier', 'Gene.symbol', 'Gene.id', 'Gene.organism.shortName'];
	var SORT_ORDER = 'Gene.id asc Gene.expressionAnnotations.id asc';

	// Rows are fetched a page at a time up to maxRows; the mine answers 429 when asked too fast.
	var settings = { pageSize: 10000, maxRows: 100000, timeoutMs: 30000, retries: 3, delayMs: 1000 };

	// BlueGenes passes the mine root (for example https://host/mine); the web
	// services live under /service. Accept either form.
	function serviceRoot(base) {
		var r = String(base || '').replace(/\/+$/, '');
		return /\/service$/.test(r) ? r : r + '/service';
	}

	function escapeXml(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function wrapQuery(ids, view, sortOrder) {
		var list = (Array.isArray(ids) ? ids : [ids]).map(String);
		var constraint =
			list.length === 1
				? '<constraint path="Gene.id" op="=" value="' + escapeXml(list[0]) + '"/>'
				: '<constraint path="Gene.id" op="ONE OF">' +
					list.map(function (v) { return '<value>' + escapeXml(v) + '</value>'; }).join('') +
					'</constraint>';
		var order = sortOrder ? ' sortOrder="' + sortOrder + '"' : '';
		return '<query model="genomic" view="' + view.join(' ') + '"' + order + '>' + constraint + '</query>';
	}

	// ids is one internal Gene.id or an array of them. Sorted so that start/size pages do not overlap.
	function buildQuery(ids) {
		return wrapQuery(ids, VIEW, SORT_ORDER);
	}

	function buildGeneQuery(ids) {
		return wrapQuery(ids, GENE_VIEW);
	}

	function resultsUrl(base) {
		return base.replace(/\/+$/, '') + '/query/results';
	}

	// The id list goes in a POST body: a GET query string fails above about 250 ids.
	function requestBody(ids, start) {
		return 'format=json&size=' + settings.pageSize + '&start=' + (start || 0) + '&query=' + encodeURIComponent(buildQuery(ids));
	}

	function geneRequestBody(ids) {
		var n = Array.isArray(ids) ? ids.length : 1;
		return 'format=json&size=' + Math.max(1, n) + '&query=' + encodeURIComponent(buildGeneQuery(ids));
	}

	function toRow(r) {
		return {
			gene: r[0],
			symbol: r[1],
			annotation: r[2],
			anatomy: r[3],
			anatomyId: r[4],
			stage: r[5],
			geneId: r[6],
			source: r[7],
			organism: r[8]
		};
	}

	function toGene(r) {
		return { id: r[0], symbol: r[1] || null, internalId: r[2], organism: r[3] || '' };
	}

	// One row per gene and annotation id: joins on other collections repeat annotations.
	function dedupeRows(rows) {
		var seen = {};
		return rows.filter(function (row) {
			var key = row.gene + '|' + row.annotation;
			if (seen[key]) return false;
			seen[key] = true;
			return true;
		});
	}

	function stageOf(row) {
		return row.stage || NO_STAGE;
	}

	function cmp(a, b) {
		return a < b ? -1 : a > b ? 1 : 0;
	}

	// Compares digit runs as numbers, so 'embryonic stage 2' sorts before 'embryonic stage 10'.
	function naturalCmp(a, b) {
		var pa = String(a).toLowerCase().match(/\d+|\D+/g) || [];
		var pb = String(b).toLowerCase().match(/\d+|\D+/g) || [];
		for (var i = 0; i < Math.min(pa.length, pb.length); i++) {
			var x = pa[i];
			var y = pb[i];
			var d = /^\d/.test(x) && /^\d/.test(y) ? Number(x) - Number(y) : cmp(x, y);
			if (d) return d;
		}
		return pa.length - pb.length;
	}

	// 0 embryo, 1 larva, 2 adult, 3 anything else; the index in BUCKETS for the first three.
	function stageBucket(stage) {
		var s = String(stage || '');
		var ts = /^TS(\d+)/i.exec(s);
		if (ts) return Number(ts[1]) >= 28 ? 2 : 0;
		if (/embryo|gastrula|blastula|cleavage|segmentation|pharyngula|zygote|fertili[sz]ed|morula|cell stage/i.test(s)) return 0;
		if (/larva|pupa|instar|hatching|^L\d/i.test(s)) return 1;
		if (/adult|juvenile|mature|senescen/i.test(s)) return 2;
		return 3;
	}

	function stageCmp(a, b) {
		return stageBucket(a) - stageBucket(b) || naturalCmp(a, b);
	}

	function sortStages(seen) {
		var names = Object.keys(seen).filter(function (s) { return s !== NO_STAGE; }).sort(stageCmp);
		if (seen[NO_STAGE]) names.push(NO_STAGE);
		return names;
	}

	// Distinct stages in developmental order (embryo, larva, adult), with the missing-stage label last.
	function stagesOf(rows) {
		var seen = {};
		rows.forEach(function (row) { seen[stageOf(row)] = true; });
		return sortStages(seen);
	}

	// Stages per organism, since each organism has its own stage vocabulary.
	function stageGroups(rows) {
		var by = {};
		rows.forEach(function (row) {
			var org = row.organism || NO_ORGANISM;
			(by[org] || (by[org] = {}))[stageOf(row)] = true;
		});
		return Object.keys(by).sort(cmp).map(function (org) { return { organism: org, stages: sortStages(by[org]) }; });
	}

	function stageMatches(row, selected) {
		if (!selected) return true;
		if (selected.indexOf(BUCKET_PREFIX) === 0) {
			return row.stage && stageBucket(row.stage) === BUCKETS.indexOf(selected.slice(BUCKET_PREFIX.length));
		}
		return stageOf(row) === selected;
	}

	function genesOf(rows) {
		var seen = {};
		var genes = [];
		rows.forEach(function (row) {
			if (seen[row.gene]) return;
			seen[row.gene] = true;
			genes.push({ id: row.gene, symbol: row.symbol || null, internalId: row.geneId, organism: row.organism || '' });
		});
		return genes;
	}

	// Columns follow the requested genes, grouped by organism, so genes without annotations still show.
	function orderGenes(genes) {
		return genes.slice().sort(function (a, b) {
			return cmp(a.organism, b.organism) || cmp((a.symbol || a.id).toLowerCase(), (b.symbol || b.id).toLowerCase()) || cmp(a.id, b.id);
		});
	}

	function countTerms(rows, metric) {
		var by = {};
		rows.forEach(function (row) {
			var name = row.anatomy || NO_ANATOMY;
			var key = (row.anatomyId || '') + '|' + name;
			var term = by[key] || (by[key] = { key: key, name: name, identifier: row.anatomyId || '', cells: {}, counts: {}, sources: {}, total: 0, coverage: 0 });
			var cell = term.cells[row.gene] || (term.cells[row.gene] = { records: 0, stages: {}, sources: {} });
			cell.records++;
			cell.stages[stageOf(row)] = true;
			if (row.source) cell.sources[row.source] = true;
		});
		return Object.keys(by).map(function (k) {
			var term = by[k];
			Object.keys(term.cells).forEach(function (g) {
				var cell = term.cells[g];
				var count = metric === 'stages' ? Object.keys(cell.stages).length : metric === 'present' ? 1 : cell.records;
				term.counts[g] = count;
				term.sources[g] = Object.keys(cell.sources).sort();
				term.total += count;
				term.coverage++;
			});
			delete term.cells;
			return term;
		});
	}

	// Most genes first, then most annotations, then name.
	function rankTerms(terms) {
		return terms.slice().sort(function (a, b) {
			return b.coverage - a.coverage || b.total - a.total || cmp(a.name, b.name) || cmp(a.identifier, b.identifier);
		});
	}

	// opts: stage (a stage label or 'bucket:embryo', empty for all), limit (default 40 terms), metric
	// ('annotations', 'stages' or 'present'), hideRoot, search (term name substring) and genes.
	function buildMatrix(rows, opts) {
		var o = opts || {};
		var limit = o.limit || TOP_TERMS;
		var needle = String(o.search || '').trim().toLowerCase();
		var kept = o.stage ? rows.filter(function (row) { return stageMatches(row, o.stage); }) : rows;
		var ranked = rankTerms(countTerms(kept, o.metric)).filter(function (t) {
			if (o.hideRoot && ROOT_TERM.test(t.name)) return false;
			return !needle || t.name.toLowerCase().indexOf(needle) !== -1;
		});
		var terms = ranked.slice(0, limit);
		var max = 0;
		terms.forEach(function (t) {
			Object.keys(t.counts).forEach(function (g) { max = Math.max(max, t.counts[g]); });
		});
		return {
			genes: o.genes ? orderGenes(o.genes) : genesOf(rows),
			terms: terms,
			allTerms: ranked,
			hidden: ranked.length - terms.length,
			max: max
		};
	}

	function sortValue(term, key) {
		if (key === 'name') return term.name.toLowerCase();
		if (key === 'total') return term.total;
		if (key === 'coverage') return term.coverage;
		return term.counts[key.slice(5)] || 0;
	}

	// key is 'name', 'total', 'coverage' or 'gene:<primaryIdentifier>'; dir is 'asc' or 'desc'.
	function sortTerms(terms, key, dir) {
		var sign = dir === 'desc' ? -1 : 1;
		return terms.slice().sort(function (a, b) {
			return sign * cmp(sortValue(a, key), sortValue(b, key)) || cmp(a.name, b.name);
		});
	}

	// Upper bounds of the colour bins, growing geometrically so one large cell does not flatten the rest.
	function binEdges(max) {
		var edges = [];
		var prev = 0;
		for (var k = 1; k <= BINS && prev < max; k++) {
			var edge = Math.min(max, Math.max(prev + 1, Math.floor(Math.pow(max, k / BINS) + 1e-9)));
			if (k === BINS) edge = max;
			edges.push(edge);
			prev = edge;
		}
		return edges;
	}

	function level(count, edges) {
		if (!count) return 0;
		for (var i = 0; i < edges.length; i++) {
			if (count <= edges[i]) return i + 1;
		}
		return edges.length;
	}

	function binLabel(edges, i) {
		var lo = i ? edges[i - 1] + 1 : 1;
		return lo === edges[i] ? String(lo) : lo + '-' + edges[i];
	}

	function csvCell(value) {
		var s = String(value == null ? '' : value);
		if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
		return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
	}

	function geneLabel(gene, bySymbol) {
		var label = bySymbol && gene.symbol ? gene.symbol : gene.id;
		return bySymbol && gene.organism ? label + ' (' + gene.organism + ')' : label;
	}

	function toCsv(genes, terms, bySymbol) {
		var head = ['Anatomy term', 'Anatomy ID']
			.concat(genes.map(function (g) { return geneLabel(g, bySymbol); }), ['Total', 'Genes']);
		var lines = [head].concat(
			terms.map(function (t) {
				return [t.name, t.identifier]
					.concat(genes.map(function (g) { return t.counts[g.id] || 0; }), [t.total, t.coverage]);
			})
		);
		return lines.map(function (line) { return line.map(csvCell).join(','); }).join('\r\n');
	}

	function csvFilename(stage) {
		var label = String(stage || '').replace(BUCKET_PREFIX, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
		return 'expression-heatmap' + (label ? '-' + label : '') + '.csv';
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

	function message(el, text, cls) {
		clear(el);
		var wrap = node('div', null, 'alliance-expression-heatmap');
		wrap.appendChild(node('p', text, cls));
		el.appendChild(wrap);
	}

	function download(text, filename) {
		var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
		var url = URL.createObjectURL(blob);
		var a = node('a');
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
	}

	function metricOf(key) {
		return METRICS.filter(function (m) { return m.key === key; })[0] || METRICS[0];
	}

	function sortHeader(label, key, state, rerender, className) {
		var th = node('th', null, className);
		th.setAttribute('scope', 'col');
		var active = state.key === key;
		if (active) th.setAttribute('aria-sort', state.dir === 'asc' ? 'ascending' : 'descending');
		var btn = node('button', label + (active ? (state.dir === 'asc' ? ' ▲' : ' ▼') : ''), 'agr-btn agr-btn-sm alliance-expression-heatmap-sort');
		btn.type = 'button';
		btn.title = 'Sort by ' + label;
		btn.addEventListener('click', function () {
			var again = state.key === key;
			state.key = key;
			state.dir = again && state.dir === 'desc' ? 'asc' : 'desc';
			if (key === 'name' && !again) state.dir = 'asc';
			rerender();
		});
		th.appendChild(btn);
		return th;
	}

	function geneHeader(gene, state, rerender, navigate) {
		var th = sortHeader(gene.symbol || gene.id, 'gene:' + gene.id, state, rerender, 'alliance-expression-heatmap-gene');
		th.title = gene.id + (gene.organism ? ' (' + gene.organism + ')' : '');
		if (gene.organism) th.appendChild(node('span', gene.organism, 'alliance-expression-heatmap-organism'));
		if (typeof navigate === 'function' && gene.internalId != null) {
			var a = node('a', '↗', 'alliance-expression-heatmap-open');
			a.href = '#';
			a.title = 'Open ' + gene.id;
			a.addEventListener('click', function (ev) {
				if (ev && ev.preventDefault) ev.preventDefault();
				navigate('report', { type: 'Gene', id: gene.internalId });
			});
			th.appendChild(a);
		}
		return th;
	}

	function cellText(term, gene, count, metric) {
		var m = metricOf(metric);
		var what = count ? count + ' ' + m.unit[count === 1 ? 0 : 1] : 'no annotations';
		var sources = (term.sources[gene.id] || []).join(', ');
		return term.name + ' in ' + (gene.symbol || gene.id) + (gene.organism ? ' (' + gene.organism + ')' : '') + ': ' + what + (sources ? ' from ' + sources : '');
	}

	function cellFor(term, gene, edges, metric) {
		var count = term.counts[gene.id] || 0;
		var td = node('td', count || '', 'alliance-expression-heatmap-cell alliance-expression-heatmap-l' + level(count, edges));
		var text = cellText(term, gene, count, metric);
		td.title = text;
		td.setAttribute('aria-label', text);
		return td;
	}

	function saveCell(term, matrix, state, saver) {
		var td = node('td', null, 'alliance-expression-heatmap-save');
		var ids = matrix.genes
			.filter(function (g) { return term.counts[g.id] && g.internalId != null; })
			.map(function (g) { return g.internalId; });
		var btn = node('button', 'Save ' + ids.length + (ids.length === 1 ? ' gene' : ' genes'), 'agr-btn agr-btn-sm');
		btn.type = 'button';
		btn.title = 'Save the genes annotated to ' + term.name + ' as a list';
		btn.addEventListener('click', function () {
			saver(term.name + (state.stage ? ' (' + state.stage.replace(BUCKET_PREFIX, '') + ')' : ''), ids);
		});
		td.appendChild(btn);
		return td;
	}

	function termRow(term, matrix, edges, state, saver) {
		var tr = node('tr');
		var th = node('th', term.name, 'alliance-expression-heatmap-term');
		th.setAttribute('scope', 'row');
		th.title = term.identifier;
		tr.appendChild(th);
		matrix.genes.forEach(function (gene) { tr.appendChild(cellFor(term, gene, edges, state.metric)); });
		tr.appendChild(node('td', term.coverage, 'num'));
		tr.appendChild(node('td', term.total, 'num'));
		if (saver) tr.appendChild(saveCell(term, matrix, state, saver));
		return tr;
	}

	function buildTable(matrix, state, rerender, navigate, saver) {
		var table = node('table', null, 'agr-table agr-table-sm alliance-expression-heatmap-grid');
		var edges = binEdges(matrix.max);
		var headRow = node('tr');
		headRow.appendChild(sortHeader('Anatomy term', 'name', state, rerender));
		matrix.genes.forEach(function (g) { headRow.appendChild(geneHeader(g, state, rerender, navigate)); });
		headRow.appendChild(sortHeader('Genes', 'coverage', state, rerender));
		headRow.appendChild(sortHeader('Total', 'total', state, rerender));
		if (saver) {
			var listHead = node('th', 'List');
			listHead.setAttribute('scope', 'col');
			headRow.appendChild(listHead);
		}
		var thead = node('thead');
		thead.appendChild(headRow);
		table.appendChild(thead);
		var tbody = node('tbody');
		sortTerms(matrix.terms, state.key, state.dir).forEach(function (t) { tbody.appendChild(termRow(t, matrix, edges, state, saver)); });
		table.appendChild(tbody);
		return table;
	}

	function legend(max, metric) {
		var edges = binEdges(max);
		var box = node('div', null, 'alliance-expression-heatmap-legend');
		box.appendChild(node('span', metricOf(metric).label + ':', 'alliance-expression-heatmap-legend-title'));
		edges.forEach(function (edge, i) {
			var item = node('span', null, 'alliance-expression-heatmap-legend-item');
			item.appendChild(node('span', null, 'alliance-expression-heatmap-swatch alliance-expression-heatmap-l' + (i + 1)));
			item.appendChild(node('span', binLabel(edges, i)));
			box.appendChild(item);
		});
		return box;
	}

	function option(value, label, selected) {
		var opt = node('option', label);
		opt.value = value;
		opt.selected = selected;
		return opt;
	}

	function stageSelect(groups, state, rerender) {
		var select = node('select', null, 'alliance-expression-heatmap-stage');
		select.title = 'Filter by developmental stage';
		select.setAttribute('aria-label', 'Developmental stage');
		select.appendChild(option('', 'All stages', state.stage === ''));
		var coarse = node('optgroup');
		coarse.label = 'Stage group, all organisms';
		BUCKETS.forEach(function (b) {
			coarse.appendChild(option(BUCKET_PREFIX + b, 'Any ' + b + ' stage', state.stage === BUCKET_PREFIX + b));
		});
		select.appendChild(coarse);
		groups.forEach(function (group) {
			var parent = select;
			if (groups.length > 1) {
				parent = node('optgroup');
				parent.label = group.organism;
				select.appendChild(parent);
			}
			group.stages.forEach(function (s) { parent.appendChild(option(s, s, state.stage === s)); });
		});
		select.addEventListener('change', function () {
			state.stage = select.value;
			state.limit = TOP_TERMS;
			rerender();
		});
		return select;
	}

	function metricSelect(state, rerender) {
		var select = node('select', null, 'alliance-expression-heatmap-metric');
		select.title = 'What a cell counts';
		select.setAttribute('aria-label', 'Cell value');
		METRICS.forEach(function (m) { select.appendChild(option(m.key, m.label, state.metric === m.key)); });
		select.addEventListener('change', function () {
			state.metric = select.value;
			rerender();
		});
		return select;
	}

	function summaryText(matrix, state) {
		var text = matrix.terms.length + ' anatomy terms across ' + matrix.genes.length + (matrix.genes.length === 1 ? ' gene' : ' genes');
		if (state.stage) text += ', stage ' + state.stage.replace(BUCKET_PREFIX, 'any ');
		if (matrix.hidden) text += '. ' + matrix.hidden + ' lower-ranked terms are not shown';
		return text;
	}

	function metricNote(metric) {
		var what = {
			annotations: 'Cells count expression annotation records in this mine. A term can have several records for one stage.',
			stages: 'Cells count the distinct developmental stages with an expression annotation.',
			present: 'Cells mark gene and term pairs with at least one expression annotation.'
		}[metric];
		return what + ' Terms are ranked by the number of genes annotated to them.';
	}

	function listNames(genes, max) {
		var names = genes.slice(0, max).map(function (g) { return (g.symbol || g.id) + (g.organism ? ' (' + g.organism + ')' : ''); });
		return names.join(', ') + (genes.length > max ? ' and ' + (genes.length - max) + ' more' : '');
	}

	function truncationText(data) {
		var last = data.rows[data.rows.length - 1];
		var loaded = {};
		data.rows.forEach(function (row) { loaded[row.gene] = true; });
		var missing = data.genes.filter(function (g) { return !loaded[g.id]; });
		var partial = last && data.genes.filter(function (g) { return g.id === last.gene; })[0];
		var text = 'Stopped after ' + data.rawCount + ' annotation rows, the limit.';
		if (partial) text += ' Counts for ' + listNames([partial], 1) + ' may be incomplete.';
		if (missing.length) text += ' No rows loaded for ' + listNames(missing, 20) + ' (no annotations, or cut off by the limit).';
		return text;
	}

	// data: rows, genes (the requested genes), truncated, rawCount.
	function render(el, data, navigate, context) {
		var rows = data.rows;
		var state = { stage: '', key: 'coverage', dir: 'desc', metric: 'annotations', limit: TOP_TERMS, search: '', hideRoot: false };
		var canSave = !!context && typeof context.saveList === 'function';
		var groups = stageGroups(rows);
		var hasStages = stagesOf(rows).length > 1;
		var wrap = node('div', null, 'alliance-expression-heatmap');
		var bar = node('div', null, 'alliance-expression-heatmap-bar');
		var body = node('div');
		var summary = node('p', null, 'alliance-expression-heatmap-summary');
		var status = node('p', null, 'agr-note');
		var note = node('p', null, 'agr-note');
		var withRows = {};
		rows.forEach(function (row) { withRows[row.gene] = true; });
		var empty = data.genes.filter(function (g) { return !withRows[g.id]; });

		function saver(name, ids) {
			status.textContent = 'Saving list ' + name;
			context.saveList({ name: 'Expression: ' + name, class: 'Gene', ids: ids, tags: ['expression-heatmap'] })
				.then(function (saved) { status.textContent = 'Saved list ' + saved; })
				.catch(function (err) { status.textContent = 'Could not save list: ' + ((err && err.message) || 'unknown error'); });
		}

		function rerender() {
			var matrix = buildMatrix(rows, { stage: state.stage, limit: state.limit, metric: state.metric, hideRoot: state.hideRoot, search: state.search, genes: data.genes });
			clear(body);
			summary.textContent = summaryText(matrix, state);
			note.textContent = metricNote(state.metric);
			csv.onclick = function () {
				download(toCsv(matrix.genes, sortTerms(matrix.allTerms, state.key, state.dir), true), csvFilename(state.stage));
			};
			if (!matrix.terms.length) {
				body.appendChild(node('p', 'No annotations for this selection', 'agr-empty'));
				return;
			}
			var tableWrap = node('div', null, 'agr-table-wrap');
			tableWrap.setAttribute('role', 'region');
			tableWrap.setAttribute('aria-label', 'Expression heatmap');
			tableWrap.setAttribute('tabindex', '0');
			tableWrap.appendChild(buildTable(matrix, state, rerender, navigate, canSave ? saver : null));
			body.appendChild(tableWrap);
			body.appendChild(legend(matrix.max, state.metric));
			if (matrix.hidden) {
				var more = node('button', 'Show ' + Math.min(TOP_TERMS, matrix.hidden) + ' more terms', 'agr-btn agr-btn-sm');
				more.type = 'button';
				more.addEventListener('click', function () {
					state.limit += TOP_TERMS;
					rerender();
				});
				body.appendChild(more);
			}
		}

		var csv = node('button', 'Download CSV', 'agr-btn agr-btn-sm');
		csv.type = 'button';
		if (hasStages) bar.appendChild(stageSelect(groups, state, rerender));
		bar.appendChild(metricSelect(state, rerender));
		var search = node('input', null, 'alliance-expression-heatmap-search');
		search.type = 'search';
		search.placeholder = 'Find a term';
		search.setAttribute('aria-label', 'Find an anatomy term');
		search.addEventListener('input', function () {
			state.search = search.value;
			state.limit = TOP_TERMS;
			rerender();
		});
		bar.appendChild(search);
		var hide = node('input');
		hide.type = 'checkbox';
		hide.addEventListener('change', function () {
			state.hideRoot = !!hide.checked;
			rerender();
		});
		var hideLabel = node('label', null, 'alliance-expression-heatmap-hide');
		hideLabel.appendChild(hide);
		hideLabel.appendChild(document.createTextNode(' Hide generic terms'));
		hideLabel.title = 'Hide terms ending in "anatomical entity" or "whole organism"';
		bar.appendChild(hideLabel);
		bar.appendChild(csv);
		wrap.appendChild(bar);
		wrap.appendChild(summary);
		if (data.truncated) wrap.appendChild(node('p', truncationText(data), 'agr-note'));
		if (empty.length && !data.truncated) wrap.appendChild(node('p', 'No expression annotations in this mine for ' + listNames(empty, 20) + '.', 'agr-note'));
		wrap.appendChild(body);
		wrap.appendChild(status);
		wrap.appendChild(note);
		var credit = node('p', 'Heatmap design from the ', 'agr-note');
		var link = node('a', 'Legume Information System (lis-expression-heatmap)');
		link.href = LIS_URL;
		credit.appendChild(link);
		credit.appendChild(document.createTextNode(', MIT license.'));
		wrap.appendChild(credit);
		clear(el);
		el.appendChild(wrap);
		rerender();
	}

	function wait(ms) {
		return new Promise(function (resolve) { setTimeout(resolve, ms); });
	}

	// POST a form body and parse the JSON answer. Retries 429 with doubling delays; a request that
	// takes longer than settings.timeoutMs is aborted.
	function postJson(url, body, attempt) {
		var n = attempt || 0;
		var ctl = typeof AbortController === 'function' ? new AbortController() : null;
		var timer = ctl ? setTimeout(function () { ctl.abort(); }, settings.timeoutMs) : null;
		return fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: body,
			signal: ctl ? ctl.signal : undefined
		}).then(
			function (res) {
				if (res.status === 429 && n < settings.retries) {
					clearTimeout(timer);
					return wait(settings.delayMs * Math.pow(2, n)).then(function () { return postJson(url, body, n + 1); });
				}
				if (!res.ok) {
					clearTimeout(timer);
					throw new Error('HTTP ' + res.status);
				}
				return res.json().then(function (json) {
					clearTimeout(timer);
					return json;
				});
			},
			function (err) {
				clearTimeout(timer);
				if (err && err.name === 'AbortError') throw new Error('timed out after ' + Math.round(settings.timeoutMs / 1000) + ' s');
				throw err;
			}
		);
	}

	function fetchGenes(base, ids) {
		return postJson(resultsUrl(base), geneRequestBody(ids)).then(function (json) {
			return orderGenes(((json && json.results) || []).map(toGene));
		});
	}

	function fetchPages(base, ids, onProgress) {
		var raw = [];
		function next() {
			return postJson(resultsUrl(base), requestBody(ids, raw.length)).then(function (json) {
				var page = (json && json.results) || [];
				raw = raw.concat(page);
				if (onProgress) onProgress(raw.length);
				if (page.length < settings.pageSize) return { raw: raw, truncated: false };
				if (raw.length >= settings.maxRows) return { raw: raw, truncated: true };
				return next();
			});
		}
		return next();
	}

	function fetchData(base, ids, onProgress) {
		return fetchGenes(base, ids).then(function (genes) {
			return fetchPages(base, ids, onProgress).then(function (pages) {
				return {
					genes: genes,
					rows: dedupeRows(pages.raw.map(toRow)),
					truncated: pages.truncated,
					rawCount: pages.raw.length
				};
			});
		});
	}

	function main(el, service, imEntity) {
		if (!el || !service || !imEntity) {
			throw new Error('Call main with correct signature');
		}
		// main runs again on every entity change; a response for an older entity must not overwrite the newer one.
		var token = (el.__agrHeatReq = (el.__agrHeatReq || 0) + 1);
		var navigate = arguments[5];
		var context = arguments[6];
		var gene = imEntity.Gene;
		var ids = gene && gene.value;
		var list = (Array.isArray(ids) ? ids : [ids]).filter(function (v) {
			return v !== undefined && v !== null && v !== '';
		});
		if (!list.length) {
			message(el, 'No expression annotations for this gene', 'agr-empty');
			return;
		}
		message(el, 'Loading expression heatmap', 'agr-loading');
		fetchData(serviceRoot(service.root), list, function (n) {
			if (el.__agrHeatReq === token) message(el, 'Loading expression heatmap, ' + n + ' annotation rows so far', 'agr-loading');
		})
			.then(function (data) {
				if (el.__agrHeatReq !== token) return;
				if (!data.rows.length) {
					message(el, 'No expression annotations for ' + (list.length > 1 ? 'these genes' : 'this gene'), 'agr-empty');
					return;
				}
				render(el, data, navigate, context);
			})
			.catch(function (err) {
				if (el.__agrHeatReq !== token) return;
				message(el, 'Could not load expression annotations from the mine' + (err && err.message ? ' (' + err.message + ')' : ''), 'agr-error');
			});
	}

	var api = {
		main: main,
		settings: settings,
		serviceRoot: serviceRoot,
		buildQuery: buildQuery,
		buildGeneQuery: buildGeneQuery,
		resultsUrl: resultsUrl,
		requestBody: requestBody,
		geneRequestBody: geneRequestBody,
		escapeXml: escapeXml,
		toRow: toRow,
		toGene: toGene,
		dedupeRows: dedupeRows,
		stagesOf: stagesOf,
		stageGroups: stageGroups,
		buildMatrix: buildMatrix,
		rankTerms: rankTerms,
		sortTerms: sortTerms,
		binEdges: binEdges,
		level: level,
		toCsv: toCsv,
		csvFilename: csvFilename,
		postJson: postJson,
		fetchData: fetchData,
		render: render
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceExpressionHeatmap = api;
})(typeof window !== 'undefined' ? window : globalThis);
