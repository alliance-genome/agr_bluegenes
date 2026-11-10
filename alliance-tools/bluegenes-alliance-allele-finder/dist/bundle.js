/*
 * Alleles across orthologs, a BlueGenes tool (tool API version 2).
 * Plain JavaScript without dependencies, so this file is both the source and
 * the bundle. BlueGenes loads it as a script and calls
 * bluegenesAllianceAlleleFinder.main(el, service, entity, state, config, navigate).
 */
(function (root) {
	'use strict';

	// BlueGenes passes the mine root (for example https://host/mine); the web
	// services live under /service. Accept either form.
	function serviceRoot(root) {
		var r = String(root || '').replace(/\/+$/, '');
		return /\/service$/.test(r) ? r : r + '/service';
	}

	var PUBMED_URL = 'https://pubmed.ncbi.nlm.nih.gov/';
	var MAX_ROWS = 5000;
	var KINDS = ['disease', 'phenotype'];
	var KIND_LABEL = { disease: 'Disease', phenotype: 'Phenotype' };

	// One entry per source: the gene this row belongs to, and the alleles of that gene.
	var SOURCES = [
		{ name: 'self', gene: 'Gene', alleles: 'Gene.alleles' },
		{ name: 'ortholog', gene: 'Gene.homologues.homologue', alleles: 'Gene.homologues.homologue.alleles' }
	];

	function escapeXml(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function viewFor(source, kind) {
		var ann = source.alleles + (kind === 'disease' ? '.diseaseAnnotations' : '.phenotypeAnnotations');
		var view = [
			source.gene + '.symbol',
			source.gene + '.primaryIdentifier',
			source.gene + '.organism.shortName',
			source.alleles + '.id',
			source.alleles + '.primaryIdentifier',
			source.alleles + '.symbol',
			source.alleles + '.organism.shortName',
			ann + '.ontologyTerm.identifier',
			ann + '.ontologyTerm.name'
		];
		if (kind === 'disease') {
			view.push(ann + '.qualifier', ann + '.evidence.publications.pubMedId');
		} else {
			view.push(ann + '.phenotypeStatement', ann + '.publications.pubMedId');
		}
		return { view: view, ann: ann };
	}

	// geneId is the internal Gene.id of the page's gene.
	function buildQuery(source, kind, geneId) {
		var v = viewFor(source, kind);
		// Alleles can lack an organism; the gene's species stands in for them.
		var joins = [source.alleles + '.organism'].concat(
			kind === 'disease'
				? [v.ann + '.evidence', v.ann + '.evidence.publications']
				: [v.ann + '.ontologyTerm', v.ann + '.publications']
		);
		return (
			'<query model="genomic" view="' + v.view.join(' ') + '">' +
			joins.map(function (p) { return '<join path="' + p + '" style="OUTER"/>'; }).join('') +
			'<constraint path="Gene.id" op="=" value="' + escapeXml(geneId) + '"/>' +
			'</query>'
		);
	}

	function resultsUrl(serviceRoot) {
		return serviceRoot.replace(/\/+$/, '') + '/query/results';
	}

	function requestBody(source, kind, geneId) {
		return 'format=json&size=' + MAX_ROWS + '&query=' + encodeURIComponent(buildQuery(source, kind, geneId));
	}

	// Annotation x publication rows from the service become flat records.
	function toRow(source, kind, r) {
		var termId = r[7] || null;
		var termName = r[8] || null;
		var third = r[9] || null;
		var statement = kind === 'phenotype' ? third : null;
		var label = termName || statement || termId || '';
		return {
			kind: kind,
			own: source.name === 'self',
			geneSymbol: r[0] || r[1] || '',
			geneIdentifier: r[1],
			species: r[6] || r[2] || 'Unknown species',
			alleleId: r[3],
			alleleIdentifier: r[4],
			alleleSymbol: r[5] || r[4] || '',
			termId: termId,
			termLabel: label,
			termKey: termId || 'text:' + label,
			qualifier: kind === 'disease' ? third : null,
			pubMedId: r[10] || null
		};
	}

	function cmp(a, b) {
		a = a == null ? '' : String(a);
		b = b == null ? '' : String(b);
		return a < b ? -1 : a > b ? 1 : 0;
	}

	function cmpPmid(a, b) {
		return Number(a) - Number(b) || cmp(a, b);
	}

	// Collapses annotation x publication rows to one entry per allele, term and qualifier.
	function aggregate(rows) {
		var by = {};
		var order = [];
		rows.forEach(function (row) {
			var key = [row.kind, row.alleleId, row.termKey, row.qualifier || ''].join('\u0000');
			var cur = by[key];
			if (!cur) {
				cur = by[key] = Object.assign({}, row, { pubs: [] });
				delete cur.pubMedId;
				order.push(key);
			}
			if (row.pubMedId && cur.pubs.indexOf(row.pubMedId) === -1) cur.pubs.push(row.pubMedId);
		});
		return order
			.map(function (k) {
				by[k].pubs.sort(cmpPmid);
				return by[k];
			})
			.sort(function (a, b) {
				return (
					cmp(a.species, b.species) ||
					cmp(a.geneSymbol, b.geneSymbol) ||
					cmp(a.alleleSymbol, b.alleleSymbol) ||
					cmp(a.termLabel, b.termLabel) ||
					cmp(a.qualifier, b.qualifier)
				);
			});
	}

	// Returns [{key, id, label, count}] sorted by count desc then label; count is the number of distinct alleles.
	function termCounts(entries) {
		var by = {};
		entries.forEach(function (e) {
			var t = by[e.termKey] || (by[e.termKey] = { key: e.termKey, id: e.termId, label: e.termLabel, alleles: {} });
			t.alleles[e.alleleId] = true;
		});
		return Object.keys(by)
			.map(function (k) {
				var t = by[k];
				return { key: t.key, id: t.id, label: t.label, count: Object.keys(t.alleles).length };
			})
			.sort(function (a, b) {
				return b.count - a.count || cmp(a.label, b.label);
			});
	}

	function termOptionLabel(t) {
		return t.label + (t.id ? ' (' + t.id + ')' : '') + ' - ' + t.count + (t.count === 1 ? ' allele' : ' alleles');
	}

	// Options whose label or identifier contains the text, case-insensitive.
	function filterTerms(terms, text) {
		var q = String(text || '').trim().toLowerCase();
		if (!q) return terms;
		return terms.filter(function (t) {
			return (t.label + ' ' + (t.id || '')).toLowerCase().indexOf(q) !== -1;
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

	function message(el, text) {
		clear(el);
		var wrap = node('div', null, 'alliance-allele-finder');
		wrap.appendChild(node('span', text));
		el.appendChild(wrap);
	}

	function pubLinks(cell, pubs) {
		pubs.forEach(function (id, i) {
			if (i) cell.appendChild(document.createTextNode(', '));
			var a = node('a', id);
			a.href = PUBMED_URL + encodeURIComponent(id) + '/';
			a.target = '_blank';
			a.rel = 'noopener';
			a.title = 'PubMed ' + id;
			cell.appendChild(a);
		});
	}

	function renderTable(entries, kind, navigate) {
		var table = node('table', null, 'table table-condensed table-striped');
		var heads = ['Species', 'Gene', 'Allele', 'Term'];
		if (kind === 'disease') heads.push('Qualifier');
		heads.push('Publications');
		var headRow = node('tr');
		heads.forEach(function (h) { headRow.appendChild(node('th', h)); });
		var thead = node('thead');
		thead.appendChild(headRow);
		table.appendChild(thead);

		var tbody = node('tbody');
		entries.forEach(function (e) {
			var tr = node('tr');
			tr.appendChild(node('td', e.species));
			tr.appendChild(node('td', e.geneSymbol + (e.own ? ' (this gene)' : '')));

			var alleleCell = node('td');
			var a = node('a', e.alleleSymbol);
			a.href = '#';
			a.addEventListener('click', function (ev) {
				if (ev && ev.preventDefault) ev.preventDefault();
				if (typeof navigate === 'function') navigate('report', { type: 'Allele', id: e.alleleId });
			});
			alleleCell.appendChild(a);
			tr.appendChild(alleleCell);

			tr.appendChild(node('td', e.termLabel + (e.termId && e.termId !== e.termLabel ? ' (' + e.termId + ')' : '')));
			if (kind === 'disease') tr.appendChild(node('td', e.qualifier || ''));
			var pubCell = node('td');
			pubLinks(pubCell, e.pubs);
			tr.appendChild(pubCell);
			tbody.appendChild(tr);
		});
		table.appendChild(tbody);
		return table;
	}

	function countAlleles(entries) {
		var seen = {};
		entries.forEach(function (e) { seen[e.alleleId] = true; });
		return Object.keys(seen).length;
	}

	function summaryText(entries, kind) {
		var species = {};
		entries.forEach(function (e) { species[e.species] = true; });
		var n = Object.keys(species).length;
		return (
			countAlleles(entries) + ' alleles with ' + kind + ' annotations, ' +
			termCounts(entries).length + ' terms, ' + n + ' species'
		);
	}

	function render(el, all, navigate, truncated) {
		clear(el);
		var wrap = node('div', null, 'alliance-allele-finder');
		el.appendChild(wrap);
		var byKind = {};
		KINDS.forEach(function (k) {
			byKind[k] = aggregate(all.filter(function (r) { return r.kind === k; }));
		});
		if (!byKind.disease.length && !byKind.phenotype.length) {
			wrap.appendChild(node('span', 'No alleles with disease or phenotype annotations for this gene or its orthologs'));
			return;
		}
		if (truncated) wrap.appendChild(node('p', 'Showing a truncated result: a query reached ' + MAX_ROWS + ' rows.'));

		var state = { kind: byKind.disease.length ? 'disease' : 'phenotype', term: '', filter: '' };
		var controls = node('div', null, 'alliance-allele-finder-controls');
		var toggle = node('div', null, 'btn-group alliance-allele-finder-kind');
		var filterInput = node('input', null, 'form-control alliance-allele-finder-search');
		filterInput.type = 'text';
		filterInput.placeholder = 'Search terms';
		var select = node('select', null, 'form-control alliance-allele-finder-term');
		var summary = node('p', null, 'alliance-allele-finder-summary');
		var tableHolder = node('div');
		var buttons = {};

		function visibleEntries() {
			var entries = byKind[state.kind];
			return state.term ? entries.filter(function (e) { return e.termKey === state.term; }) : entries;
		}

		function refreshTable() {
			var entries = visibleEntries();
			clear(summary);
			summary.textContent = summaryText(entries, state.kind);
			clear(tableHolder);
			if (!entries.length) tableHolder.appendChild(node('span', 'No ' + state.kind + ' annotations for this selection'));
			else tableHolder.appendChild(renderTable(entries, state.kind, navigate));
		}

		function refreshOptions() {
			var terms = termCounts(byKind[state.kind]);
			var shown = filterTerms(terms, state.filter);
			clear(select);
			var all = node('option', 'All terms (' + terms.length + ')');
			all.value = '';
			select.appendChild(all);
			shown.forEach(function (t) {
				var o = node('option', termOptionLabel(t));
				o.value = t.key;
				select.appendChild(o);
			});
			select.value = state.term;
		}

		function refreshButtons() {
			KINDS.forEach(function (k) {
				buttons[k].className = 'btn btn-default' + (k === state.kind ? ' active' : '');
			});
		}

		KINDS.forEach(function (k) {
			var b = node('button', KIND_LABEL[k] + ' (' + byKind[k].length + ')', 'btn btn-default');
			b.type = 'button';
			b.addEventListener('click', function () {
				if (state.kind === k) return;
				state.kind = k;
				state.term = '';
				state.filter = '';
				filterInput.value = '';
				refreshButtons();
				refreshOptions();
				refreshTable();
			});
			buttons[k] = b;
			toggle.appendChild(b);
		});
		filterInput.addEventListener('input', function () {
			state.filter = filterInput.value;
			refreshOptions();
		});
		select.addEventListener('change', function () {
			state.term = select.value;
			refreshTable();
		});

		controls.appendChild(toggle);
		controls.appendChild(filterInput);
		controls.appendChild(select);
		wrap.appendChild(controls);
		wrap.appendChild(summary);
		wrap.appendChild(tableHolder);
		refreshButtons();
		refreshOptions();
		refreshTable();
	}

	function fetchRows(serviceRoot, source, kind, geneId) {
		return fetch(resultsUrl(serviceRoot), {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: requestBody(source, kind, geneId)
		})
			.then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status);
				return res.json();
			})
			.then(function (json) {
				var results = (json && json.results) || [];
				return { rows: results.map(function (r) { return toRow(source, kind, r); }), full: results.length >= MAX_ROWS };
			});
	}

	function fetchAll(serviceRoot, geneId) {
		var jobs = [];
		SOURCES.forEach(function (s) {
			KINDS.forEach(function (k) { jobs.push(fetchRows(serviceRoot, s, k, geneId)); });
		});
		return Promise.all(jobs).then(function (parts) {
			return {
				rows: parts.reduce(function (acc, p) { return acc.concat(p.rows); }, []),
				truncated: parts.some(function (p) { return p.full; })
			};
		});
	}

	function main(el, service, imEntity, state, config, navigate) {
		if (!el || !service || !imEntity) {
			throw new Error('Call main with correct signature');
		}
		// main runs again on every entity change; a response for an older entity must not overwrite the newer one.
		var token = (el.__agrAlleleFinderReq = (el.__agrAlleleFinderReq || 0) + 1);
		var gene = imEntity.Gene;
		var raw = gene && gene.value;
		var id = Array.isArray(raw) ? raw[0] : raw;
		if (id === undefined || id === null || id === '') {
			message(el, 'No alleles with disease or phenotype annotations for this gene or its orthologs');
			return;
		}
		message(el, 'Loading...');
		fetchAll(serviceRoot(service.root), String(id))
			.then(function (res) {
				if (el.__agrAlleleFinderReq !== token) return;
				render(el, res.rows, navigate, res.truncated);
			})
			.catch(function (err) {
				console.error('allele-finder: load failed', err);
				if (el.__agrAlleleFinderReq !== token) return;
				message(el, 'Could not load alleles from the mine');
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
		aggregate: aggregate,
		termCounts: termCounts,
		filterTerms: filterTerms,
		render: render,
		SOURCES: SOURCES
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceAlleleFinder = api;
})(typeof window !== 'undefined' ? window : globalThis);
