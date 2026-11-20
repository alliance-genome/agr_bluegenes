/*
 * Disease slim matrix, a BlueGenes tool (tool API version 2).
 * Plain JavaScript without dependencies, so this file is both the source and
 * the bundle. BlueGenes loads it as a script and calls
 * bluegenesAllianceDiseaseMatrix.main(el, service, entity, state, config, navigate, context).
 */
(function (root) {
	'use strict';

	var MAX_ROWS = 50000;
	var NO_SLIM = '(no slim term)';
	var NO_VALUE = '(none)';
	var TOTAL = '\u0000total';
	var PUBMED_URL = 'https://pubmed.ncbi.nlm.nih.gov/';
	var VIEW = [
		'Gene.id',
		'Gene.primaryIdentifier',
		'Gene.symbol',
		'Gene.diseaseAnnotation.id',
		'Gene.diseaseAnnotation.ontologyTerm.name',
		'Gene.diseaseAnnotation.slimTerms.name',
		'Gene.diseaseAnnotation.evidenceType',
		'Gene.diseaseAnnotation.viaOrthologyOrder',
		'Gene.diseaseAnnotation.qualifier',
		'Gene.diseaseAnnotation.evidence.code.code',
		'Gene.diseaseAnnotation.evidence.publications.pubMedId'
	];
	var OUTER_JOINS = [
		'Gene.diseaseAnnotation.slimTerms',
		'Gene.diseaseAnnotation.evidence',
		'Gene.diseaseAnnotation.evidence.code',
		'Gene.diseaseAnnotation.evidence.publications'
	];

	// BlueGenes passes the mine root (for example https://host/mine); the web
	// services live under /service. Accept either form.
	function count(n, word) {
		return n + ' ' + word + (n === 1 ? '' : 's');
	}

	function serviceRoot(rootUrl) {
		var r = String(rootUrl || '').replace(/\/+$/, '');
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
		var joins = OUTER_JOINS.map(function (p) { return '<join path="' + p + '" style="OUTER"/>'; }).join('');
		return '<query model="genomic" view="' + VIEW.join(' ') + '" sortOrder="Gene.symbol asc">' + joins + constraint + '</query>';
	}

	// The id list goes in a POST body: a GET query string fails above about 250 ids.
	function requestBody(ids) {
		return 'format=json&size=' + MAX_ROWS + '&query=' + encodeURIComponent(buildQuery(ids));
	}

	function addUnique(list, value) {
		if (value !== null && value !== undefined && value !== '' && list.indexOf(value) === -1) list.push(value);
	}

	function newAnnotation(r) {
		return {
			id: r[3], geneId: r[0], identifier: r[1], symbol: r[2] || r[1], term: r[4],
			slims: [], evidenceType: r[6], via: r[7], qualifier: r[8], codes: [], pmids: []
		};
	}

	// Rows repeat once per slim term, evidence code and publication of an annotation. Returns one record per annotation id.
	function toAnnotations(rows) {
		var byId = {};
		var out = [];
		rows.forEach(function (r) {
			if (r[3] === null || r[3] === undefined) return;
			var a = byId[r[3]];
			if (!a) {
				a = byId[r[3]] = newAnnotation(r);
				out.push(a);
			}
			addUnique(a.slims, r[5]);
			addUnique(a.codes, r[9]);
			addUnique(a.pmids, r[10]);
		});
		return out;
	}

	// An annotation comes from an ortholog when it has an orthology order or its qualifier says so.
	function isViaOrthology(a) {
		return (a.via !== null && a.via !== undefined) || /via_orthology/.test(a.qualifier || '');
	}

	function evidenceKey(a) {
		return a.evidenceType || NO_VALUE;
	}

	function evidenceTypes(annotations) {
		var seen = [];
		annotations.forEach(function (a) { addUnique(seen, evidenceKey(a)); });
		return seen.sort(function (a, b) {
			return a === NO_VALUE ? 1 : b === NO_VALUE ? -1 : cmp(a, b);
		});
	}

	// filters: {evidenceType: '' for all, via: 'all' | 'only' | 'exclude'}.
	function filterAnnotations(annotations, filters) {
		return annotations.filter(function (a) {
			if (filters.evidenceType && evidenceKey(a) !== filters.evidenceType) return false;
			if (filters.via === 'only') return isViaOrthology(a);
			if (filters.via === 'exclude') return !isViaOrthology(a);
			return true;
		});
	}

	function cmp(a, b) {
		a = a == null ? '' : String(a);
		b = b == null ? '' : String(b);
		return a < b ? -1 : a > b ? 1 : 0;
	}

	function slimsOf(a) {
		return a.slims.length ? a.slims : [NO_SLIM];
	}

	function newRow(a) {
		return { geneId: a.geneId, identifier: a.identifier, symbol: a.symbol, total: 0, cells: {} };
	}

	function addToColumn(cols, slim, a) {
		var c = cols[slim] || (cols[slim] = { slim: slim, count: 0, genes: [], geneIds: {} });
		c.count++;
		if (!c.geneIds[a.geneId]) {
			c.geneIds[a.geneId] = true;
			c.genes.push({ id: a.geneId, symbol: a.symbol });
		}
	}

	// Returns {rows: [{geneId, identifier, symbol, total, cells: {slim: [annotation]}}], cols: [{slim, count, genes}]}.
	// An annotation with several slim terms is counted once in each of its columns and once in the row total.
	function pivot(annotations) {
		var rows = {};
		var cols = {};
		annotations.forEach(function (a) {
			var row = rows[a.geneId] || (rows[a.geneId] = newRow(a));
			row.total++;
			slimsOf(a).forEach(function (slim) {
				(row.cells[slim] = row.cells[slim] || []).push(a);
				addToColumn(cols, slim, a);
			});
		});
		return {
			rows: sortRows(Object.keys(rows).map(function (k) { return rows[k]; }), 'symbol', 1),
			cols: sortCols(Object.keys(cols).map(function (k) { return cols[k]; }), 'name')
		};
	}

	function cellCount(row, key) {
		return key === TOTAL ? row.total : (row.cells[key] || []).length;
	}

	// key is 'symbol', TOTAL or a slim term. dir is 1 for ascending, -1 for descending.
	function sortRows(rows, key, dir) {
		return rows.slice().sort(function (a, b) {
			var d = key === 'symbol' ? cmp(a.symbol, b.symbol) : cellCount(a, key) - cellCount(b, key);
			return dir * d || cmp(a.symbol, b.symbol) || cmp(a.identifier, b.identifier);
		});
	}

	// by is 'name' or 'count'. The column without a slim term stays last.
	function sortCols(cols, by) {
		return cols.slice().sort(function (a, b) {
			if (a.slim === NO_SLIM || b.slim === NO_SLIM) return a.slim === NO_SLIM ? 1 : -1;
			return (by === 'count' ? b.count - a.count : 0) || cmp(a.slim, b.slim);
		});
	}

	function csvField(v) {
		var s = String(v == null ? '' : v);
		return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
	}

	function toCsv(rows, cols) {
		var lines = [['Gene', 'Identifier', 'Total'].concat(cols.map(function (c) { return c.slim; }))];
		rows.forEach(function (r) {
			lines.push([r.symbol, r.identifier, r.total].concat(cols.map(function (c) { return cellCount(r, c.slim); })));
		});
		return lines.map(function (l) { return l.map(csvField).join(','); }).join('\r\n') + '\r\n';
	}

	function cellDetails(row, slim) {
		return (row.cells[slim] || []).map(function (a) {
			return { term: a.term, qualifier: a.qualifier, codes: a.codes, pmids: a.pmids };
		});
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
		var wrap = node('div', null, 'alliance-disease-matrix');
		wrap.appendChild(node('p', text, cls));
		el.appendChild(wrap);
	}

	function button(label, onClick, className) {
		var b = node('button', label, className || 'agr-button');
		b.type = 'button';
		b.addEventListener('click', function (ev) {
			if (ev && ev.preventDefault) ev.preventDefault();
			onClick();
		});
		return b;
	}

	function select(options, value, onChange) {
		var s = node('select');
		options.forEach(function (o) {
			var opt = node('option', o.label);
			opt.value = o.value;
			s.appendChild(opt);
		});
		s.value = value;
		s.addEventListener('change', function () { onChange(s.value); });
		return s;
	}

	function labelled(text, control) {
		var l = node('label', text + ' ', 'agr-control');
		l.appendChild(control);
		return l;
	}

	function pmidLink(pmid) {
		var a = node('a', pmid);
		a.href = PUBMED_URL + encodeURIComponent(pmid) + '/';
		a.target = '_blank';
		a.rel = 'noopener';
		return a;
	}

	function pmidList(pmids) {
		var span = node('span');
		pmids.forEach(function (p, i) {
			if (i) span.appendChild(document.createTextNode(', '));
			span.appendChild(pmidLink(p));
		});
		return span;
	}

	function detailItem(d) {
		var li = node('li');
		li.appendChild(node('strong', d.term || 'Unnamed term'));
		li.appendChild(node('span', ' ' + (d.qualifier || 'no qualifier'), 'agr-note'));
		li.appendChild(node('div', 'Evidence codes: ' + (d.codes.length ? d.codes.join(', ') : 'none')));
		var pubs = node('div', 'PMIDs: ');
		if (d.pmids.length) pubs.appendChild(pmidList(d.pmids));
		else pubs.appendChild(document.createTextNode('none'));
		li.appendChild(pubs);
		return li;
	}

	function popover(row, slim, onClose) {
		var box = node('div', null, 'agr-popover');
		box.appendChild(node('h4', row.symbol + ' / ' + slim));
		var ul = node('ul');
		cellDetails(row, slim).forEach(function (d) { ul.appendChild(detailItem(d)); });
		box.appendChild(ul);
		box.appendChild(button('Close', onClose));
		return box;
	}

	function download(text, filename) {
		var url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
		var a = document.createElement('a');
		a.href = url;
		a.download = filename;
		a.click();
		URL.revokeObjectURL(url);
	}

	function saveColumn(col, context, ui) {
		var ids = col.genes.map(function (g) { return g.id; });
		ui.status('Saving ' + count(ids.length, 'gene'));
		context
			.saveList({ name: 'Disease slim ' + col.slim + ' genes', class: 'Gene', ids: ids, tags: ['alliance', 'disease-matrix'] })
			.then(function (name) { ui.status('Saved list ' + name); })
			.catch(function (err) { ui.status(err && err.message === 'login required' ? 'Log in to save a list' : 'Could not save the list'); });
	}

	function headerCell(col, ui) {
		var th = node('th');
		th.appendChild(button(col.slim, function () { ui.sortBy(col.slim); }, 'agr-sort'));
		if (ui.context && typeof ui.context.saveList === 'function') {
			th.appendChild(button('Save genes (' + col.genes.length + ')', function () { saveColumn(col, ui.context, ui); }, 'agr-save'));
		}
		return th;
	}

	function headRow(cols, ui) {
		var tr = node('tr');
		var gene = node('th');
		gene.appendChild(button('Gene', function () { ui.sortBy('symbol'); }, 'agr-sort'));
		var total = node('th');
		total.appendChild(button('Total', function () { ui.sortBy(TOTAL); }, 'agr-sort'));
		tr.appendChild(gene);
		tr.appendChild(total);
		cols.forEach(function (c) { tr.appendChild(headerCell(c, ui)); });
		return tr;
	}

	function bodyRow(row, cols, ui) {
		var tr = node('tr');
		tr.appendChild(node('td', row.symbol));
		tr.appendChild(node('td', row.total, 'num'));
		cols.forEach(function (c) {
			var n = cellCount(row, c.slim);
			var td = node('td', null, 'num');
			if (n) td.appendChild(button(n, function () { ui.open(row, c.slim); }, 'agr-cell'));
			tr.appendChild(td);
		});
		return tr;
	}

	function table(rows, cols, ui) {
		var t = node('table', null, 'agr-table agr-table-sm');
		var thead = node('thead');
		thead.appendChild(headRow(cols, ui));
		t.appendChild(thead);
		var tbody = node('tbody');
		rows.forEach(function (r) { tbody.appendChild(bodyRow(r, cols, ui)); });
		t.appendChild(tbody);
		var wrap = node('div', null, 'agr-table-wrap');
		wrap.appendChild(t);
		return wrap;
	}

	function controls(model, ui) {
		var bar = node('div', null, 'agr-controls');
		var types = [{ value: '', label: 'All' }].concat(evidenceTypes(model.annotations).map(function (t) { return { value: t, label: t }; }));
		bar.appendChild(labelled('Evidence type', select(types, model.filters.evidenceType, function (v) { ui.filter('evidenceType', v); })));
		var via = [
			{ value: 'all', label: 'All annotations' },
			{ value: 'only', label: 'Via orthology only' },
			{ value: 'exclude', label: 'Exclude via orthology' }
		];
		bar.appendChild(labelled('Orthology', select(via, model.filters.via, function (v) { ui.filter('via', v); })));
		var colSorts = [{ value: 'name', label: 'Name' }, { value: 'count', label: 'Annotation count' }];
		bar.appendChild(labelled('Sort columns', select(colSorts, model.colSort, ui.sortCols)));
		bar.appendChild(button('Export CSV', ui.exportCsv));
		return bar;
	}

	function summary(rows, cols, shown) {
		return rows.length + ' genes, ' + cols.length + ' slim terms, ' + shown + ' annotations.';
	}

	function render(el, model, ui) {
		clear(el);
		var wrap = node('div', null, 'alliance-disease-matrix');
		wrap.appendChild(controls(model, ui));
		var view = viewOf(model);
		wrap.appendChild(node('p', summary(view.rows, view.cols, view.shown), 'alliance-disease-matrix-summary'));
		if (model.truncated) wrap.appendChild(node('p', 'Showing the first ' + MAX_ROWS + ' rows of results.', 'agr-note'));
		if (model.status) wrap.appendChild(node('p', model.status, 'agr-note'));
		if (!view.rows.length) wrap.appendChild(node('p', 'No disease annotations match', 'agr-empty'));
		else wrap.appendChild(table(view.rows, view.cols, ui));
		if (model.opened) wrap.appendChild(popover(model.opened.row, model.opened.slim, ui.close));
		wrap.appendChild(node('p', 'Counts are disease annotations per gene and Disease Ontology slim term. An annotation with several slim terms counts in each. Annotations without a slim term are listed under ' + NO_SLIM + '.', 'agr-note'));
		el.appendChild(wrap);
	}

	function viewOf(model) {
		var shown = filterAnnotations(model.annotations, model.filters);
		var p = pivot(shown);
		return {
			rows: sortRows(p.rows, model.rowSort.key, model.rowSort.dir),
			cols: sortCols(p.cols, model.colSort),
			shown: shown.length
		};
	}

	function makeUi(el, model, context) {
		var ui = { context: context };
		function redraw() { render(el, model, ui); }
		ui.sortBy = function (key) {
			var same = model.rowSort.key === key;
			model.rowSort = { key: key, dir: same ? -model.rowSort.dir : key === 'symbol' ? 1 : -1 };
			redraw();
		};
		ui.sortCols = function (by) { model.colSort = by; redraw(); };
		ui.filter = function (name, value) { model.filters[name] = value; model.opened = null; redraw(); };
		ui.open = function (row, slim) { model.opened = { row: row, slim: slim }; redraw(); };
		ui.close = function () { model.opened = null; redraw(); };
		ui.status = function (text) { model.status = text; redraw(); };
		ui.exportCsv = function () {
			var v = viewOf(model);
			download(toCsv(v.rows, v.cols), 'disease-matrix.csv');
		};
		return ui;
	}

	function fetchAnnotations(rootUrl, ids) {
		return fetch(serviceRoot(rootUrl) + '/query/results', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: requestBody(ids)
		})
			.then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status);
				return res.json();
			})
			.then(function (json) {
				var rows = (json && json.results) || [];
				return { annotations: toAnnotations(rows), truncated: rows.length >= MAX_ROWS };
			});
	}

	function idList(entity) {
		var ids = entity.Gene && entity.Gene.value;
		return (Array.isArray(ids) ? ids : [ids]).filter(function (v) {
			return v !== undefined && v !== null && v !== '';
		});
	}

	function main(el, service, imEntity, state, config, navigate, context) {
		if (!el || !service || !imEntity) {
			throw new Error('Call main with correct signature');
		}
		// main runs again on every entity change; a response for an older entity must not overwrite the newer one.
		var token = (el.__agrDiseaseMatrixReq = (el.__agrDiseaseMatrixReq || 0) + 1);
		var ids = idList(imEntity);
		if (!ids.length) {
			message(el, 'No disease annotations for this gene', 'agr-empty');
			return;
		}
		message(el, 'Loading disease annotations', 'agr-loading');
		fetchAnnotations(service.root, ids)
			.then(function (data) {
				if (el.__agrDiseaseMatrixReq !== token) return;
				var model = {
					annotations: data.annotations, truncated: data.truncated, filters: { evidenceType: '', via: 'all' },
					rowSort: { key: 'symbol', dir: 1 }, colSort: 'name', opened: null, status: ''
				};
				render(el, model, makeUi(el, model, context));
			})
			.catch(function () {
				if (el.__agrDiseaseMatrixReq !== token) return;
				message(el, 'Could not load disease annotations from the mine', 'agr-error');
			});
	}

	var api = {
		main: main, serviceRoot: serviceRoot, buildQuery: buildQuery, requestBody: requestBody,
		toAnnotations: toAnnotations, isViaOrthology: isViaOrthology, evidenceTypes: evidenceTypes,
		filterAnnotations: filterAnnotations, pivot: pivot, sortRows: sortRows, sortCols: sortCols,
		toCsv: toCsv, cellDetails: cellDetails, render: render, makeUi: makeUi,
		NO_SLIM: NO_SLIM, NO_VALUE: NO_VALUE, TOTAL: TOTAL
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceDiseaseMatrix = api;
})(typeof window !== 'undefined' ? window : globalThis);
