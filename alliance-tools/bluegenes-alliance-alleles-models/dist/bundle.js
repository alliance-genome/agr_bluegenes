/*
 * Alleles, models and paralogs, a BlueGenes tool (tool API version 2).
 * Plain JavaScript without dependencies, so this file is both the source and
 * the bundle. BlueGenes loads it as a script and calls
 * bluegenesAllianceAllelesModels.main(el, service, entity, state, config, navigate).
 */
(function (root) {
	'use strict';

	// BlueGenes passes the mine root (for example https://host/mine); the web
	// services live under /service. Accept either form.
	function serviceRoot(root) {
		var r = String(root || '').replace(/\/+$/, '');
		return /\/service$/.test(r) ? r : r + '/service';
	}

	var MAX_ROWS = 2000;
	var MAX_ANNOTATION_ROWS = 50000;

	var ALLELE_VIEW = [
		'Gene.primaryIdentifier',
		'Gene.alleles.id',
		'Gene.alleles.primaryIdentifier',
		'Gene.alleles.alleleSymbol',
		'Gene.alleles.symbol',
		'Gene.alleles.alleleType',
		'Gene.alleles.category'
	];
	var PHENOTYPE_VIEW = ['Gene.alleles.id', 'Gene.alleles.phenotypeAnnotations.id'];
	var DISEASE_VIEW = ['Gene.alleles.id', 'Gene.alleles.diseaseAnnotations.id'];
	var MODEL_VIEW = [
		'Gene.primaryIdentifier',
		'Gene.diseaseModels.modelName',
		'Gene.diseaseModels.disease.name',
		'Gene.diseaseModels.associationType',
		'Gene.diseaseModels.dataProvider'
	];
	var PARALOG_VIEW = [
		'Gene.primaryIdentifier',
		'Gene.paralogues.paralogue.id',
		'Gene.paralogues.paralogue.primaryIdentifier',
		'Gene.paralogues.paralogue.symbol',
		'Gene.paralogues.paralogue.organism.shortName',
		'Gene.paralogues.identity',
		'Gene.paralogues.similarity',
		'Gene.paralogues.rank',
		'Gene.paralogues.predictionMethodsMatched',
		'Gene.paralogues.predictionMethodsNotMatched'
	];
	var COUNT_VIEW = {
		alleles: 'Gene.alleles.id',
		models: 'Gene.diseaseModels.id',
		paralogs: 'Gene.paralogues.id'
	};

	function escapeXml(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	// ids is one internal Gene.id or an array of them.
	function buildQuery(view, ids, sortOrder) {
		var list = (Array.isArray(ids) ? ids : [ids]).map(String);
		var constraint =
			list.length === 1
				? '<constraint path="Gene.id" op="=" value="' + escapeXml(list[0]) + '"/>'
				: '<constraint path="Gene.id" op="ONE OF">' +
					list.map(function (v) { return '<value>' + escapeXml(v) + '</value>'; }).join('') +
					'</constraint>';
		return (
			'<query model="genomic" view="' + [].concat(view).join(' ') + '"' +
			(sortOrder ? ' sortOrder="' + sortOrder + '"' : '') + '>' +
			constraint +
			'</query>'
		);
	}

	function resultsUrl(root) {
		return root.replace(/\/+$/, '') + '/query/results';
	}

	// The id list goes in a POST body: a GET query string fails above about 250 ids.
	function requestBody(query, format, size) {
		return 'format=' + format + (size ? '&size=' + size : '') + '&query=' + encodeURIComponent(query);
	}

	function post(root, query, format, size) {
		return fetch(resultsUrl(root), {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: requestBody(query, format, size)
		}).then(function (res) {
			if (!res.ok) throw new Error('HTTP ' + res.status);
			return format === 'count' ? res.text() : res.json();
		});
	}

	function fetchRows(root, query, size) {
		return post(root, query, 'json', size).then(function (json) {
			return (json && json.results) || [];
		});
	}

	function fetchCount(root, ids, which) {
		return post(root, buildQuery(COUNT_VIEW[which], ids), 'count').then(function (text) {
			var n = parseInt(String(text).trim(), 10);
			if (isNaN(n)) throw new Error('Bad count response');
			return n;
		});
	}

	// The mine stores some symbols with HTML, for example Atm<sup>tm1Bal</sup>.
	function plain(s) {
		return s == null ? '' : String(s).replace(/<\/?[a-zA-Z][^>]*>/g, '');
	}

	function cmp(a, b) {
		a = a == null ? '' : String(a);
		b = b == null ? '' : String(b);
		return a < b ? -1 : a > b ? 1 : 0;
	}

	function countBy(rows) {
		var by = {};
		rows.forEach(function (r) {
			if (r[0] != null && r[1] != null) by[r[0]] = (by[r[0]] || 0) + 1;
		});
		return by;
	}

	function toAlleleRow(r, phenotypes, diseases) {
		return {
			source: r[0],
			id: r[1],
			identifier: r[2],
			symbol: plain(r[3] || r[4]),
			type: r[5] || '',
			category: r[6] || '',
			phenotypes: phenotypes[r[1]] || 0,
			diseases: diseases[r[1]] || 0
		};
	}

	function sortAlleles(rows) {
		return rows.slice().sort(function (a, b) {
			return cmp(a.source, b.source) || cmp(a.symbol || a.identifier, b.symbol || b.identifier) || cmp(a.identifier, b.identifier);
		});
	}

	function toModelRow(r) {
		return {
			source: r[0],
			name: plain(r[1]),
			disease: r[2] || '',
			association: r[3] || '',
			provider: r[4] || ''
		};
	}

	function splitMethods(s) {
		return s ? String(s).split('|').filter(Boolean) : [];
	}

	// Matched out of the methods that made a call: matched plus not matched.
	function toParalogRow(r) {
		var matched = splitMethods(r[8]).length;
		return {
			source: r[0],
			id: r[1],
			identifier: r[2],
			symbol: r[3] || '',
			species: r[4] || '',
			identity: r[5],
			similarity: r[6],
			rank: r[7],
			matched: matched,
			total: matched + splitMethods(r[9]).length
		};
	}

	function sortParalogs(rows) {
		return rows.slice().sort(function (a, b) {
			return (
				cmp(a.source, b.source) ||
				(a.rank == null ? 1e9 : a.rank) - (b.rank == null ? 1e9 : b.rank) ||
				cmp(a.symbol || a.identifier, b.symbol || b.identifier)
			);
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

	function pct(v) {
		return v == null ? '' : v + '%';
	}

	function reportLink(label, cls, id, navigate) {
		var a = node('a', label);
		a.href = '#';
		a.addEventListener('click', function (ev) {
			if (ev && ev.preventDefault) ev.preventDefault();
			if (typeof navigate === 'function') navigate('report', { type: cls, id: id });
		});
		return a;
	}

	function table(heads, rows, cellsOf) {
		var t = node('table', null, 'table table-condensed table-striped');
		var headRow = node('tr');
		heads.forEach(function (h) { headRow.appendChild(node('th', h)); });
		var thead = node('thead');
		thead.appendChild(headRow);
		t.appendChild(thead);
		var tbody = node('tbody');
		rows.forEach(function (row) {
			var tr = node('tr');
			cellsOf(row).forEach(function (c) {
				var td = node('td');
				if (c && typeof c === 'object') td.appendChild(c);
				else td.textContent = c == null ? '' : String(c);
				tr.appendChild(td);
			});
			tbody.appendChild(tr);
		});
		t.appendChild(tbody);
		return t;
	}

	var TABS = [
		{ key: 'alleles', label: 'Alleles', empty: 'No alleles in this mine' },
		{ key: 'models', label: 'Disease models', empty: 'No disease models in this mine' },
		{ key: 'paralogs', label: 'Paralogs', empty: 'No paralogs in this mine' }
	];

	function renderPanel(panel, key, rows, navigate, multi, truncated) {
		clear(panel);
		var tab = TABS.filter(function (t) { return t.key === key; })[0];
		if (!rows.length) {
			panel.appendChild(node('span', tab.empty));
			return;
		}
		var heads;
		var cells;
		if (key === 'alleles') {
			heads = ['Identifier', 'Symbol', 'Type', 'Category', 'Phenotype annotations', 'Disease annotations'];
			cells = function (r) {
				return [reportLink(r.identifier, 'Allele', r.id, navigate), r.symbol, r.type, r.category, r.phenotypes, r.diseases];
			};
		} else if (key === 'models') {
			heads = ['Model', 'Disease', 'Association type', 'Data provider'];
			cells = function (r) { return [r.name, r.disease, r.association, r.provider]; };
		} else {
			heads = ['Symbol', 'Species', 'Identity', 'Similarity', 'Rank', 'Methods matched'];
			cells = function (r) {
				return [
					reportLink(r.symbol || r.identifier, 'Gene', r.id, navigate),
					r.species,
					pct(r.identity),
					pct(r.similarity),
					r.rank,
					r.total ? r.matched + '/' + r.total : ''
				];
			};
		}
		if (multi) {
			var inner = cells;
			heads = ['Query gene'].concat(heads);
			cells = function (r) { return [r.source].concat(inner(r)); };
		}
		if (truncated) panel.appendChild(node('p', 'Showing the first ' + MAX_ROWS + ' rows.'));
		panel.appendChild(table(heads, rows, cells));
	}

	function loadTab(root, key, ids) {
		if (key === 'alleles') {
			var sort = 'Gene.primaryIdentifier asc Gene.alleles.primaryIdentifier asc';
			return Promise.all([
				fetchRows(root, buildQuery(ALLELE_VIEW, ids, sort), MAX_ROWS),
				fetchRows(root, buildQuery(PHENOTYPE_VIEW, ids), MAX_ANNOTATION_ROWS),
				fetchRows(root, buildQuery(DISEASE_VIEW, ids), MAX_ANNOTATION_ROWS)
			]).then(function (res) {
				var ph = countBy(res[1]);
				var di = countBy(res[2]);
				return sortAlleles(res[0].map(function (r) { return toAlleleRow(r, ph, di); }));
			});
		}
		if (key === 'models') {
			return fetchRows(root, buildQuery(MODEL_VIEW, ids, 'Gene.primaryIdentifier asc Gene.diseaseModels.disease.name asc'), MAX_ROWS)
				.then(function (rows) { return rows.map(toModelRow); });
		}
		return fetchRows(root, buildQuery(PARALOG_VIEW, ids, 'Gene.primaryIdentifier asc Gene.paralogues.rank asc'), MAX_ROWS)
			.then(function (rows) { return sortParalogs(rows.map(toParalogRow)); });
	}

	function main(el, service, imEntity, state, config, navigate) {
		if (!el || !service || !imEntity) {
			throw new Error('Call main with correct signature');
		}
		// main runs again on every entity change; a response for an older entity must not overwrite the newer one.
		var token = (el.__agrAllelesReq = (el.__agrAllelesReq || 0) + 1);
		var gene = imEntity.Gene;
		var ids = gene && gene.value;
		var list = (Array.isArray(ids) ? ids : [ids]).filter(function (v) {
			return v !== undefined && v !== null && v !== '';
		});
		clear(el);
		var wrap = node('div', null, 'alliance-alleles-models');
		el.appendChild(wrap);
		if (!list.length) {
			wrap.appendChild(node('span', 'No alleles, models or paralogs in this mine'));
			return;
		}
		var root = serviceRoot(service.root);
		var multi = list.length > 1;
		var stale = function () { return el.__agrAllelesReq !== token; };

		var bar = node('div', null, 'alliance-alleles-models-tabs');
		bar.setAttribute('role', 'tablist');
		var panel = node('div', null, 'alliance-alleles-models-panel');
		wrap.appendChild(bar);
		wrap.appendChild(panel);

		var st = {};
		var buttons = {};
		var active = null;

		function labelOf(t) {
			var s = st[t.key];
			return s.count == null ? t.label : t.label + ' (' + s.count + ')';
		}

		function showActive() {
			var s = st[active];
			if (s.status === 'loading') {
				clear(panel);
				panel.appendChild(node('span', 'Loading...'));
			} else if (s.status === 'error') {
				clear(panel);
				panel.appendChild(node('span', 'Could not load ' + active + ' from the mine'));
			} else if (s.status === 'done') {
				renderPanel(panel, active, s.rows, navigate, multi, s.rows.length >= MAX_ROWS);
			}
		}

		function load(key) {
			var s = st[key];
			if (s.status !== 'idle') return;
			s.status = 'loading';
			loadTab(root, key, list)
				.then(function (rows) {
					if (stale()) return;
					s.rows = rows;
					s.status = 'done';
					if (s.count == null && rows.length < MAX_ROWS) s.count = rows.length;
				})
				.catch(function (err) {
					if (stale()) return;
					console.error('alleles-models: ' + key + ' failed', err);
					s.status = 'error';
				})
				.then(function () {
					if (stale()) return;
					refreshLabels();
					if (active === key) showActive();
				});
		}

		function refreshLabels() {
			TABS.forEach(function (t) { buttons[t.key].textContent = labelOf(t); });
		}

		function select(key) {
			active = key;
			TABS.forEach(function (t) {
				buttons[t.key].setAttribute('aria-selected', t.key === key ? 'true' : 'false');
			});
			load(key);
			showActive();
		}

		TABS.forEach(function (t) {
			st[t.key] = { status: 'idle', rows: [], count: null };
			var b = node('button', t.label, 'btn btn-default');
			b.setAttribute('type', 'button');
			b.setAttribute('role', 'tab');
			b.setAttribute('aria-selected', 'false');
			b.addEventListener('click', function () { select(t.key); });
			buttons[t.key] = b;
			bar.appendChild(b);
		});

		select('alleles');
		TABS.forEach(function (t) {
			fetchCount(root, list, t.key)
				.then(function (n) {
					if (stale()) return;
					st[t.key].count = n;
					refreshLabels();
				})
				.catch(function (err) {
					console.error('alleles-models: ' + t.key + ' count failed', err);
				});
		});
	}

	var api = {
		main: main,
		serviceRoot: serviceRoot,
		buildQuery: buildQuery,
		resultsUrl: resultsUrl,
		requestBody: requestBody,
		escapeXml: escapeXml,
		plain: plain,
		toAlleleRow: toAlleleRow,
		toModelRow: toModelRow,
		toParalogRow: toParalogRow,
		countBy: countBy
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceAllelesModels = api;
})(typeof window !== 'undefined' ? window : globalThis);
