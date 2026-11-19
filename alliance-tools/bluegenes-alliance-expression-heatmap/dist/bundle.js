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

	var MAX_ROWS = 20000;
	var TOP_TERMS = 40;
	var NO_ANATOMY = 'Unspecified anatomy';
	var NO_STAGE = 'Unspecified stage';
	var VIEW = [
		'Gene.primaryIdentifier',
		'Gene.symbol',
		'Gene.expressionAnnotations.id',
		'Gene.expressionAnnotations.anatomy.name',
		'Gene.expressionAnnotations.anatomy.identifier',
		'Gene.expressionAnnotations.stageTerm',
		'Gene.id'
	];

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

	// ids is one internal Gene.id or an array of them.
	function buildQuery(ids) {
		var list = (Array.isArray(ids) ? ids : [ids]).map(String);
		var constraint =
			list.length === 1
				? '<constraint path="Gene.id" op="=" value="' + escapeXml(list[0]) + '"/>'
				: '<constraint path="Gene.id" op="ONE OF">' +
					list.map(function (v) { return '<value>' + escapeXml(v) + '</value>'; }).join('') +
					'</constraint>';
		return '<query model="genomic" view="' + VIEW.join(' ') + '">' + constraint + '</query>';
	}

	function resultsUrl(base) {
		return base.replace(/\/+$/, '') + '/query/results';
	}

	// The id list goes in a POST body: a GET query string fails above about 250 ids.
	function requestBody(ids) {
		return 'format=json&size=' + MAX_ROWS + '&query=' + encodeURIComponent(buildQuery(ids));
	}

	function toRow(r) {
		return {
			gene: r[0],
			symbol: r[1],
			annotation: r[2],
			anatomy: r[3],
			anatomyId: r[4],
			stage: r[5],
			geneId: r[6]
		};
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

	// Distinct stages in alphabetical order, with the missing-stage label last.
	function stagesOf(rows) {
		var seen = {};
		rows.forEach(function (row) { seen[stageOf(row)] = true; });
		var names = Object.keys(seen).filter(function (s) { return s !== NO_STAGE; }).sort(cmp);
		if (seen[NO_STAGE]) names.push(NO_STAGE);
		return names;
	}

	function genesOf(rows) {
		var seen = {};
		var genes = [];
		rows.forEach(function (row) {
			if (seen[row.gene]) return;
			seen[row.gene] = true;
			genes.push({ id: row.gene, symbol: row.symbol || null, internalId: row.geneId });
		});
		return genes;
	}

	function countTerms(rows) {
		var by = {};
		rows.forEach(function (row) {
			var name = row.anatomy || NO_ANATOMY;
			var key = (row.anatomyId || '') + '|' + name;
			var term = by[key] || (by[key] = { key: key, name: name, identifier: row.anatomyId || '', counts: {}, total: 0, coverage: 0 });
			if (!term.counts[row.gene]) term.coverage++;
			term.counts[row.gene] = (term.counts[row.gene] || 0) + 1;
			term.total++;
		});
		return Object.keys(by).map(function (k) { return by[k]; });
	}

	// Most genes first, then most annotations, then name.
	function rankTerms(terms) {
		return terms.slice().sort(function (a, b) {
			return b.coverage - a.coverage || b.total - a.total || cmp(a.name, b.name) || cmp(a.identifier, b.identifier);
		});
	}

	// opts: stage (a stage label, empty for all) and limit (default 40 terms).
	function buildMatrix(rows, opts) {
		var o = opts || {};
		var limit = o.limit || TOP_TERMS;
		var kept = o.stage
			? rows.filter(function (row) { return stageOf(row) === o.stage; })
			: rows;
		var ranked = rankTerms(countTerms(kept));
		var terms = ranked.slice(0, limit);
		var max = 0;
		terms.forEach(function (t) {
			Object.keys(t.counts).forEach(function (g) { max = Math.max(max, t.counts[g]); });
		});
		return { genes: genesOf(rows), terms: terms, hidden: ranked.length - terms.length, max: max };
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

	function csvCell(value) {
		var s = String(value == null ? '' : value);
		if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
		return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
	}

	function geneLabel(gene, bySymbol) {
		return bySymbol && gene.symbol ? gene.symbol : gene.id;
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

	function level(count, max) {
		if (!count) return 0;
		return Math.min(4, Math.ceil((count / max) * 4));
	}

	function download(text, filename) {
		var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
		var a = node('a');
		a.href = URL.createObjectURL(blob);
		a.download = filename;
		a.click();
		URL.revokeObjectURL(a.href);
	}

	function sortHeader(label, key, state, rerender, className) {
		var th = node('th', null, className);
		var active = state.key === key;
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
		th.title = gene.id;
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

	function cellFor(term, gene, max) {
		var count = term.counts[gene.id] || 0;
		var td = node('td', count || '', 'alliance-expression-heatmap-cell alliance-expression-heatmap-l' + level(count, max));
		td.title = term.name + ' in ' + (gene.symbol || gene.id) + ': ' + count + (count === 1 ? ' annotation' : ' annotations');
		return td;
	}

	function termRow(term, matrix) {
		var tr = node('tr');
		var th = node('th', term.name, 'alliance-expression-heatmap-term');
		th.title = term.identifier;
		tr.appendChild(th);
		matrix.genes.forEach(function (gene) { tr.appendChild(cellFor(term, gene, matrix.max)); });
		tr.appendChild(node('td', term.coverage, 'num'));
		tr.appendChild(node('td', term.total, 'num'));
		return tr;
	}

	function buildTable(matrix, state, rerender, navigate) {
		var table = node('table', null, 'agr-table agr-table-sm alliance-expression-heatmap-grid');
		var headRow = node('tr');
		headRow.appendChild(sortHeader('Anatomy term', 'name', state, rerender));
		matrix.genes.forEach(function (g) { headRow.appendChild(geneHeader(g, state, rerender, navigate)); });
		headRow.appendChild(sortHeader('Genes', 'coverage', state, rerender));
		headRow.appendChild(sortHeader('Total', 'total', state, rerender));
		var thead = node('thead');
		thead.appendChild(headRow);
		table.appendChild(thead);
		var tbody = node('tbody');
		sortTerms(matrix.terms, state.key, state.dir).forEach(function (t) { tbody.appendChild(termRow(t, matrix)); });
		table.appendChild(tbody);
		return table;
	}

	function stageSelect(stages, state, rerender) {
		var select = node('select', null, 'alliance-expression-heatmap-stage');
		select.title = 'Filter by developmental stage';
		[''].concat(stages).forEach(function (s) {
			var opt = node('option', s || 'All stages');
			opt.value = s;
			opt.selected = s === state.stage;
			select.appendChild(opt);
		});
		select.addEventListener('change', function () {
			state.stage = select.value;
			rerender();
		});
		return select;
	}

	function summaryText(matrix, state) {
		var text = matrix.terms.length + ' anatomy terms across ' + matrix.genes.length + (matrix.genes.length === 1 ? ' gene' : ' genes');
		if (state.stage) text += ', stage ' + state.stage;
		if (matrix.hidden) text += '. ' + matrix.hidden + ' lower-ranked terms are not shown';
		return text;
	}

	function render(el, rows, navigate, truncated) {
		var state = { stage: '', key: 'coverage', dir: 'desc' };
		var stages = stagesOf(rows);
		var wrap = node('div', null, 'alliance-expression-heatmap');
		var bar = node('div', null, 'alliance-expression-heatmap-bar');
		var body = node('div');
		var summary = node('p', null, 'alliance-expression-heatmap-summary');

		function rerender() {
			var matrix = buildMatrix(rows, { stage: state.stage, limit: TOP_TERMS });
			clear(body);
			summary.textContent = summaryText(matrix, state);
			if (!matrix.terms.length) {
				body.appendChild(node('p', 'No annotations for this stage', 'agr-empty'));
				return;
			}
			var tableWrap = node('div', null, 'agr-table-wrap');
			tableWrap.appendChild(buildTable(matrix, state, rerender, navigate));
			body.appendChild(tableWrap);
			csv.onclick = function () {
				download(toCsv(matrix.genes, sortTerms(matrix.terms, state.key, state.dir), true), 'expression-heatmap.csv');
			};
		}

		var csv = node('button', 'Download CSV', 'agr-btn agr-btn-sm');
		csv.type = 'button';
		if (stages.length > 1) bar.appendChild(stageSelect(stages, state, rerender));
		bar.appendChild(csv);
		wrap.appendChild(bar);
		wrap.appendChild(summary);
		if (truncated) wrap.appendChild(node('p', 'Showing annotations from the first ' + MAX_ROWS + ' result rows.', 'agr-note'));
		wrap.appendChild(body);
		wrap.appendChild(node('p', 'Cells count expression annotations in this mine. Terms are ranked by the number of genes annotated to them.', 'agr-note'));
		clear(el);
		el.appendChild(wrap);
		rerender();
	}

	function fetchRows(base, ids) {
		return fetch(resultsUrl(base), {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: requestBody(ids)
		})
			.then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status);
				return res.json();
			})
			.then(function (json) {
				var raw = (json && json.results) || [];
				return { rows: dedupeRows(raw.map(toRow)), truncated: raw.length >= MAX_ROWS };
			});
	}

	function main(el, service, imEntity) {
		if (!el || !service || !imEntity) {
			throw new Error('Call main with correct signature');
		}
		// main runs again on every entity change; a response for an older entity must not overwrite the newer one.
		var token = (el.__agrHeatReq = (el.__agrHeatReq || 0) + 1);
		var navigate = arguments[5];
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
		fetchRows(serviceRoot(service.root), list)
			.then(function (result) {
				if (el.__agrHeatReq !== token) return;
				if (!result.rows.length) {
					message(el, 'No expression annotations for ' + (list.length > 1 ? 'these genes' : 'this gene'), 'agr-empty');
					return;
				}
				render(el, result.rows, navigate, result.truncated);
			})
			.catch(function () {
				if (el.__agrHeatReq !== token) return;
				message(el, 'Could not load expression annotations from the mine', 'agr-error');
			});
	}

	var api = {
		main: main,
		serviceRoot: serviceRoot,
		buildQuery: buildQuery,
		resultsUrl: resultsUrl,
		requestBody: requestBody,
		escapeXml: escapeXml,
		toRow: toRow,
		dedupeRows: dedupeRows,
		stagesOf: stagesOf,
		buildMatrix: buildMatrix,
		rankTerms: rankTerms,
		sortTerms: sortTerms,
		toCsv: toCsv,
		render: render
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceExpressionHeatmap = api;
})(typeof window !== 'undefined' ? window : globalThis);
