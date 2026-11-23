/*
 * Annotation coverage, a BlueGenes tool (tool API version 2).
 * Plain JavaScript without dependencies, so this file is both the source and
 * the bundle. BlueGenes loads it as a script and calls
 * bluegenesAllianceAnnotationCoverage.main(el, service, entity, state, config, navigate, context).
 */
(function (root) {
	'use strict';

	var PAGE_SIZE = 5000;
	var CHUNK = 200;
	var TRIES = 3;
	var STREAMS = 2;
	var ROWS_PER_PAGE = 100;
	var MIN_GENES_FOR_NONE = 20;
	var TAG = 'alliance-annotation-coverage';
	var settings = { timeoutMs: 30000, retryMs: 1000, revokeMs: 1000 };

	// One entry per annotation type: the Gene collection that holds it.
	var TYPES = [
		{ key: 'go', label: 'GO', collection: 'goAnnotation' },
		{ key: 'disease', label: 'Disease', collection: 'diseaseAnnotation' },
		{ key: 'phenotype', label: 'Phenotype', collection: 'phenotypeAnnotations' },
		{ key: 'publications', label: 'Publications', collection: 'publications' },
		{ key: 'alleles', label: 'Alleles', collection: 'alleles' }
	];

	function count(n, word) {
		return n + ' ' + word + (n === 1 ? '' : 's');
	}

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

	// One row per gene that has at least one annotation of the type, however many it has.
	function presenceQuery(type, ids) {
		return (
			'<query model="genomic" view="Gene.id" sortOrder="Gene.id asc">' +
			'<constraint path="Gene.' + type.collection + '" op="IS NOT NULL"/>' + idConstraint(ids) + '</query>'
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

	function unique(list) {
		var seen = {};
		return list.filter(function (x) {
			if (seen[x]) return false;
			seen[x] = true;
			return true;
		});
	}

	// presentByType: {typeKey: {geneId: true}} for the types loaded so far; has stays undefined for the others.
	function toGene(r, types, presentByType) {
		var has = {};
		types.forEach(function (t) {
			if (presentByType[t.key]) has[t.key] = presentByType[t.key][r[0]] === true;
		});
		return {
			id: r[0],
			identifier: r[1] || '',
			symbol: r[2] || r[1] || '',
			organism: r[3] || 'Unknown species',
			has: has
		};
	}

	function cmp(a, b) {
		return a < b ? -1 : a > b ? 1 : 0;
	}

	function buildGenes(infoRows, types, presentByType) {
		return infoRows
			.map(function (r) { return toGene(r, types, presentByType || {}); })
			.sort(function (a, b) {
				return cmp(a.organism, b.organism) || cmp(a.symbol, b.symbol) || cmp(a.identifier, b.identifier);
			});
	}

	// One entry per organism: gene count, per type the genes with an annotation, and the types
	// the organism has none of (flagged only from MIN_GENES_FOR_NONE genes, where a gap is unlikely).
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
			types.forEach(function (t) { if (g.has[t.key] === true) o.covered[t.key] += 1; });
		});
		return order.sort().map(function (name) {
			var o = by[name];
			o.share = {};
			o.none = {};
			types.forEach(function (t) {
				o.share[t.key] = o.genes ? o.covered[t.key] / o.genes : 0;
				o.none[t.key] = o.covered[t.key] === 0 && o.genes >= MIN_GENES_FOR_NONE;
			});
			return o;
		});
	}

	function withoutType(genes, key) {
		return genes.filter(function (g) { return g.has[key] === false; });
	}

	// mode: '' all genes, a type key, 'any' (lacks at least one type) or 'all' (lacks every type).
	function matches(g, mode, types) {
		if (!mode) return true;
		if (mode === 'any') return types.some(function (t) { return g.has[t.key] === false; });
		if (mode === 'all') return types.every(function (t) { return g.has[t.key] === false; });
		return g.has[mode] === false;
	}

	function csvCell(v) {
		var s = String(v === null || v === undefined ? '' : v);
		return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
	}

	function csvText(v) {
		var s = String(v === null || v === undefined ? '' : v);
		return csvCell(/^[=+\-@\t\r]/.test(s) ? "'" + s : s);
	}

	function yesNo(v) {
		return v === true ? 'yes' : v === false ? 'no' : '';
	}

	function toCsv(genes, types) {
		var head = ['Gene', 'Symbol', 'Organism'].concat(types.map(function (t) { return t.label; })).map(csvCell);
		var lines = genes.map(function (g) {
			return [csvText(g.identifier), csvText(g.symbol), csvText(g.organism)].concat(types.map(function (t) { return csvCell(yesNo(g.has[t.key])); }));
		});
		return [head].concat(lines).map(function (l) { return l.join(','); }).join('\r\n') + '\r\n';
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

	function slug(s) {
		return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
	}

	// mode: a type, a type key, 'any' or 'all'.
	function listName(mode, now, organism) {
		var key = typeof mode === 'string' ? mode : mode.key;
		var base = key === 'any' ? 'genes_missing_any_annotation_type'
			: key === 'all' ? 'genes_missing_all_annotation_types'
			: 'genes_without_' + key + '_annotations';
		var stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
		return base + (organism ? '_' + slug(organism) : '') + '_' + stamp;
	}

	function modeLabel(mode) {
		if (mode === 'any') return 'missing at least one type';
		if (mode === 'all') return 'missing every type';
		return 'without ' + typeByKey(mode).label;
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
		var loading = text === 'Loading...';
		var failed = /^Could not/.test(text);
		var p = node('p', text, loading ? 'agr-loading' : failed ? 'agr-error' : 'agr-empty');
		p.setAttribute('role', failed ? 'alert' : 'status');
		wrap.appendChild(p);
		el.appendChild(wrap);
	}

	function labelled(text, control) {
		var label = node('label', null, 'agr-note');
		label.appendChild(node('span', text + ' '));
		label.appendChild(control);
		return label;
	}

	function option(value, text) {
		var o = node('option', text);
		o.value = value;
		return o;
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

	function head(labels, caption) {
		var table = node('table', null, 'agr-table agr-table-sm');
		table.appendChild(node('caption', caption, 'agr-note'));
		var headRow = node('tr');
		labels.forEach(function (h) {
			var th = node('th', h);
			th.setAttribute('scope', 'col');
			headRow.appendChild(th);
		});
		var thead = node('thead');
		thead.appendChild(headRow);
		table.appendChild(thead);
		return { table: table, headRow: headRow };
	}

	function typeCell(o, t, data, retry, pick) {
		var td = node('td');
		var status = data.status[t.key];
		if (status === 'loading') {
			td.appendChild(node('small', data.progress[t.key] || 'Loading...', 'agr-note'));
		} else if (status === 'error') {
			var msg = node('small', 'Could not load (' + data.errors[t.key] + ') ', 'agr-error');
			msg.setAttribute('role', 'alert');
			td.appendChild(msg);
			var again = node('button', 'Retry', 'agr-btn agr-btn-sm');
			again.type = 'button';
			again.addEventListener('click', function () { retry(t); });
			td.appendChild(again);
		} else if (o.none[t.key]) {
			td.appendChild(node('small', 'none in mine', 'agr-note'));
		} else {
			var text = o.covered[t.key] + ' of ' + o.genes + ' (' + percent(o.share[t.key]) + ')';
			var pickBtn = node('button', null, 'agr-btn agr-btn-link');
			pickBtn.type = 'button';
			pickBtn.setAttribute('title', 'Show genes without ' + t.label + ' in ' + o.organism);
			pickBtn.addEventListener('click', function () { pick(o.organism, t.key); });
			pickBtn.appendChild(bar(o.share[t.key], t.label + ': ' + text));
			pickBtn.appendChild(node('small', text, 'agr-note'));
			td.appendChild(pickBtn);
		}
		return td;
	}

	function renderCoverage(rows, data, retry, pick) {
		var wrap = node('div', null, 'agr-table-wrap');
		var h = head(['Organism', 'Genes'].concat(data.types.map(function (t) { return t.label; })), 'Genes with at least one annotation, by organism');
		h.table.className += ' alliance-annotation-coverage-bars';
		var tbody = node('tbody');
		rows.forEach(function (o) {
			var tr = node('tr');
			var name = node('td');
			name.appendChild(node('em', o.organism));
			tr.appendChild(name);
			tr.appendChild(node('td', o.genes));
			data.types.forEach(function (t) { tr.appendChild(typeCell(o, t, data, retry, pick)); });
			tbody.appendChild(tr);
		});
		h.table.appendChild(tbody);
		wrap.appendChild(h.table);
		return wrap;
	}

	function cellText(data, g, t) {
		var status = data.status[t.key];
		if (status === 'loading') return '...';
		if (status === 'error') return 'n/a';
		return g.has[t.key] ? 'Yes' : 'No';
	}

	function sortValue(g, col) {
		if (col === 'gene') return g.symbol.toLowerCase();
		if (col === 'organism') return g.organism;
		return g.has[col] === true ? 2 : g.has[col] === false ? 1 : 0;
	}

	function sorted(list, view) {
		if (!view.sort) return list;
		var keyed = list.map(function (g, i) { return { g: g, i: i }; });
		keyed.sort(function (a, b) {
			return view.dir * cmp(sortValue(a.g, view.sort), sortValue(b.g, view.sort)) || a.i - b.i;
		});
		return keyed.map(function (k) { return k.g; });
	}

	function renderGeneTable(list, data, view, navigate, onSort) {
		var wrap = node('div', null, 'agr-table-wrap');
		var cols = [{ key: 'gene', label: 'Gene' }, { key: 'organism', label: 'Organism' }].concat(data.types);
		var h = head([], 'Genes and their annotation types');
		h.table.className += ' alliance-annotation-coverage-genes';
		cols.forEach(function (c) {
			var th = node('th');
			th.setAttribute('scope', 'col');
			th.setAttribute('aria-sort', view.sort === c.key ? (view.dir > 0 ? 'ascending' : 'descending') : 'none');
			var b = node('button', c.label + (view.sort === c.key ? (view.dir > 0 ? ' (asc)' : ' (desc)') : ''), 'agr-btn agr-btn-link');
			b.type = 'button';
			b.addEventListener('click', function () { onSort(c.key); });
			th.appendChild(b);
			h.headRow.appendChild(th);
		});
		var tbody = node('tbody');
		var start = view.page * ROWS_PER_PAGE;
		sorted(list, view).slice(start, start + ROWS_PER_PAGE).forEach(function (g) {
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
			data.types.forEach(function (t) { tr.appendChild(node('td', cellText(data, g, t))); });
			tbody.appendChild(tr);
		});
		h.table.appendChild(tbody);
		wrap.appendChild(h.table);
		return wrap;
	}

	function download(text, filename) {
		var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
		var url = URL.createObjectURL(blob);
		var a = document.createElement('a');
		a.href = url;
		a.download = filename;
		if (document.body) document.body.appendChild(a);
		a.click();
		if (document.body && a.parentNode) document.body.removeChild(a);
		setTimeout(function () { URL.revokeObjectURL(url); }, settings.revokeMs);
	}

	function csvButton(getGenes, types) {
		var b = node('button', 'Export CSV', 'agr-btn agr-btn-sm');
		b.type = 'button';
		b.addEventListener('click', function () { download(toCsv(getGenes(), types), 'annotation-coverage.csv'); });
		return b;
	}

	// Draws the page once and returns update(), which redraws after data.status, data.progress or gene flags change.
	function render(el, data, navigate, context, retry) {
		clear(el);
		var wrap = node('div', null, 'alliance-annotation-coverage');
		el.appendChild(wrap);
		var genes = data.genes;
		var types = data.types;
		if (!genes.length || !types.length) {
			wrap.appendChild(node('p', 'No annotation coverage to show for these genes', 'agr-empty'));
			var extra = [data.note, data.notFound ? count(data.notFound, 'id') + ' not found in this mine.' : ''].filter(Boolean).join(' ');
			if (extra) wrap.appendChild(node('p', extra, 'agr-note'));
			return function () {};
		}
		var view = { organism: '', mode: '', sort: null, dir: 1, page: 0, saved: false };
		var canSave = context && typeof context.saveList === 'function';
		var organisms = coverage(genes, types).map(function (o) { return o.organism; });

		wrap.appendChild(node('p', count(genes.length, 'gene') + '. Bars show the share of genes with at least one annotation of each type. Select a bar to list the genes without it.', 'agr-note'));
		var covBox = node('div');
		wrap.appendChild(covBox);

		var controls = node('div', null, 'agr-filter-bar');
		var orgSelect = node('select', null, 'form-control');
		orgSelect.setAttribute('aria-label', 'Organism');
		orgSelect.appendChild(option('', 'All organisms'));
		organisms.forEach(function (name) { orgSelect.appendChild(option(name, name)); });
		var modeSelect = node('select', null, 'form-control');
		modeSelect.setAttribute('aria-label', 'Genes to show');
		modeSelect.appendChild(option('', 'All genes'));
		types.forEach(function (t) { modeSelect.appendChild(option(t.key, 'Without ' + t.label)); });
		modeSelect.appendChild(option('any', 'Missing at least one type'));
		modeSelect.appendChild(option('all', 'Missing every type'));
		controls.appendChild(labelled('Organism', orgSelect));
		controls.appendChild(labelled('Show', modeSelect));
		var pageBox = node('div', null, 'agr-filter-bar');
		var tableBox = node('div');
		var saveButton = null;
		var status = node('span', null, 'agr-note');
		status.setAttribute('role', 'status');
		status.setAttribute('aria-live', 'polite');

		function shown() {
			return genes.filter(function (g) {
				return (!view.organism || g.organism === view.organism) && matches(g, view.mode, types);
			});
		}

		function drawCoverage() {
			clear(covBox);
			covBox.appendChild(renderCoverage(coverage(genes, types), data, retry, pick));
		}

		function drawTable() {
			var list = shown();
			var pages = Math.max(1, Math.ceil(list.length / ROWS_PER_PAGE));
			if (view.page >= pages) view.page = pages - 1;
			clear(tableBox);
			tableBox.appendChild(renderGeneTable(list, data, view, navigate, function (col) {
				view.dir = view.sort === col ? -view.dir : 1;
				view.sort = col;
				view.page = 0;
				drawTable();
			}));
			clear(pageBox);
			var first = list.length ? view.page * ROWS_PER_PAGE + 1 : 0;
			var last = Math.min(list.length, (view.page + 1) * ROWS_PER_PAGE);
			pageBox.appendChild(node('span', 'Genes ' + first + ' to ' + last + ' of ' + list.length, 'agr-note'));
			var prev = node('button', 'Previous', 'agr-btn agr-btn-sm');
			prev.type = 'button';
			prev.disabled = view.page === 0;
			prev.addEventListener('click', function () { view.page -= 1; drawTable(); });
			var next = node('button', 'Next', 'agr-btn agr-btn-sm');
			next.type = 'button';
			next.disabled = view.page >= pages - 1;
			next.addEventListener('click', function () { view.page += 1; drawTable(); });
			pageBox.appendChild(prev);
			pageBox.appendChild(next);
			refreshSave();
		}

		function needed() {
			return view.mode === 'any' || view.mode === 'all' ? types : [typeByKey(view.mode)];
		}

		function refreshSave() {
			if (!saveButton) return;
			if (!view.mode) {
				saveButton.textContent = 'Choose which genes to show to save them as a list';
				saveButton.disabled = true;
				return;
			}
			var failed = needed().filter(function (t) { return data.status[t.key] === 'error'; });
			if (failed.length) {
				saveButton.textContent = 'Retry ' + failed.map(function (t) { return t.label; }).join(', ') + ' to save';
				saveButton.disabled = true;
				return;
			}
			var ready = needed().every(function (t) { return data.status[t.key] === 'done'; });
			if (!ready) {
				saveButton.textContent = 'Wait for the annotation types to load';
				saveButton.disabled = true;
				return;
			}
			var n = shown().length;
			saveButton.textContent = 'Save ' + count(n, 'gene') + ' ' + modeLabel(view.mode) + (view.organism ? ' in ' + view.organism : '') + ' as list';
			saveButton.disabled = n === 0 || view.saved;
		}

		function changed() {
			view.page = 0;
			view.saved = false;
			status.textContent = '';
			drawTable();
		}

		function pick(organism, key) {
			view.organism = organism;
			view.mode = key;
			orgSelect.value = organism;
			modeSelect.value = key;
			changed();
		}

		orgSelect.addEventListener('change', function () { view.organism = orgSelect.value; changed(); });
		modeSelect.addEventListener('change', function () { view.mode = modeSelect.value; changed(); });

		if (canSave) {
			saveButton = node('button', null, 'agr-btn agr-btn-primary agr-btn-sm');
			saveButton.type = 'button';
			saveButton.addEventListener('click', function () {
				if (!view.mode || view.saved) return;
				var ids = shown().map(function (g) { return g.id; });
				view.saved = true;
				saveButton.disabled = true;
				status.textContent = 'Saving...';
				context
					.saveList({ name: listName(view.mode, new Date(), view.organism), class: 'Gene', ids: ids, tags: [TAG] })
					.then(function (name) { status.textContent = 'Saved list ' + name; })
					.catch(function (err) {
						view.saved = false;
						status.textContent = err && err.message === 'login required' ? 'Log in to save lists' : 'Could not save the list';
					})
					.then(refreshSave);
			});
			controls.appendChild(saveButton);
			controls.appendChild(status);
		}
		controls.appendChild(csvButton(shown, types));
		wrap.appendChild(controls);
		wrap.appendChild(pageBox);
		wrap.appendChild(tableBox);
		var notes = node('p', null, 'agr-note');
		wrap.appendChild(notes);

		function update() {
			notes.textContent = [data.note, data.notFound ? count(data.notFound, 'id') + ' not found in this mine.' : ''].filter(Boolean).join(' ');
			drawCoverage();
			drawTable();
		}
		update();
		return update;
	}

	function wait(ms) {
		return new Promise(function (resolve) { setTimeout(resolve, ms); });
	}

	function retryDelay(err, attempt) {
		var after = Number(err.retryAfter);
		return after > 0 ? Math.min(after * 1000, 30000) : settings.retryMs * Math.pow(2, attempt);
	}

	// One POST with a timeout; 429 and 503 are retried with backoff, honouring Retry-After.
	function fetchPage(root, query, attempt) {
		attempt = attempt || 0;
		var ctl = typeof AbortController === 'function' ? new AbortController() : null;
		var timer = setTimeout(function () { if (ctl) ctl.abort(); }, settings.timeoutMs);
		return fetch(resultsUrl(root), {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: requestBody(query, 0),
			signal: ctl ? ctl.signal : undefined
		})
			.then(function (res) {
				if (!res.ok) {
					var err = new Error('HTTP ' + res.status);
					err.status = res.status;
					err.retryAfter = res.headers && res.headers.get ? res.headers.get('Retry-After') : null;
					throw err;
				}
				return res.json();
			})
			.then(function (json) {
				clearTimeout(timer);
				var results = (json && json.results) || [];
				if (results.length >= PAGE_SIZE) throw new Error('result truncated at ' + PAGE_SIZE + ' rows');
				return results;
			})
			.catch(function (err) {
				clearTimeout(timer);
				if (ctl && ctl.signal.aborted) throw new Error('timed out after ' + settings.timeoutMs / 1000 + ' s');
				if ((err.status === 429 || err.status === 503) && attempt + 1 < TRIES) {
					return wait(retryDelay(err, attempt)).then(function () { return fetchPage(root, query, attempt + 1); });
				}
				throw err;
			});
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

	// Runs fn over items with at most `limit` in flight. fn must not reject.
	function pool(items, limit, fn) {
		var next = 0;
		function worker() {
			if (next >= items.length) return Promise.resolve();
			return fn(items[next++]).then(worker);
		}
		var workers = [];
		for (var i = 0; i < Math.min(limit, items.length); i++) workers.push(worker());
		return Promise.all(workers);
	}

	function fetchInfo(root, ids) {
		return sequence(chunks(ids, CHUNK), function (part) {
			return fetchPage(root, infoQuery(part));
		}).then(function (parts) {
			return [].concat.apply([], parts);
		});
	}

	// Resolves to {geneId: true} for the genes with at least one annotation of the type.
	function fetchPresence(root, type, ids, onProgress) {
		var parts = chunks(ids, CHUNK);
		var done = 0;
		return sequence(parts, function (part) {
			return fetchPage(root, presenceQuery(type, part)).then(function (rows) {
				done += 1;
				if (onProgress) onProgress(done, parts.length);
				return rows;
			});
		}).then(function (all) {
			var present = {};
			[].concat.apply([], all).forEach(function (r) { present[r[0]] = true; });
			return present;
		});
	}

	function idsOf(entity) {
		var gene = entity && entity.Gene;
		var raw = gene && gene.value;
		var list = Array.isArray(raw) ? raw : [raw];
		return unique(
			list
				.filter(function (id) { return id !== undefined && id !== null && id !== ''; })
				.map(String)
		);
	}

	function main(el, service, imEntity, state, config, navigate, context) {
		if (!el || !service || !imEntity) {
			throw new Error('Call main with correct signature');
		}
		var token = (el.__agrCoverageReq = (el.__agrCoverageReq || 0) + 1);
		var current = function () { return el.__agrCoverageReq === token; };
		var ids = idsOf(imEntity);
		if (!ids.length) {
			message(el, 'No annotation coverage to show for these genes');
			return;
		}
		var mine = service.root;
		var types = typesFor(service);
		message(el, 'Loading...');
		fetchInfo(mine, ids)
			.then(function (rows) {
				if (!current()) return;
				var data = {
					genes: buildGenes(rows, types, {}),
					types: types,
					note: missingNote(types),
					notFound: Math.max(0, ids.length - rows.length),
					status: {},
					progress: {},
					errors: {}
				};
				var update;
				function load(t) {
					data.status[t.key] = 'loading';
					data.progress[t.key] = 'Loading...';
					if (update) update();
					return fetchPresence(mine, t, ids, function (done, total) {
						if (!current()) return;
						data.progress[t.key] = 'Loading, ' + done + ' of ' + total + ' requests';
						update();
					}).then(
						function (present) {
							if (!current()) return;
							data.genes.forEach(function (g) { g.has[t.key] = present[g.id] === true; });
							data.status[t.key] = 'done';
							update();
						},
						function (err) {
							console.error('annotation-coverage: ' + t.key + ' failed', err);
							if (!current()) return;
							data.status[t.key] = 'error';
							data.errors[t.key] = err && err.message ? err.message : 'request failed';
							update();
						}
					);
				}
				types.forEach(function (t) { data.status[t.key] = 'loading'; data.progress[t.key] = 'Loading...'; });
				update = render(el, data, navigate, context, load);
				if (!data.genes.length || !types.length) return;
				pool(types, STREAMS, load);
			})
			.catch(function (err) {
				console.error('annotation-coverage: load failed', err);
				if (!current()) return;
				message(el, 'Could not load annotation coverage from the mine (' + (err && err.message ? err.message : 'request failed') + ')');
			});
	}

	var api = {
		main: main,
		TYPES: TYPES,
		settings: settings,
		hasPath: hasPath,
		typesFor: typesFor,
		presenceQuery: presenceQuery,
		infoQuery: infoQuery,
		requestBody: requestBody,
		buildGenes: buildGenes,
		coverage: coverage,
		withoutType: withoutType,
		matches: matches,
		toCsv: toCsv,
		listName: listName,
		chunks: chunks,
		render: render
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceAnnotationCoverage = api;
})(typeof window !== 'undefined' ? window : globalThis);
