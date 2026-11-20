/*
 * Annotation coverage, a BlueGenes tool (tool API version 2).
 * Plain JavaScript without dependencies, so this file is both the source and
 * the bundle. BlueGenes loads it as a script and calls
 * bluegenesAllianceAnnotationCoverage.main(el, service, entity, state, config, navigate, context).
 */
(function (root) {
	'use strict';

	var PAGE_SIZE = 5000;
	var MAX_PAGES = 20;
	var CHUNK = 200;
	var TAG = 'alliance-annotation-coverage';

	// One entry per annotation type: the Gene collection that holds it.
	var TYPES = [
		{ key: 'go', label: 'GO', collection: 'goAnnotation' },
		{ key: 'disease', label: 'Disease', collection: 'diseaseAnnotation' },
		{ key: 'phenotype', label: 'Phenotype', collection: 'phenotypeAnnotations' },
		{ key: 'publications', label: 'Publications', collection: 'publications' },
		{ key: 'alleles', label: 'Alleles', collection: 'alleles' }
	];

	function serviceRoot(root) {
		var r = String(root || '').replace(/\/+$/, '');
		return /\/service$/.test(r) ? r : r + '/service';
	}

	function escapeXml(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	// service.model.classes resolves a dotted path through references,
	// collections and superclasses. True when no model is passed.
	function fieldOf(classes, cls, name, seen) {
		var c = classes[cls];
		if (!c || seen[cls]) return null;
		seen[cls] = true;
		var f = (c.attributes && c.attributes[name]) || (c.references && c.references[name]) || (c.collections && c.collections[name]);
		if (f) return f;
		var ext = c.extends || [];
		for (var i = 0; i < ext.length; i++) {
			var r = fieldOf(classes, ext[i], name, seen);
			if (r) return r;
		}
		return null;
	}

	function hasPath(service, path) {
		var classes = service && service.model && service.model.classes;
		if (!classes) return true;
		var parts = String(path).split('.');
		var cls = parts[0];
		if (!classes[cls]) return false;
		for (var i = 1; i < parts.length; i++) {
			var f = fieldOf(classes, cls, parts[i], {});
			if (!f) return false;
			if (i < parts.length - 1) {
				if (!f.referencedType) return false;
				cls = f.referencedType;
			}
		}
		return true;
	}

	// Types whose collection id path exists in the mine's model.
	function typesFor(service) {
		return TYPES.filter(function (t) {
			return hasPath(service, 'Gene.' + t.collection + '.id');
		});
	}

	function typeByKey(key) {
		return TYPES.filter(function (t) { return t.key === key; })[0];
	}

	function idConstraint(ids) {
		var values = ids.map(function (id) { return '<value>' + escapeXml(id) + '</value>'; }).join('');
		return '<constraint path="Gene.id" op="ONE OF">' + values + '</constraint>';
	}

	// Inner join on the collection: genes without annotations drop out, so no
	// outer join inflates the row count and the sort on both ids is stable.
	function countQuery(type, ids) {
		var path = 'Gene.' + type.collection + '.id';
		return (
			'<query model="genomic" view="Gene.id ' + path + '" sortOrder="Gene.id asc ' + path + ' asc">' +
			idConstraint(ids) + '</query>'
		);
	}

	function infoQuery(ids) {
		return (
			'<query model="genomic" view="Gene.id Gene.primaryIdentifier Gene.symbol Gene.organism.shortName" sortOrder="Gene.id asc">' +
			'<join path="Gene.organism" style="OUTER"/>' + idConstraint(ids) + '</query>'
		);
	}

	function requestBody(query, start) {
		return 'format=json&start=' + (start || 0) + '&size=' + PAGE_SIZE + '&query=' + encodeURIComponent(query);
	}

	function resultsUrl(root) {
		return serviceRoot(root) + '/query/results';
	}

	function chunks(list, size) {
		var out = [];
		for (var i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
		return out;
	}

	// Rows are [geneId, annotationId]; returns {geneId: number of distinct annotations}.
	function countRows(rows) {
		var seen = {};
		var counts = {};
		rows.forEach(function (r) {
			if (r[1] === null || r[1] === undefined) return;
			var key = r[0] + '\u0000' + r[1];
			if (seen[key]) return;
			seen[key] = true;
			counts[r[0]] = (counts[r[0]] || 0) + 1;
		});
		return counts;
	}

	function toGene(r, types, countsByType) {
		var counts = {};
		types.forEach(function (t) { counts[t.key] = (countsByType[t.key] && countsByType[t.key][r[0]]) || 0; });
		return {
			id: r[0],
			identifier: r[1] || '',
			symbol: r[2] || r[1] || '',
			organism: r[3] || 'Unknown species',
			counts: counts
		};
	}

	function cmp(a, b) {
		return a < b ? -1 : a > b ? 1 : 0;
	}

	function buildGenes(infoRows, types, countsByType) {
		return infoRows
			.map(function (r) { return toGene(r, types, countsByType); })
			.sort(function (a, b) {
				return cmp(a.organism, b.organism) || cmp(a.symbol, b.symbol) || cmp(a.identifier, b.identifier);
			});
	}

	// One entry per organism: gene count, and per type the genes with at least one annotation.
	function coverage(genes, types) {
		var by = {};
		var order = [];
		genes.forEach(function (g) {
			var o = by[g.organism];
			if (!o) {
				o = by[g.organism] = { organism: g.organism, genes: 0, covered: {} };
				types.forEach(function (t) { o.covered[t.key] = 0; });
				order.push(g.organism);
			}
			o.genes += 1;
			types.forEach(function (t) { if (g.counts[t.key] > 0) o.covered[t.key] += 1; });
		});
		return order.sort().map(function (name) {
			var o = by[name];
			o.share = {};
			types.forEach(function (t) { o.share[t.key] = o.genes ? o.covered[t.key] / o.genes : 0; });
			return o;
		});
	}

	function withoutType(genes, key) {
		return genes.filter(function (g) { return !(g.counts[key] > 0); });
	}

	function csvCell(v) {
		var s = String(v === null || v === undefined ? '' : v);
		return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
	}

	function toCsv(genes, types) {
		var head = ['Gene', 'Symbol', 'Organism'].concat(types.map(function (t) { return t.label; }));
		var lines = [head].concat(
			genes.map(function (g) {
				return [g.identifier, g.symbol, g.organism].concat(types.map(function (t) { return g.counts[t.key]; }));
			})
		);
		return lines.map(function (l) { return l.map(csvCell).join(','); }).join('\r\n') + '\r\n';
	}

	function percent(x) {
		return Math.round(x * 100) + '%';
	}

	function missingNote(types) {
		var gone = TYPES.filter(function (t) { return types.indexOf(t) < 0; });
		return gone.length
			? 'This mine has no annotations for: ' + gone.map(function (t) { return t.label; }).join(', ') + '.'
			: '';
	}

	function listName(type, now) {
		return 'genes_without_' + type.key + '_annotations_' + now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
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

	function message(el, text) {
		clear(el);
		var wrap = node('div', null, 'alliance-annotation-coverage');
		var cls = text === 'Loading...' ? 'agr-loading' : /^Could not/.test(text) ? 'agr-error' : 'agr-empty';
		wrap.appendChild(node('p', text, cls));
		el.appendChild(wrap);
	}

	function bar(share, label) {
		var track = node('div', null, 'alliance-annotation-coverage-track');
		track.setAttribute('style', 'background:#e6e9ee;border-radius:3px;height:12px;min-width:80px;');
		var fill = node('div', null, 'alliance-annotation-coverage-fill');
		fill.setAttribute('style', 'background:var(--agr-primary,#2a6fb0);border-radius:3px;height:12px;width:' + percent(share) + ';');
		fill.setAttribute('title', label);
		fill.setAttribute('role', 'img');
		fill.setAttribute('aria-label', label);
		track.appendChild(fill);
		return track;
	}

	function renderCoverage(rows, types, partial) {
		var wrap = node('div', null, 'agr-table-wrap');
		var table = node('table', null, 'agr-table agr-table-sm alliance-annotation-coverage-bars');
		var headRow = node('tr');
		['Organism', 'Genes'].concat(types.map(function (t) { return t.label; })).forEach(function (h) {
			headRow.appendChild(node('th', h));
		});
		var thead = node('thead');
		thead.appendChild(headRow);
		table.appendChild(thead);
		var tbody = node('tbody');
		rows.forEach(function (o) {
			var tr = node('tr');
			var name = node('td');
			name.appendChild(node('em', o.organism));
			tr.appendChild(name);
			tr.appendChild(node('td', o.genes));
			types.forEach(function (t) {
				var td = node('td');
				if (partial[t.key]) {
					td.appendChild(node('small', 'incomplete', 'agr-note'));
					tr.appendChild(td);
					return;
				}
				var text = o.covered[t.key] + ' of ' + o.genes + ' (' + percent(o.share[t.key]) + ')';
				td.appendChild(bar(o.share[t.key], t.label + ': ' + text));
				td.appendChild(node('small', text, 'agr-note'));
				tr.appendChild(td);
			});
			tbody.appendChild(tr);
		});
		table.appendChild(tbody);
		wrap.appendChild(table);
		return wrap;
	}

	function renderGeneTable(genes, types, navigate) {
		var wrap = node('div', null, 'agr-table-wrap');
		var table = node('table', null, 'agr-table agr-table-sm alliance-annotation-coverage-genes');
		var headRow = node('tr');
		['Gene', 'Organism'].concat(types.map(function (t) { return t.label; })).forEach(function (h) {
			headRow.appendChild(node('th', h));
		});
		var thead = node('thead');
		thead.appendChild(headRow);
		table.appendChild(thead);
		var tbody = node('tbody');
		genes.forEach(function (g) {
			var tr = node('tr');
			var cell = node('td');
			var a = node('a', g.symbol);
			a.href = '#';
			a.addEventListener('click', function (ev) {
				if (ev && ev.preventDefault) ev.preventDefault();
				if (typeof navigate === 'function') navigate('report', { type: 'Gene', id: g.id });
			});
			cell.appendChild(a);
			tr.appendChild(cell);
			var org = node('td');
			org.appendChild(node('em', g.organism));
			tr.appendChild(org);
			types.forEach(function (t) { tr.appendChild(node('td', g.counts[t.key])); });
			tbody.appendChild(tr);
		});
		table.appendChild(tbody);
		wrap.appendChild(table);
		return wrap;
	}

	function download(text, filename) {
		var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
		var url = URL.createObjectURL(blob);
		var a = document.createElement('a');
		a.href = url;
		a.download = filename;
		a.click();
		URL.revokeObjectURL(url);
	}

	function csvButton(genes, types) {
		var b = node('button', 'Export CSV', 'agr-btn agr-btn-sm');
		b.type = 'button';
		b.addEventListener('click', function () { download(toCsv(genes, types), 'annotation-coverage.csv'); });
		return b;
	}

	// Offers a list of the genes lacking the chosen type when the host passes saveList.
	function saveControls(genes, types, context, partial) {
		if (!context || typeof context.saveList !== 'function') return null;
		var controls = node('div', null, 'agr-filter-bar alliance-annotation-coverage-save');
		var select = node('select', null, 'form-control');
		select.setAttribute('aria-label', 'Annotation type');
		types.forEach(function (t) {
			var o = node('option', t.label);
			o.value = t.key;
			select.appendChild(o);
		});
		var button = node('button', null, 'agr-btn agr-btn-primary agr-btn-sm');
		button.type = 'button';
		var status = node('span', null, 'agr-note');

		function chosen() {
			return typeByKey(select.value || types[0].key);
		}
		function refresh() {
			var n = withoutType(genes, chosen().key).length;
			var incomplete = partial[chosen().key];
			button.textContent = incomplete
				? 'Cannot save: ' + chosen().label + ' counts are incomplete'
				: 'Save ' + n + ' genes without ' + chosen().label + ' as list';
			button.disabled = incomplete || n === 0;
		}
		select.addEventListener('change', function () {
			status.textContent = '';
			refresh();
		});
		button.addEventListener('click', function () {
			var type = chosen();
			if (partial[type.key]) return;
			var ids = withoutType(genes, type.key).map(function (g) { return g.id; });
			button.disabled = true;
			status.textContent = 'Saving...';
			context
				.saveList({ name: listName(type, new Date()), class: 'Gene', ids: ids, tags: [TAG] })
				.then(function (name) { status.textContent = 'Saved list ' + name; })
				.catch(function (err) {
					status.textContent = err && err.message === 'login required' ? 'Log in to save lists' : 'Could not save the list';
				})
				.then(refresh);
		});
		controls.appendChild(select);
		controls.appendChild(button);
		controls.appendChild(status);
		refresh();
		return controls;
	}

	function render(el, data, navigate, context) {
		clear(el);
		var wrap = node('div', null, 'alliance-annotation-coverage');
		el.appendChild(wrap);
		var genes = data.genes;
		var types = data.types;
		var partial = data.partial || {};
		if (!genes.length || !types.length) {
			wrap.appendChild(node('p', 'No annotation coverage to show for these genes', 'agr-empty'));
			if (data.note) wrap.appendChild(node('p', data.note, 'agr-note'));
			return;
		}
		wrap.appendChild(node('p', genes.length + ' genes. Bars show the share of genes with at least one annotation of each type.', 'agr-note'));
		wrap.appendChild(renderCoverage(coverage(genes, types), types, partial));
		var tools = node('div', null, 'agr-filter-bar');
		tools.appendChild(csvButton(genes, types));
		wrap.appendChild(tools);
		var save = saveControls(genes, types, context, partial);
		if (save) wrap.appendChild(save);
		wrap.appendChild(renderGeneTable(genes, types, navigate));
		if (data.note) wrap.appendChild(node('p', data.note, 'agr-note'));
		var cut = types.filter(function (t) { return partial[t.key]; });
		if (cut.length) {
			wrap.appendChild(node('p', 'Incomplete: a single gene exceeds ' + PAGE_SIZE * MAX_PAGES + ' rows for ' + cut.map(function (t) { return t.label; }).join(', ') + ', so those counts are not shown and cannot be saved.', 'agr-note'));
		}
	}

	function fetchPage(root, query, start) {
		return fetch(resultsUrl(root), {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: requestBody(query, start)
		})
			.then(function (res) {
				if (!res.ok) {
					var err = new Error('HTTP ' + res.status);
					err.status = res.status;
					throw err;
				}
				return res.json();
			})
			.then(function (json) { return (json && json.results) || []; });
	}

	// Pages through a sorted result until a short page arrives; full is true when MAX_PAGES stopped it.
	function fetchRows(root, query) {
		var rows = [];
		function next(page) {
			return fetchPage(root, query, page * PAGE_SIZE).then(function (results) {
				rows = rows.concat(results);
				if (results.length < PAGE_SIZE) return { rows: rows, full: false };
				if (page + 1 >= MAX_PAGES) return { rows: rows, full: true };
				return next(page + 1);
			});
		}
		return next(0);
	}

	function sequence(items, fn) {
		var out = [];
		return items
			.reduce(function (p, item) {
				return p.then(function () {
					return fn(item).then(function (r) { out.push(r); });
				});
			}, Promise.resolve())
			.then(function () { return out; });
	}

	function mergeParts(parts) {
		var rows = [];
		parts.forEach(function (p) { rows = rows.concat(p.rows); });
		return { rows: rows, full: parts.some(function (p) { return p.full; }) };
	}
	
	// A full result may be cut off, so the id set is halved and re-queried; only a single gene stays full.
	function fetchChunk(root, type, ids) {
		return fetchRows(root, countQuery(type, ids)).then(function (part) {
			if (!part.full || ids.length < 2) return part;
			var mid = Math.ceil(ids.length / 2);
			return sequence([ids.slice(0, mid), ids.slice(mid)], function (half) {
				return fetchChunk(root, type, half);
			}).then(mergeParts);
		});
	}
	
	function fetchCounts(root, type, ids) {
		return sequence(chunks(ids, CHUNK), function (part) {
			return fetchChunk(root, type, part);
		}).then(function (parts) {
			var all = mergeParts(parts);
			return { counts: countRows(all.rows), full: all.full };
		});
	}

	function fetchInfo(root, ids) {
		return sequence(chunks(ids, CHUNK), function (part) {
			return fetchRows(root, infoQuery(part));
		}).then(function (parts) {
			var rows = [];
			parts.forEach(function (p) { rows = rows.concat(p.rows); });
			return rows;
		});
	}

	function fetchAll(service, ids) {
		var root = service.root;
		var types = typesFor(service);
		return Promise.all([
			fetchInfo(root, ids),
			Promise.all(types.map(function (t) { return fetchCounts(root, t, ids); }))
		]).then(function (res) {
			var countsByType = {};
			var partial = {};
			types.forEach(function (t, i) {
				countsByType[t.key] = res[1][i].counts;
				partial[t.key] = res[1][i].full;
			});
			return {
				genes: buildGenes(res[0], types, countsByType),
				types: types,
				note: missingNote(types),
				partial: partial
			};
		});
	}

	function idsOf(entity) {
		var gene = entity && entity.Gene;
		var raw = gene && gene.value;
		var list = Array.isArray(raw) ? raw : [raw];
		return list
			.filter(function (id) { return id !== undefined && id !== null && id !== ''; })
			.map(String);
	}

	function main(el, service, imEntity, state, config, navigate, context) {
		if (!el || !service || !imEntity) {
			throw new Error('Call main with correct signature');
		}
		var token = (el.__agrCoverageReq = (el.__agrCoverageReq || 0) + 1);
		var ids = idsOf(imEntity);
		if (!ids.length) {
			message(el, 'No annotation coverage to show for these genes');
			return;
		}
		message(el, 'Loading...');
		fetchAll(service, ids)
			.then(function (data) {
				if (el.__agrCoverageReq !== token) return;
				render(el, data, navigate, context);
			})
			.catch(function (err) {
				console.error('annotation-coverage: load failed', err);
				if (el.__agrCoverageReq !== token) return;
				message(el, 'Could not load annotation coverage from the mine');
			});
	}

	var api = {
		main: main,
		TYPES: TYPES,
		hasPath: hasPath,
		typesFor: typesFor,
		countQuery: countQuery,
		infoQuery: infoQuery,
		requestBody: requestBody,
		countRows: countRows,
		buildGenes: buildGenes,
		coverage: coverage,
		withoutType: withoutType,
		toCsv: toCsv,
		listName: listName,
		chunks: chunks,
		render: render
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceAnnotationCoverage = api;
})(typeof window !== 'undefined' ? window : globalThis);
