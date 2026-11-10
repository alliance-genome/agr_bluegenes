/*
 * Interactions (Alliance), a BlueGenes tool (tool API version 2).
 * Plain JavaScript without dependencies, so this file is both the source and
 * the bundle. BlueGenes loads it as a script and calls
 * bluegenesAllianceInteractions.main(el, service, entity, state, config, navigate).
 *
 * Reads the gene's identifier from the mine, then pages through the Alliance
 * API molecular and genetic interaction endpoints, 50 rows at a time.
 */
(function (root) {
	'use strict';

	// BlueGenes passes the mine root (for example https://host/mine); the web
	// services live under /service. Accept either form.
	function serviceRoot(root) {
		var r = String(root || '').replace(/\/+$/, '');
		return /\/service$/.test(r) ? r : r + '/service';
	}

	var DEFAULT_API_BASE = 'https://www.alliancegenome.org/api';
	var ALLIANCE_GENE_URL = 'https://www.alliancegenome.org/gene/';
	var PUBMED_URL = 'https://pubmed.ncbi.nlm.nih.gov/';
	var PAGE_SIZE = 50;
	var TIMEOUT_MS = 20000;

	var GENE_VIEW = ['Gene.primaryIdentifier', 'Gene.symbol', 'Gene.organism.shortName', 'Gene.organism.taxonId'];

	// Alliance CURIE prefix per species, keyed by NCBI taxon id.
	var SPECIES = [
		{ taxon: '9606', prefix: 'HGNC', name: /^(H\.|Homo)\s*sapiens/i },
		{ taxon: '10090', prefix: 'MGI', name: /^(M\.|Mus)\s*musculus/i },
		{ taxon: '10116', prefix: 'RGD', name: /^(R\.|Rattus)\s*norvegicus/i },
		{ taxon: '7955', prefix: 'ZFIN', name: /^(D\.|Danio)\s*rerio/i },
		{ taxon: '7227', prefix: 'FB', name: /^(D\.|Drosophila)\s*melanogaster/i },
		{ taxon: '6239', prefix: 'WB', name: /^(C\.|Caenorhabditis)\s*elegans/i },
		{ taxon: '559292', prefix: 'SGD', name: /^(S\.|Saccharomyces)\s*cerevisiae/i }
	];

	function speciesOf(organism) {
		if (organism === undefined || organism === null) return null;
		var s = String(organism).trim().replace(/^NCBITaxon:/i, '');
		if (s === '4932') s = '559292';
		for (var i = 0; i < SPECIES.length; i++) {
			if (SPECIES[i].taxon === s || SPECIES[i].name.test(s)) return SPECIES[i];
		}
		return null;
	}

	// Alliance CURIE for a mine primaryIdentifier, or null when it cannot be mapped.
	// organism is a shortName ("M. musculus"), a taxon id (10090) or "NCBITaxon:10090".
	function toAllianceCurie(primaryIdentifier, organism) {
		if (typeof primaryIdentifier !== 'string') return null;
		var id = primaryIdentifier.trim();
		if (!id) return null;
		var colon = id.indexOf(':');
		if (colon > 0) {
			var rest = id.slice(colon + 1);
			return rest ? id.slice(0, colon).toUpperCase() + ':' + rest : null;
		}
		if (/^FBgn\d+$/.test(id)) return 'FB:' + id;
		if (/^WBGene\d+$/.test(id)) return 'WB:' + id;
		if (/^S\d{9}$/.test(id)) return 'SGD:' + id;
		if (/^ZDB-GENE-/.test(id)) return 'ZFIN:' + id;
		var sp = speciesOf(organism);
		if (sp && /^\d+$/.test(id) && (sp.prefix === 'HGNC' || sp.prefix === 'MGI' || sp.prefix === 'RGD')) {
			return sp.prefix + ':' + id;
		}
		return null;
	}

	function allianceGeneUrl(curie) {
		return ALLIANCE_GENE_URL + encodeURIComponent(curie).replace(/%3A/gi, ':');
	}

	function apiBaseOf(config) {
		var b = config && typeof config.apiBase === 'string' && config.apiBase.trim() ? config.apiBase.trim() : DEFAULT_API_BASE;
		return b.replace(/\/+$/, '');
	}

	function escapeXml(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function constraintOf(path, values) {
		return values.length === 1
			? '<constraint path="' + path + '" op="=" value="' + escapeXml(values[0]) + '"/>'
			: '<constraint path="' + path + '" op="ONE OF">' +
					values.map(function (v) { return '<value>' + escapeXml(v) + '</value>'; }).join('') +
					'</constraint>';
	}

	function buildQuery(view, path, values) {
		return '<query model="genomic" view="' + view.join(' ') + '">' + constraintOf(path, values.map(String)) + '</query>';
	}

	function resultsUrl(root) {
		return root.replace(/\/+$/, '') + '/query/results';
	}

	// Ids go in a POST body: a GET query string fails above about 250 values.
	function requestBody(query) {
		return 'format=json&query=' + encodeURIComponent(query);
	}

	function postRows(root, query) {
		return fetch(resultsUrl(root), {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: requestBody(query)
		})
			.then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status);
				return res.json();
			})
			.then(function (json) {
				return (json && json.results) || [];
			});
	}

	// GET with a 20 s timeout. A 404 means the Alliance holds no data for the gene.
	function getJson(url) {
		var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
		var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);
		var opts = { headers: { Accept: 'application/json' } };
		if (ctrl) opts.signal = ctrl.signal;
		return fetch(url, opts).then(
			function (res) {
				if (res.status === 404) {
					clearTimeout(timer);
					return { total: 0, results: [] };
				}
				if (!res.ok) {
					clearTimeout(timer);
					throw new Error('HTTP ' + res.status);
				}
				return res.json().then(
					function (j) { clearTimeout(timer); return j; },
					function (err) { clearTimeout(timer); throw err; }
				);
			},
			function (err) {
				clearTimeout(timer);
				throw err;
			}
		);
	}

	function interactionsUrl(base, curie, kind, page, limit) {
		return base + '/gene/' + encodeURIComponent(curie).replace(/%3A/gi, ':') + '/' + kind + '-interactions?limit=' + limit + '&page=' + page;
	}

	function fetchInteractions(base, curie, kind, page, limit) {
		return getJson(interactionsUrl(base, curie, kind, page, limit)).then(function (json) {
			var results = (json && json.results) || [];
			var total = json && typeof json.total === 'number' ? json.total : results.length;
			return { total: total, results: results };
		});
	}

	function plain(s) {
		return s == null ? '' : String(s).replace(/<\/?[a-zA-Z][^>]*>/g, '');
	}

	function pmidsOf(evidence) {
		var out = [];
		(evidence || []).forEach(function (e) {
			var ids = [e && e.referenceID];
			((e && e.crossReferences) || []).forEach(function (x) { ids.push(x && x.referencedCurie); });
			ids.forEach(function (id) {
				var m = typeof id === 'string' && /^PMID:(\d+)$/i.exec(id.trim());
				if (m && out.indexOf(m[1]) === -1) out.push(m[1]);
			});
		});
		return out;
	}

	function nameOf(o) {
		return (o && o.name) || '';
	}

	// One API result to a table row. The partner is the end that is not the query gene.
	function toRow(result, queryCurie) {
		var d = result && (result.geneMolecularInteraction || result.geneGeneticInteraction);
		if (!d) return null;
		var a = d.geneAssociationSubject || {};
		var b = d.geneGeneAssociationObject || {};
		var partner = a.primaryExternalId === queryCurie ? b : a;
		var curie = partner.primaryExternalId;
		if (!curie) return null;
		return {
			curie: curie,
			symbol: plain(partner.geneSymbol && partner.geneSymbol.displayText) || curie,
			species: (partner.taxon && partner.taxon.name) || '',
			type: nameOf(d.interactionType),
			method: nameOf(d.detectionMethod),
			source: nameOf(d.interactionSource) || nameOf(d.aggregationDatabase),
			pmids: pmidsOf(d.evidence)
		};
	}

	// Mine identifiers that could hold a partner: the CURIE itself and its bare form.
	function candidateIds(curie) {
		var out = [curie];
		var i = curie.indexOf(':');
		if (i > 0 && curie.slice(i + 1)) out.push(curie.slice(i + 1));
		return out;
	}

	// Returns {curie: internal Gene.id} for the partners present in the mine.
	function lookupPartners(mineRoot, curies) {
		if (!curies.length) return Promise.resolve({});
		var byCandidate = {};
		curies.forEach(function (c) {
			candidateIds(c).forEach(function (id) { byCandidate[id] = c; });
		});
		var q = buildQuery(['Gene.id', 'Gene.primaryIdentifier'], 'Gene.primaryIdentifier', Object.keys(byCandidate));
		return postRows(mineRoot, q).then(function (rows) {
			var found = {};
			rows.forEach(function (r) {
				var c = byCandidate[r[1]];
				if (c && found[c] === undefined) found[c] = r[0];
			});
			return found;
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

	function externalLink(label, href, title) {
		var a = node('a', label);
		a.href = href;
		a.target = '_blank';
		a.rel = 'noopener';
		if (title) a.title = title;
		return a;
	}

	function partnerCell(row, mineIds, navigate) {
		var id = mineIds[row.curie];
		if (id === undefined) return externalLink(row.symbol, allianceGeneUrl(row.curie), 'View ' + row.curie + ' on the Alliance of Genome Resources');
		var a = node('a', row.symbol);
		a.href = '#';
		a.addEventListener('click', function (ev) {
			if (ev && ev.preventDefault) ev.preventDefault();
			if (typeof navigate === 'function') navigate('report', { type: 'Gene', id: id });
		});
		return a;
	}

	function pmidCell(pmids) {
		var span = node('span');
		pmids.forEach(function (p, i) {
			if (i) span.appendChild(document.createTextNode(', '));
			span.appendChild(externalLink(p, PUBMED_URL + p, 'PubMed ' + p));
		});
		return span;
	}

	var TABS = [
		{ key: 'molecular', label: 'Molecular', empty: 'No molecular interactions in the Alliance' },
		{ key: 'genetic', label: 'Genetic', empty: 'No genetic interactions in the Alliance' }
	];

	function table(rows, mineIds, navigate) {
		var showMethod = rows.some(function (r) { return r.method; });
		var heads = ['Partner', 'Species', 'Interaction type'];
		if (showMethod) heads.push('Detection method');
		heads.push('Source', 'PMID');
		var t = node('table', null, 'table table-condensed table-striped');
		var headRow = node('tr');
		heads.forEach(function (h) { headRow.appendChild(node('th', h)); });
		var thead = node('thead');
		thead.appendChild(headRow);
		t.appendChild(thead);
		var tbody = node('tbody');
		rows.forEach(function (r) {
			var tr = node('tr');
			var cells = [partnerCell(r, mineIds, navigate), r.species, r.type];
			if (showMethod) cells.push(r.method);
			cells.push(r.source, pmidCell(r.pmids));
			cells.forEach(function (c) {
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

	function main(el, service, imEntity, state, config, navigate) {
		if (!el || !service || !imEntity) {
			throw new Error('Call main with correct signature');
		}
		// main runs again on every entity change; a response for an older entity must not overwrite the newer one.
		var token = (el.__agrInterReq = (el.__agrInterReq || 0) + 1);
		var stale = function () { return el.__agrInterReq !== token; };
		var gene = imEntity.Gene;
		var raw = gene && gene.value;
		var geneId = Array.isArray(raw) ? raw[0] : raw;
		clear(el);
		var wrap = node('div', null, 'alliance-interactions');
		el.appendChild(wrap);
		if (geneId === undefined || geneId === null || geneId === '') {
			wrap.appendChild(node('span', 'No gene selected'));
			return;
		}
		wrap.appendChild(node('span', 'Loading...'));

		var mineRoot = serviceRoot(service.root);
		var apiBase = apiBaseOf(config);

		postRows(mineRoot, buildQuery(GENE_VIEW, 'Gene.id', [geneId]))
			.then(function (rows) {
				if (stale()) return;
				var r = rows[0];
				if (!r) {
					clear(wrap);
					wrap.appendChild(node('span', 'Gene not found in this mine'));
					return;
				}
				var curie = toAllianceCurie(r[0], r[3] || r[2]);
				if (!curie) {
					clear(wrap);
					wrap.appendChild(node('span', 'No Alliance gene for ' + r[0]));
					return;
				}
				start(wrap, { mineRoot: mineRoot, apiBase: apiBase, curie: curie, symbol: r[1] || r[0], navigate: navigate, stale: stale });
			})
			.catch(function (err) {
				if (stale()) return;
				console.error('interactions: gene lookup failed', err);
				clear(wrap);
				wrap.appendChild(node('span', 'Could not load the gene from the mine'));
			});
	}

	function start(wrap, ctx) {
		clear(wrap);
		var bar = node('div', null, 'alliance-interactions-tabs');
		bar.setAttribute('role', 'tablist');
		var panel = node('div', null, 'alliance-interactions-panel');
		var foot = node('p', 'Data from the Alliance of Genome Resources API. ', 'alliance-interactions-source');
		foot.appendChild(externalLink('View ' + ctx.symbol + ' on the Alliance', allianceGeneUrl(ctx.curie)));
		wrap.appendChild(bar);
		wrap.appendChild(panel);
		wrap.appendChild(foot);

		var st = {};
		var buttons = {};
		var active = null;
		var mineIds = {};

		function labelOf(t) {
			var s = st[t.key];
			return s.total == null ? t.label : t.label + ' (' + s.total + ')';
		}

		function refreshLabels() {
			TABS.forEach(function (t) { buttons[t.key].textContent = labelOf(t); });
		}

		function showActive() {
			var s = st[active];
			var tab = TABS.filter(function (t) { return t.key === active; })[0];
			clear(panel);
			if (s.status === 'error' && !s.rows.length) {
				panel.appendChild(node('span', 'Could not load ' + active + ' interactions from the Alliance'));
				return;
			}
			if (s.status === 'loading' && !s.rows.length) {
				panel.appendChild(node('span', 'Loading...'));
				return;
			}
			if (s.status === 'idle') return;
			if (!s.rows.length) {
				panel.appendChild(node('span', tab.empty));
				return;
			}
			panel.appendChild(node('p', 'Showing ' + s.rows.length + ' of ' + s.total, 'alliance-interactions-summary'));
			panel.appendChild(table(s.rows, mineIds, ctx.navigate));
			if (s.status === 'error') panel.appendChild(node('p', 'Could not load more ' + active + ' interactions'));
			if (s.rows.length < s.total) {
				var more = node('button', s.status === 'loading' ? 'Loading...' : 'Load more', 'btn btn-default');
				more.type = 'button';
				more.disabled = s.status === 'loading';
				more.addEventListener('click', function () { loadPage(active); });
				panel.appendChild(more);
			}
		}

		// Fetches the next page, then looks its partners up in the mine before showing them.
		function loadPage(key) {
			var s = st[key];
			if (s.status === 'loading') return;
			s.status = 'loading';
			if (active === key) showActive();
			fetchInteractions(ctx.apiBase, ctx.curie, key, s.page + 1, PAGE_SIZE)
				.then(function (res) {
					if (ctx.stale()) return null;
					var rows = res.results.map(function (r) { return toRow(r, ctx.curie); }).filter(Boolean);
					s.total = res.total;
					return lookupPartners(ctx.mineRoot, rows.map(function (r) { return r.curie; }))
						.catch(function (err) {
							console.error('interactions: partner lookup failed', err);
							return {};
						})
						.then(function (found) {
							if (ctx.stale()) return;
							Object.keys(found).forEach(function (c) { mineIds[c] = found[c]; });
							s.rows = s.rows.concat(rows);
							s.page += 1;
							s.status = 'done';
						});
				})
				.catch(function (err) {
					if (ctx.stale()) return;
					console.error('interactions: ' + key + ' failed', err);
					s.status = 'error';
				})
				.then(function () {
					if (ctx.stale()) return;
					refreshLabels();
					if (active === key) showActive();
				});
		}

		function select(key) {
			active = key;
			TABS.forEach(function (t) {
				buttons[t.key].setAttribute('aria-selected', t.key === key ? 'true' : 'false');
			});
			if (st[key].status === 'idle') loadPage(key);
			showActive();
		}

		TABS.forEach(function (t) {
			st[t.key] = { status: 'idle', rows: [], total: null, page: 0 };
			var b = node('button', t.label, 'btn btn-default');
			b.type = 'button';
			b.setAttribute('role', 'tab');
			b.setAttribute('aria-selected', 'false');
			b.addEventListener('click', function () { select(t.key); });
			buttons[t.key] = b;
			bar.appendChild(b);
		});

		select('molecular');
		// The Genetic count needs one tiny request (limit 1), not a full page.
		fetchInteractions(ctx.apiBase, ctx.curie, 'genetic', 1, 1)
			.then(function (res) {
				if (ctx.stale()) return;
				if (st.genetic.total == null) st.genetic.total = res.total;
				refreshLabels();
			})
			.catch(function (err) {
				console.error('interactions: genetic count failed', err);
			});
	}

	var api = {
		main: main,
		serviceRoot: serviceRoot,
		toAllianceCurie: toAllianceCurie,
		allianceGeneUrl: allianceGeneUrl,
		apiBaseOf: apiBaseOf,
		interactionsUrl: interactionsUrl,
		buildQuery: buildQuery,
		requestBody: requestBody,
		resultsUrl: resultsUrl,
		toRow: toRow,
		pmidsOf: pmidsOf,
		candidateIds: candidateIds
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceInteractions = api;
})(typeof window !== 'undefined' ? window : globalThis);
