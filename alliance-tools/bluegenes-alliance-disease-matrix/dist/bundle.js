/*
 * Disease slim matrix, a BlueGenes tool (tool API version 2).
 * Plain JavaScript without dependencies, so this file is both the source and
 * the bundle. BlueGenes loads it as a script and calls
 * bluegenesAllianceDiseaseMatrix.main(el, service, entity, state, config, navigate, context).
 */
(function (root) {
	'use strict';

	var MAX_ROWS = 50000;
	var GENE_CHUNK = 100;
	var TERM_CHUNK = 150;
	var ROW_PAGE = 200;
	var TIMEOUT_MS = 30000;
	var MAX_RETRIES = 3;
	var BACKOFF_MS = 1000;
	var NO_SLIM = '(no slim term)';
	var NO_VALUE = '(none)';
	var TOTAL = '\u0000total';
	var PUBMED_URL = 'https://pubmed.ncbi.nlm.nih.gov/';
	var DISEASE_URL = 'https://www.alliancegenome.org/disease/';
	var MOSTLY_UNSLIMMED = 0.9;
	// Disease Ontology terms used as matrix columns. DiseaseAnnotation.slimTerms is empty for genes in AllianceMine, so an annotation joins the column of every term here that is its disease term or one of its ancestors (DOTerm.parents).
	var SLIMS = [
		['DOID:162', 'cancer'],
		['DOID:1287', 'cardiovascular system disease'],
		['DOID:28', 'endocrine system disease'],
		['DOID:77', 'gastrointestinal system disease'],
		['DOID:630', 'genetic disease'],
		['DOID:74', 'hematopoietic system disease'],
		['DOID:2914', 'immune system disease'],
		['DOID:0050117', 'disease by infectious agent'],
		['DOID:16', 'integumentary system disease'],
		['DOID:0014667', 'disease of metabolism'],
		['DOID:150', 'disease of mental health'],
		['DOID:17', 'musculoskeletal system disease'],
		['DOID:863', 'nervous system disease'],
		['DOID:15', 'reproductive system disease'],
		['DOID:1579', 'respiratory system disease'],
		['DOID:18', 'urinary system disease']
	];
	var VIEW = [
		'Gene.id',
		'Gene.primaryIdentifier',
		'Gene.symbol',
		'Gene.organism.shortName',
		'Gene.diseaseAnnotation.id',
		'Gene.diseaseAnnotation.ontologyTerm.identifier',
		'Gene.diseaseAnnotation.ontologyTerm.name',
		'Gene.diseaseAnnotation.qualifier',
		'Gene.diseaseAnnotation.evidence.code.code',
		'Gene.diseaseAnnotation.evidence.publications.pubMedId'
	];
	var OUTER_JOINS = [
		'Gene.diseaseAnnotation.evidence',
		'Gene.diseaseAnnotation.evidence.code',
		'Gene.diseaseAnnotation.evidence.publications'
	];
	var PARENT_VIEW = ['DOTerm.identifier', 'DOTerm.parents.identifier', 'DOTerm.parents.name'];

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

	function idConstraint(path, ids) {
		var list = (Array.isArray(ids) ? ids : [ids]).map(String);
		return list.length === 1
			? '<constraint path="' + path + '" op="=" value="' + escapeXml(list[0]) + '"/>'
			: '<constraint path="' + path + '" op="ONE OF">' +
				list.map(function (v) { return '<value>' + escapeXml(v) + '</value>'; }).join('') +
				'</constraint>';
	}

	// ids is one internal Gene.id or an array of them.
	function buildQuery(ids) {
		var joins = OUTER_JOINS.map(function (p) { return '<join path="' + p + '" style="OUTER"/>'; }).join('');
		return '<query model="genomic" view="' + VIEW.join(' ') + '" sortOrder="Gene.symbol asc">' + joins + idConstraint('Gene.id', ids) + '</query>';
	}

	// Ancestors of disease terms, one row per term and parent. Run apart from buildQuery because joining parents multiplies rows about tenfold.
	function buildParentsQuery(termIds) {
		return '<query model="genomic" view="' + PARENT_VIEW.join(' ') + '" sortOrder="DOTerm.identifier asc"><join path="DOTerm.parents" style="OUTER"/>' + idConstraint('DOTerm.identifier', termIds) + '</query>';
	}

	// The id list goes in a POST body: a GET query string fails above about 250 ids.
	function requestBody(query) {
		return 'format=json&size=' + MAX_ROWS + '&query=' + encodeURIComponent(query);
	}

	function addUnique(list, value) {
		if (value !== null && value !== undefined && value !== '' && list.indexOf(value) === -1) list.push(value);
	}

	function isNegated(qualifier) {
		return /^is_not_|^not_/.test(qualifier || '');
	}

	function newAnnotation(r) {
		return {
			id: r[4], geneId: r[0], identifier: r[1], symbol: r[2] || r[1], organism: r[3] || '', termId: r[5], term: r[6],
			slims: [], qualifier: r[7], negated: isNegated(r[7]), codes: [], pmids: []
		};
	}

	// Rows repeat once per evidence code and publication of an annotation. Returns one record per annotation id.
	function toAnnotations(rows) {
		var byId = {};
		var out = [];
		rows.forEach(function (r) {
			if (r[4] === null || r[4] === undefined) return;
			var a = byId[r[4]];
			if (!a) {
				a = byId[r[4]] = newAnnotation(r);
				out.push(a);
			}
			addUnique(a.codes, r[8]);
			addUnique(a.pmids, r[9]);
		});
		return out;
	}

	// parentRows: [term id, parent id, parent name] from buildParentsQuery. Sets the slim terms of each annotation.
	function applySlims(annotations, parentRows) {
		var ancestors = {};
		parentRows.forEach(function (r) {
			var list = ancestors[r[0]] || (ancestors[r[0]] = []);
			addUnique(list, r[1]);
		});
		annotations.forEach(function (a) {
			var up = ancestors[a.termId] || [];
			a.slims = SLIMS.filter(function (s) { return s[0] === a.termId || up.indexOf(s[0]) !== -1; })
				.map(function (s) { return s[1]; });
		});
		return annotations;
	}

	// The qualifier names an annotation inferred from an ortholog.
	function isViaOrthology(a) {
		return /via_orthology/.test(a.qualifier || '');
	}

	function codeKeys(a) {
		return a.codes.length ? a.codes : [NO_VALUE];
	}

	function evidenceCodes(annotations) {
		var seen = [];
		annotations.forEach(function (a) { codeKeys(a).forEach(function (c) { addUnique(seen, c); }); });
		return seen.sort(function (a, b) {
			return a === NO_VALUE ? 1 : b === NO_VALUE ? -1 : cmp(a, b);
		});
	}

	function organisms(annotations) {
		var seen = [];
		annotations.forEach(function (a) { addUnique(seen, a.organism); });
		return seen.sort(cmp);
	}

	function newFilters() {
		return { code: '', via: 'all', organism: '', negated: false };
	}

	// filters: {code: '' for all, via: 'all' | 'only' | 'exclude', organism: '' for all, negated: true to keep is_not_* annotations}.
	function filterAnnotations(annotations, filters) {
		return annotations.filter(function (a) {
			if (a.negated && !filters.negated) return false;
			if (filters.organism && a.organism !== filters.organism) return false;
			if (filters.code && codeKeys(a).indexOf(filters.code) === -1) return false;
			if (filters.via === 'only') return isViaOrthology(a);
			if (filters.via === 'exclude') return !isViaOrthology(a);
			return true;
		});
	}

	function filterParts(filters) {
		var parts = [];
		if (filters.organism) parts.push(filters.organism);
		if (filters.code) parts.push('code ' + filters.code);
		if (filters.via === 'only') parts.push('orthology only');
		if (filters.via === 'exclude') parts.push('no orthology');
		if (filters.negated) parts.push('with negated');
		return parts;
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
		return { geneId: a.geneId, identifier: a.identifier, symbol: a.symbol, organism: a.organism, total: 0, cells: {} };
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

	function csvText(lines) {
		return lines.map(function (l) { return l.map(csvField).join(','); }).join('\r\n') + '\r\n';
	}

	function toCsv(rows, cols) {
		var lines = [['Gene', 'Identifier', 'Species', 'Total'].concat(cols.map(function (c) { return c.slim; }))];
		rows.forEach(function (r) {
			lines.push([r.symbol, r.identifier, r.organism, r.total].concat(cols.map(function (c) { return cellCount(r, c.slim); })));
		});
		return csvText(lines);
	}

	// One line per annotation with its term, qualifier, evidence codes and PMIDs.
	function toLongCsv(annotations) {
		var lines = [['Gene', 'Identifier', 'Species', 'Disease term', 'DOID', 'Slim terms', 'Qualifier', 'Evidence codes', 'PMIDs']];
		annotations.slice().sort(function (a, b) {
			return cmp(a.symbol, b.symbol) || cmp(a.identifier, b.identifier) || cmp(a.term, b.term) || cmp(a.id, b.id);
		}).forEach(function (a) {
			lines.push([a.symbol, a.identifier, a.organism, a.term, a.termId, a.slims.join('; '), a.qualifier, a.codes.join('; '), a.pmids.join('; ')]);
		});
		return csvText(lines);
	}

	// Excel reads a CSV as the local code page unless it starts with a byte order mark.
	function withBom(text) {
		return '\ufeff' + text;
	}

	function slug(parts) {
		return parts.join('_').toLowerCase().replace(/[^a-z0-9:.]+/g, '-').replace(/^-+|-+$/g, '');
	}

	function exportName(kind, filters, partial) {
		var tail = filterParts(filters).length ? [slug(filterParts(filters))] : [];
		if (partial) tail.push('partial');
		return 'disease-matrix' + (kind === 'annotations' ? '-annotations' : '') + (tail.length ? '_' + tail.join('_') : '') + '.csv';
	}

	function listName(slim, filters, date) {
		return ['Disease slim ' + slim].concat(filterParts(filters), [date]).join(', ');
	}

	function cellDetails(row, slim) {
		return (row.cells[slim] || []).map(function (a) {
			return { term: a.term, termId: a.termId, qualifier: a.qualifier, negated: a.negated, codes: a.codes, pmids: a.pmids };
		});
	}

	function node(tag, text, className) {
		var e = document.createElement(tag);
		if (text !== undefined && text !== null) e.textContent = String(text);
		if (className) e.className = className;
		return e;
	}

	function attrs(e, map) {
		Object.keys(map).forEach(function (k) { e.setAttribute(k, map[k]); });
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

	function checkbox(checked, onChange) {
		var c = node('input');
		c.type = 'checkbox';
		c.checked = checked;
		c.addEventListener('change', function () { onChange(!!c.checked); });
		return c;
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

	function termLink(d) {
		if (!d.termId) return node('strong', d.term || 'Unnamed term');
		var a = node('a', d.term || d.termId);
		a.href = DISEASE_URL + encodeURIComponent(d.termId);
		a.target = '_blank';
		a.rel = 'noopener';
		return a;
	}

	function detailItem(d) {
		var li = node('li');
		li.appendChild(termLink(d));
		if (d.termId) li.appendChild(node('span', ' ' + d.termId, 'agr-note'));
		li.appendChild(node('span', ' ' + (d.qualifier || 'no qualifier'), 'agr-note'));
		if (d.negated) li.appendChild(node('strong', ' NOT', 'agr-negated'));
		li.appendChild(node('div', 'Evidence codes: ' + (d.codes.length ? d.codes.join(', ') : 'none')));
		var pubs = node('div', 'PMIDs: ');
		if (d.pmids.length) pubs.appendChild(pmidList(d.pmids));
		else pubs.appendChild(document.createTextNode('none'));
		li.appendChild(pubs);
		return li;
	}

	function popover(row, slim, onClose) {
		var box = attrs(node('div', null, 'agr-popover'), { role: 'dialog', 'aria-label': row.symbol + ' / ' + slim, tabindex: '-1' });
		box.addEventListener('keydown', function (ev) {
			if (ev && ev.key === 'Escape') onClose();
		});
		box.appendChild(node('h4', row.symbol + ' / ' + slim));
		var ul = node('ul');
		cellDetails(row, slim).forEach(function (d) { ul.appendChild(detailItem(d)); });
		box.appendChild(ul);
		box.appendChild(button('Close', onClose));
		return box;
	}

	function download(text, filename) {
		var url = URL.createObjectURL(new Blob([withBom(text)], { type: 'text/csv;charset=utf-8' }));
		var a = document.createElement('a');
		a.href = url;
		a.download = filename;
		a.click();
		URL.revokeObjectURL(url);
	}

	function today() {
		return new Date().toISOString().slice(0, 10);
	}

	function saveColumn(col, context, ui) {
		var ids = col.genes.map(function (g) { return g.id; });
		ui.status('Saving ' + count(ids.length, 'gene'));
		context
			.saveList({ name: listName(col.slim, ui.filters(), today()), class: 'Gene', ids: ids, tags: ['alliance', 'disease-matrix'] })
			.then(function (name) { ui.status('Saved list ' + name); })
			.catch(function (err) { ui.status(err && err.message === 'login required' ? 'Log in to save a list' : 'Could not save the list'); });
	}

	function sortAttr(th, sort, key) {
		th.setAttribute('aria-sort', sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none');
	}

	function headerCell(col, ui, sort, partial) {
		var th = attrs(node('th'), { scope: 'col' });
		sortAttr(th, sort, col.slim);
		th.appendChild(button(col.slim, function () { ui.sortBy(col.slim); }, 'agr-sort'));
		if (ui.context && typeof ui.context.saveList === 'function') {
			var label = 'Save genes (' + col.genes.length + (partial ? ', partial' : '') + ')';
			th.appendChild(button(label, function () { saveColumn(col, ui.context, ui); }, 'agr-save'));
		}
		return th;
	}

	function headRow(cols, ui, sort, partial, withSpecies) {
		var tr = node('tr');
		var gene = attrs(node('th'), { scope: 'col' });
		sortAttr(gene, sort, 'symbol');
		gene.appendChild(button('Gene', function () { ui.sortBy('symbol'); }, 'agr-sort'));
		tr.appendChild(gene);
		if (withSpecies) tr.appendChild(attrs(node('th', 'Species'), { scope: 'col' }));
		var total = attrs(node('th'), { scope: 'col' });
		sortAttr(total, sort, TOTAL);
		total.appendChild(button('Total', function () { ui.sortBy(TOTAL); }, 'agr-sort'));
		tr.appendChild(total);
		cols.forEach(function (c) { tr.appendChild(headerCell(c, ui, sort, partial)); });
		return tr;
	}

	function bodyRow(row, cols, ui, withSpecies) {
		var tr = node('tr');
		tr.appendChild(attrs(node('th', row.symbol), { scope: 'row' }));
		if (withSpecies) tr.appendChild(node('td', row.organism));
		tr.appendChild(node('td', row.total, 'num'));
		cols.forEach(function (c) {
			var n = cellCount(row, c.slim);
			var td = node('td', null, 'num');
			if (n) {
				var b = button(n, function () { ui.open(row, c.slim); }, 'agr-cell');
				b.setAttribute('aria-label', row.symbol + ', ' + c.slim + ': ' + count(n, 'annotation'));
				td.appendChild(b);
			}
			tr.appendChild(td);
		});
		return tr;
	}

	function table(rows, cols, ui, opts) {
		var t = node('table', null, 'agr-table agr-table-sm');
		t.appendChild(node('caption', 'Disease annotations per gene and Disease Ontology slim term'));
		var thead = node('thead');
		thead.appendChild(headRow(cols, ui, opts.sort, opts.partial, opts.withSpecies));
		t.appendChild(thead);
		var tbody = node('tbody');
		rows.forEach(function (r) { tbody.appendChild(bodyRow(r, cols, ui, opts.withSpecies)); });
		t.appendChild(tbody);
		var wrap = node('div', null, 'agr-table-wrap');
		wrap.appendChild(t);
		return wrap;
	}

	function options(values) {
		return [{ value: '', label: 'All' }].concat(values.map(function (v) { return { value: v, label: v }; }));
	}

	function controls(model, ui) {
		var bar = node('div', null, 'agr-controls');
		var codes = evidenceCodes(model.annotations);
		if (codes.length > 1 || (codes.length === 1 && codes[0] !== NO_VALUE)) {
			bar.appendChild(labelled('Evidence code', select(options(codes), model.filters.code, function (v) { ui.filter('code', v); })));
		}
		var species = organisms(model.annotations);
		if (species.length > 1) {
			bar.appendChild(labelled('Species', select(options(species), model.filters.organism, function (v) { ui.filter('organism', v); })));
		}
		var via = [
			{ value: 'all', label: 'All annotations' },
			{ value: 'only', label: 'Via orthology only' },
			{ value: 'exclude', label: 'Exclude via orthology' }
		];
		bar.appendChild(labelled('Orthology', select(via, model.filters.via, function (v) { ui.filter('via', v); })));
		bar.appendChild(labelled('Include negated', checkbox(model.filters.negated, function (v) { ui.filter('negated', v); })));
		var colSorts = [{ value: 'name', label: 'Name' }, { value: 'count', label: 'Annotation count' }];
		bar.appendChild(labelled('Sort columns', select(colSorts, model.colSort, ui.sortCols)));
		bar.appendChild(button('Export CSV', ui.exportCsv));
		bar.appendChild(button('Export annotations CSV', ui.exportAnnotations));
		return bar;
	}

	function summary(rows, cols, shown) {
		return count(rows.length, 'gene') + ', ' + count(cols.length, 'slim term') + ', ' + count(shown, 'annotation') + '.';
	}

	function unslimmedShare(annotations) {
		if (!annotations.length) return 0;
		return annotations.filter(function (a) { return !a.slims.length; }).length / annotations.length;
	}

	function notices(model) {
		var out = [];
		if (model.truncated) {
			out.push('Result truncated: a request reached the limit of ' + MAX_ROWS + ' rows, so counts for some genes are incomplete. Exports and saved lists are partial.');
		}
		if (unslimmedShare(model.annotations) > MOSTLY_UNSLIMMED) {
			out.push('Over 90% of annotations have no slim term, so the matrix has little structure.');
		}
		return out;
	}

	function showMore(shownCount, total, ui) {
		var p = node('p', 'Showing ' + shownCount + ' of ' + count(total, 'gene') + '. ', 'agr-note');
		p.appendChild(button('Show more', ui.more));
		return p;
	}

	function render(el, model, ui) {
		clear(el);
		var wrap = node('div', null, 'alliance-disease-matrix');
		wrap.appendChild(controls(model, ui));
		var view = viewOf(model);
		wrap.appendChild(node('p', summary(view.rows, view.cols, view.shown), 'alliance-disease-matrix-summary'));
		notices(model).forEach(function (text) { wrap.appendChild(node('p', text, 'agr-note')); });
		if (model.status) wrap.appendChild(node('p', model.status, 'agr-note'));
		if (!view.rows.length) {
			wrap.appendChild(node('p', 'No disease annotations match', 'agr-empty'));
		} else {
			var limit = model.rowLimit || ROW_PAGE;
			wrap.appendChild(table(view.rows.slice(0, limit), view.cols, ui, {
				sort: model.rowSort, partial: model.truncated, withSpecies: organisms(model.annotations).length > 1
			}));
			if (view.rows.length > limit) wrap.appendChild(showMore(limit, view.rows.length, ui));
		}
		var box = model.opened ? popover(model.opened.row, model.opened.slim, ui.close) : null;
		if (box) wrap.appendChild(box);
		wrap.appendChild(node('p', 'Counts are disease annotations per gene and Disease Ontology slim term. A slim term counts an annotation when it is the annotation\'s disease term or an ancestor of it, so an annotation with several slim terms counts in each. Annotations without a slim term are listed under ' + NO_SLIM + '. Negated annotations are left out unless Include negated is on.', 'agr-note'));
		el.appendChild(wrap);
		if (box && box.focus) box.focus();
	}

	function viewOf(model) {
		var shown = filterAnnotations(model.annotations, model.filters);
		var p = pivot(shown);
		return {
			rows: sortRows(p.rows, model.rowSort.key, model.rowSort.dir),
			cols: sortCols(p.cols, model.colSort),
			shown: shown.length,
			annotations: shown
		};
	}

	function makeUi(el, model, context) {
		var ui = { context: context };
		function redraw() { render(el, model, ui); }
		ui.filters = function () { return model.filters; };
		ui.sortBy = function (key) {
			var same = model.rowSort.key === key;
			model.rowSort = { key: key, dir: same ? -model.rowSort.dir : key === 'symbol' ? 1 : -1 };
			redraw();
		};
		ui.sortCols = function (by) { model.colSort = by; redraw(); };
		ui.filter = function (name, value) { model.filters[name] = value; model.opened = null; model.rowLimit = ROW_PAGE; redraw(); };
		ui.open = function (row, slim) { model.opened = { row: row, slim: slim }; redraw(); };
		ui.close = function () { model.opened = null; redraw(); };
		ui.more = function () { model.rowLimit = (model.rowLimit || ROW_PAGE) + ROW_PAGE; redraw(); };
		ui.status = function (text) { model.status = text; redraw(); };
		ui.exportCsv = function () {
			var v = viewOf(model);
			download(toCsv(v.rows, v.cols), exportName('matrix', model.filters, model.truncated));
		};
		ui.exportAnnotations = function () {
			download(toLongCsv(viewOf(model).annotations), exportName('annotations', model.filters, model.truncated));
		};
		return ui;
	}

	function defaultSleep(ms) {
		return new Promise(function (resolve) { setTimeout(resolve, ms); });
	}

	function retryDelay(res, attempt) {
		var after = Number(res.headers && res.headers.get && res.headers.get('Retry-After'));
		return after > 0 ? Math.min(after * 1000, 30000) : BACKOFF_MS * Math.pow(2, attempt);
	}

	// POST with a 30 s timeout. HTTP 429 and 503 are retried with exponential backoff, up to MAX_RETRIES times.
	function postJson(url, body, opts, attempt) {
		attempt = attempt || 0;
		var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
		var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);
		return opts.fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: body,
			signal: ctrl ? ctrl.signal : undefined
		})
			.then(
				function (res) {
					if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
						clearTimeout(timer);
						return opts.sleep(retryDelay(res, attempt)).then(function () { return postJson(url, body, opts, attempt + 1); });
					}
					if (!res.ok) throw new Error('HTTP ' + res.status + (res.status === 429 ? ' after ' + (attempt + 1) + ' attempts' : ''));
					return res.json();
				}
			)
			.then(
				function (json) { clearTimeout(timer); return json; },
				function (err) {
					clearTimeout(timer);
					throw err && err.name === 'AbortError' ? new Error('Request timed out after ' + TIMEOUT_MS / 1000 + ' s') : err;
				}
			);
	}

	function chunks(list, size) {
		var out = [];
		for (var i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
		return out;
	}

	// Runs the requests one at a time, since the mine answers HTTP 429 to parallel bursts.
	function runChunks(parts, run, rows, flags) {
		return parts.reduce(function (p, part) {
			return p.then(function () {
				return run(part).then(function (json) {
					var got = (json && json.results) || [];
					if (got.length >= MAX_ROWS) flags.truncated = true;
					got.forEach(function (r) { rows.push(r); });
				});
			});
		}, Promise.resolve());
	}

	// opts: {fetch, sleep, onProgress}. Gene ids go in chunks of GENE_CHUNK, then the ancestors of their disease terms in chunks of TERM_CHUNK.
	function fetchAnnotations(rootUrl, ids, opts) {
		opts = opts || {};
		var o = {
			fetch: opts.fetch || function (u, i) { return fetch(u, i); },
			sleep: opts.sleep || defaultSleep
		};
		var url = serviceRoot(rootUrl) + '/query/results';
		var flags = { truncated: false };
		var geneRows = [];
		var parentRows = [];
		var geneParts = chunks(ids, GENE_CHUNK);
		var done = 0;
		function step(total) {
			done++;
			if (opts.onProgress) opts.onProgress(done, total);
		}
		return runChunks(geneParts, function (part) {
			return postJson(url, requestBody(buildQuery(part)), o).then(function (j) { step(geneParts.length); return j; });
		}, geneRows, flags)
			.then(function () {
				var annotations = toAnnotations(geneRows);
				var termIds = [];
				annotations.forEach(function (a) { addUnique(termIds, a.termId); });
				var termParts = chunks(termIds, TERM_CHUNK);
				done = 0;
				return runChunks(termParts, function (part) {
					return postJson(url, requestBody(buildParentsQuery(part)), o).then(function (j) { step(termParts.length); return j; });
				}, parentRows, flags).then(function () {
					return { annotations: applySlims(annotations, parentRows), truncated: flags.truncated };
				});
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
		fetchAnnotations(service.root, ids, {
			onProgress: function (n, total) {
				if (el.__agrDiseaseMatrixReq === token && total > 1) message(el, 'Loading disease annotations (request ' + n + ' of ' + total + ')', 'agr-loading');
			}
		})
			.then(function (data) {
				if (el.__agrDiseaseMatrixReq !== token) return;
				var model = {
					annotations: data.annotations, truncated: data.truncated, filters: newFilters(),
					rowSort: { key: 'symbol', dir: 1 }, colSort: 'name', opened: null, status: '', rowLimit: ROW_PAGE
				};
				render(el, model, makeUi(el, model, context));
			})
			.catch(function (err) {
				if (el.__agrDiseaseMatrixReq !== token) return;
				message(el, 'Could not load disease annotations from the mine' + (err && err.message ? ' (' + err.message + ')' : ''), 'agr-error');
			});
	}

	var api = {
		main: main, serviceRoot: serviceRoot, buildQuery: buildQuery, buildParentsQuery: buildParentsQuery, requestBody: requestBody,
		toAnnotations: toAnnotations, applySlims: applySlims, isViaOrthology: isViaOrthology, isNegated: isNegated,
		evidenceCodes: evidenceCodes, organisms: organisms, newFilters: newFilters, filterAnnotations: filterAnnotations,
		pivot: pivot, sortRows: sortRows, sortCols: sortCols, toCsv: toCsv, toLongCsv: toLongCsv, withBom: withBom,
		exportName: exportName, listName: listName, cellDetails: cellDetails, fetchAnnotations: fetchAnnotations,
		render: render, makeUi: makeUi, notices: notices,
		VIEW: VIEW, PARENT_VIEW: PARENT_VIEW, SLIMS: SLIMS, ROW_PAGE: ROW_PAGE,
		NO_SLIM: NO_SLIM, NO_VALUE: NO_VALUE, TOTAL: TOTAL
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceDiseaseMatrix = api;
})(typeof window !== 'undefined' ? window : globalThis);
