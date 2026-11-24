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
	var PAGE_SIZE = 2000;
	var MAX_PAGES = 25;
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
		view.push(ann + '.id');
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
		// A fixed order keeps start/size pages from overlapping or skipping rows.
		// InterMine only accepts sort paths outside the outer joins, so the annotation id is the last key.
		var order = [v.view[2], v.view[0], v.view[1], v.view[5], v.view[3], v.ann + '.id'];
		return (
			'<query model="genomic" view="' + v.view.join(' ') + '" sortOrder="' +
			order.map(function (p) { return p + ' asc'; }).join(' ') + '">' +
			joins.map(function (p) { return '<join path="' + p + '" style="OUTER"/>'; }).join('') +
			'<constraint path="Gene.id" op="=" value="' + escapeXml(geneId) + '"/>' +
			'</query>'
		);
	}

	function resultsUrl(serviceRoot) {
		return serviceRoot.replace(/\/+$/, '') + '/query/results';
	}

	function requestBody(source, kind, geneId, start) {
		return 'format=json&start=' + (start || 0) + '&size=' + PAGE_SIZE + '&query=' + encodeURIComponent(buildQuery(source, kind, geneId));
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
		var cls = text === 'Loading...' ? 'agr-loading' : /^Could not/.test(text) ? 'agr-error' : 'agr-empty';
		wrap.appendChild(statusNode(text, cls));
		el.appendChild(wrap);
	}

	function pubLinks(cell, pubs) {
		pubs.forEach(function (id, i) {
			if (i) cell.appendChild(document.createTextNode(', '));
			var a = node('a', id);
			a.href = PUBMED_URL + encodeURIComponent(id) + '/';
			a.target = '_blank';
			a.rel = 'noopener noreferrer';
			a.title = 'PubMed ' + id;
			cell.appendChild(a);
		});
	}

	// Which leading cells repeat the row above: species, then gene, then allele.
	// A cell repeats only when every cell to its left repeats too.
	function repeatFlags(prev, e) {
		var species = !!prev && prev.species === e.species;
		var gene = species && prev.geneSymbol === e.geneSymbol;
		var allele = gene && prev.alleleId === e.alleleId;
		return { species: species, gene: gene, allele: allele };
	}

	function renderTable(entries, kind, navigate) {
		var tableWrap = node('div', null, 'agr-table-wrap');
		var table = node('table', null, 'agr-table agr-table-sm');
		tableWrap.appendChild(table);
		var heads = ['Species', 'Gene', 'Allele', 'Term'];
		if (kind === 'disease') heads.push('Qualifier');
		heads.push('Publications');
		var headRow = node('tr');
		heads.forEach(function (h) { headRow.appendChild(colHeader(h)); });
		var thead = node('thead');
		thead.appendChild(headRow);
		table.appendChild(thead);

		var tbody = node('tbody');
		entries.forEach(function (e, i) {
			var rep = repeatFlags(entries[i - 1], e);
			var tr = node('tr', null, rep.allele ? 'agr-row-cont' : null);
			var speciesCell = node('td', null, rep.species ? 'agr-cell-repeat' : null);
			speciesCell.appendChild(node('em', e.species));
			tr.appendChild(speciesCell);
			tr.appendChild(node('td', e.geneSymbol + (e.own ? ' (this gene)' : ''), rep.gene ? 'agr-cell-repeat' : null));

			var alleleCell = node('td', null, rep.allele ? 'agr-cell-repeat' : null);
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
		return tableWrap;
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
			count(countAlleles(entries), 'allele') + ' with ' + kind + ' annotations, ' +
			count(termCounts(entries).length, 'term') + ', ' + count(n, 'species', 'species')
		);
	}

	function render(el, all, navigate, truncated, missing) {
		clear(el);
		var wrap = node('div', null, 'alliance-allele-finder');
		el.appendChild(wrap);
		var gaps = missingSummary(missing || []);
		var kinds = KINDS.filter(function (k) { return gaps.gone.indexOf(k) < 0; });
		var byKind = {};
		KINDS.forEach(function (k) {
			byKind[k] = aggregate(all.filter(function (r) { return r.kind === k; }));
		});
		if (!byKind.disease.length && !byKind.phenotype.length) {
			wrap.appendChild(statusNode('No alleles with disease or phenotype annotations for this gene or its orthologs', 'agr-empty'));
			if (gaps.note) wrap.appendChild(node('p', gaps.note, 'agr-note alliance-allele-finder-note'));
			return;
		}
		var notes = node('div', null, 'alliance-allele-finder-notes');
		notes.appendChild(node('p', 'Allele disease and phenotype annotations for this gene and its orthologs, from this mine.', 'agr-note'));
		if (gaps.note) notes.appendChild(node('p', gaps.note, 'agr-note alliance-allele-finder-note'));
		if (truncated) notes.appendChild(node('p', 'Partial result: a query stopped after ' + (PAGE_SIZE * MAX_PAGES) + ' rows, so allele and term counts are incomplete.', 'agr-note'));

		var state = { kind: byKind.disease.length ? 'disease' : 'phenotype', term: '', filter: '' };
		var controls = node('div', null, 'agr-filter-bar alliance-allele-finder-controls');
		var toggle = node('ul', null, 'agr-tabs alliance-allele-finder-kind');
		var filterInput = node('input', null, 'form-control alliance-allele-finder-search');
		filterInput.type = 'text';
		filterInput.placeholder = 'Search terms';
		filterInput.setAttribute('aria-label', 'Search terms');
		var select = node('select', null, 'form-control alliance-allele-finder-term');
		select.setAttribute('aria-label', 'Term');
		var summary = node('p', null, 'agr-note alliance-allele-finder-summary');
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
			if (!entries.length) tableHolder.appendChild(statusNode('No ' + state.kind + ' annotations for this selection', 'agr-empty'));
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
			kinds.forEach(function (k) {
				buttons[k].setAttribute('aria-selected', k === state.kind ? 'true' : 'false');
			});
		}

		kinds.forEach(function (k) {
			var li = node('li');
			var b = node('button', KIND_LABEL[k] + ' ');
			b.appendChild(node('span', '(' + byKind[k].length + ')', 'agr-count'));
			b.type = 'button';
			b.setAttribute('role', 'tab');
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
			li.appendChild(b);
			toggle.appendChild(li);
		});
		filterInput.addEventListener('input', function () {
			state.filter = filterInput.value;
			refreshOptions();
		});
		select.addEventListener('change', function () {
			state.term = select.value;
			refreshTable();
		});

		controls.appendChild(filterInput);
		controls.appendChild(select);
		wrap.appendChild(toggle);
		wrap.appendChild(summary);
		wrap.appendChild(controls);
		wrap.appendChild(tableHolder);
		wrap.appendChild(notes);
		refreshButtons();
		refreshOptions();
		refreshTable();
	}

	function fetchPage(serviceRoot, source, kind, geneId, start) {
		return mineFetch(resultsUrl(serviceRoot), {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: requestBody(source, kind, geneId, start)
		})
			.then(function (res) {
				if (!res.ok) {
					throw httpError(res);
				}
				return res.json();
			})
			.then(function (json) {
				return (json && json.results) || [];
			});
	}

	// Pages through the sorted result until a short page arrives; gives up after MAX_PAGES pages.
	function fetchRows(serviceRoot, source, kind, geneId) {
		var rows = [];
		function next(page) {
			return fetchPage(serviceRoot, source, kind, geneId, page * PAGE_SIZE).then(function (results) {
				results.forEach(function (r) { rows.push(toRow(source, kind, r)); });
				if (results.length < PAGE_SIZE) return { rows: rows, full: false };
				if (page + 1 >= MAX_PAGES) return { rows: rows, full: true };
				return next(page + 1);
			});
		}
		return next(0);
	}

	// missing lists the { source, kind } pairs the mine rejected with HTTP 400 (its
	// model lacks that path). Any other failure still rejects the whole load.
	function fetchAll(serviceRoot, geneId) {
		var jobs = [];
		var missing = [];
		SOURCES.forEach(function (s) {
			KINDS.forEach(function (k) {
				jobs.push(
					fetchRows(serviceRoot, s, k, geneId).catch(function (err) {
						if (err && err.status === 400) {
							missing.push({ source: s.name, kind: k });
							return { rows: [], full: false };
						}
						throw err;
					})
				);
			});
		});
		return Promise.all(jobs).then(function (parts) {
			return {
				rows: parts.reduce(function (acc, p) { return acc.concat(p.rows); }, []),
				truncated: parts.some(function (p) { return p.full; }),
				missing: missing
			};
		});
	}

	// kinds with no query working for any source, and a note for what is missing.
	function missingSummary(missing) {
		var gone = KINDS.filter(function (k) {
			return SOURCES.every(function (s) {
				return missing.some(function (m) { return m.kind === k && m.source === s.name; });
			});
		});
		var parts = missing.map(function (m) {
			return (m.source === 'self' ? 'this gene' : 'orthologs') + ' ' + m.kind;
		});
		return {
			gone: gone,
			note: parts.length ? 'This mine has no allele annotations for: ' + parts.join(', ') + '.' : ''
		};
	}

	// Paragraph that screen readers announce: errors as alerts, loading and empty states as polite status.
	function statusNode(text, cls) {
		var p = node('p', text, cls);
		p.setAttribute('role', cls === 'agr-error' ? 'alert' : 'status');
		return p;
	}

	function colHeader(text, cls) {
		var th = node('th', text, cls);
		th.setAttribute('scope', 'col');
		return th;
	}

	// "1 gene", "2 genes". many is the plural when it is not the singular plus s.
	function count(n, one, many) {
		return n + ' ' + (n === 1 ? one : many || one + 's');
	}

	var MINE_TIMEOUT_MS = 30000;
	var MINE_RETRY_DELAYS_MS = [2000, 6000];

	function httpError(res) {
		var err = new Error('HTTP ' + res.status);
		err.status = res.status;
		return err;
	}

	function retryDelay(res, fallback) {
		var h = res.headers && typeof res.headers.get === 'function' ? Number(res.headers.get('Retry-After')) : NaN;
		return h > 0 && h <= 30 ? h * 1000 : fallback;
	}

	// Mine request that aborts after 30 s and retries twice with backoff on HTTP 429 and 503.
	// options.timeoutMs and options.delays exist for tests.
	function mineFetch(url, init, options) {
		var o = options || {};
		var timeoutMs = o.timeoutMs || MINE_TIMEOUT_MS;
		var delays = o.delays || MINE_RETRY_DELAYS_MS;
		function attempt(n) {
			var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
			var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs) : null;
			function done() {
				if (timer) clearTimeout(timer);
			}
			function failure(err) {
				done();
				if (ctrl && ctrl.signal.aborted) {
					var t = new Error('Timed out after ' + timeoutMs / 1000 + ' s');
					t.timeout = true;
					throw t;
				}
				throw err;
			}
			var opts = Object.assign({}, init, ctrl ? { signal: ctrl.signal } : {});
			return fetch(url, opts).then(function (res) {
				if ((res.status === 429 || res.status === 503) && n < delays.length) {
					done();
					return new Promise(function (resolve) {
						setTimeout(resolve, retryDelay(res, delays[n]));
					}).then(function () { return attempt(n + 1); });
				}
				var readers = ['json', 'text'].filter(function (m) { return typeof res[m] === 'function'; });
				if (!res.ok || !readers.length) done();
				readers.forEach(function (m) {
					var read = res[m].bind(res);
					res[m] = function () {
						return read().then(function (v) { done(); return v; }, failure);
					};
				});
				return res;
			}, failure);
		}
		return attempt(0);
	}

	// Sentence for a failed mine request. base is the plain failure text.
	function errorText(err, base) {
		if (err && err.timeout) return base + ': ' + err.message;
		if (err && err.status === 429) return base + ': the mine is busy (HTTP 429), try again in a minute';
		if (err && err.status) return base + ' (HTTP ' + err.status + ')';
		return base;
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
				render(el, res.rows, navigate, res.truncated, res.missing);
			})
			.catch(function (err) {
				console.error('allele-finder: load failed', err);
				if (el.__agrAlleleFinderReq !== token) return;
				message(el, errorText(err, 'Could not load alleles from the mine'));
			});
	}

	var api = {
		mineFetch: mineFetch,
		count: count,
		errorText: errorText,
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
		repeatFlags: repeatFlags,
		render: render,
		SOURCES: SOURCES
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceAlleleFinder = api;
})(typeof window !== 'undefined' ? window : globalThis);
