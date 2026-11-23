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
	// Formats seen in production: AllianceMine stores curies (HGNC:11998, FB:FBgn...);
	// WormMine stores WBGene00000001, FlyMine FBgn0000001, YeastMine S000000001 (taxon 4932).
	// Bare numbers are NCBI Gene ids in the MOD mines (WormMine D. rerio 110292), so they map to nothing.
	// A bare MOD id on a gene of another species (FlyMine D. erecta, taxon 7220) maps to nothing too.
	function toAllianceCurie(primaryIdentifier, organism) {
		if (typeof primaryIdentifier !== 'string') return null;
		var id = primaryIdentifier.trim();
		if (!id) return null;
		var colon = id.indexOf(':');
		if (colon > 0) {
			var rest = id.slice(colon + 1);
			return rest ? id.slice(0, colon).toUpperCase() + ':' + rest : null;
		}
		var prefix = null;
		if (/^FBgn\d+$/.test(id)) prefix = 'FB';
		else if (/^WBGene\d+$/.test(id)) prefix = 'WB';
		else if (/^S\d{9}$/.test(id)) prefix = 'SGD';
		else if (/^ZDB-GENE-/.test(id)) prefix = 'ZFIN';
		if (!prefix) return null;
		var sp = speciesOf(organism);
		if (organism !== undefined && organism !== null && organism !== '' && (!sp || sp.prefix !== prefix)) return null;
		return prefix + ':' + id;
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
		return mineFetch(resultsUrl(root), {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: requestBody(query)
		})
			.then(function (res) {
				if (!res.ok) throw httpError(res);
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
					throw httpError(res);
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

	function taxonIdOf(taxon) {
		var m = taxon && typeof taxon.curie === 'string' && /^NCBITaxon:(\d+)$/.exec(taxon.curie);
		return m ? m[1] : '';
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
			taxon: taxonIdOf(partner.taxon),
			symbol: plain(partner.geneSymbol && partner.geneSymbol.displayText) || curie,
			species: (partner.taxon && partner.taxon.name) || '',
			type: nameOf(d.interactionType),
			method: nameOf(d.detectionMethod),
			source: nameOf(d.interactionSource) || nameOf(d.aggregationDatabase),
			pmids: pmidsOf(d.evidence)
		};
	}

	// Prefixes whose mines store the id without the prefix (FBgn..., WBGene..., S000..., ZDB-GENE-...).
	// Bare numeric ids (HGNC:20 as 20) are not tried: they collide across species.
	var BARE_PREFIXES = { FB: true, WB: true, SGD: true, ZFIN: true };

	// Mine identifiers that could hold a partner: the CURIE, plus the bare form for BARE_PREFIXES.
	function candidateIds(curie) {
		var out = [curie];
		var i = curie.indexOf(':');
		if (i > 0 && curie.slice(i + 1) && BARE_PREFIXES[curie.slice(0, i)]) out.push(curie.slice(i + 1));
		return out;
	}

	// YeastMine tags S. cerevisiae with taxon 4932; the Alliance uses 559292.
	function normTaxon(t) {
		var s = String(t);
		return s === '4932' ? '559292' : s;
	}

	// partners: [{curie, taxon}]. Returns {curie: internal Gene.id} for the partners present in the mine.
	// A bare-id match counts only when Gene.organism.taxonId equals the partner taxon.
	function lookupPartners(mineRoot, partners) {
		if (!partners.length) return Promise.resolve({});
		var byCandidate = {};
		partners.forEach(function (p) {
			candidateIds(p.curie).forEach(function (id) {
				(byCandidate[id] = byCandidate[id] || []).push(p);
			});
		});
		var q = buildQuery(['Gene.id', 'Gene.primaryIdentifier', 'Gene.organism.taxonId'], 'Gene.primaryIdentifier', Object.keys(byCandidate));
		return postRows(mineRoot, q).then(function (rows) {
			var found = {};
			rows.forEach(function (r) {
				(byCandidate[r[1]] || []).forEach(function (p) {
					var exact = r[1] === p.curie;
					if (!exact && (!p.taxon || normTaxon(r[2]) !== normTaxon(p.taxon))) return;
					if (found[p.curie] === undefined) found[p.curie] = r[0];
				});
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
		a.rel = 'noopener noreferrer';
		a.className = 'agr-external';
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

	function emphasis(text) {
		var em = node('em', text);
		return em;
	}

	var TABS = [
		{ key: 'molecular', label: 'Molecular', empty: 'No molecular interactions for this gene' },
		{ key: 'genetic', label: 'Genetic', empty: 'No genetic interactions for this gene' }
	];

	function table(rows, mineIds, navigate) {
		var showMethod = rows.some(function (r) { return r.method; });
		var heads = ['Partner', 'Species', 'Interaction type'];
		if (showMethod) heads.push('Detection method');
		heads.push('Source', 'PMID');
		var wrap = node('div', null, 'agr-table-wrap');
		var t = node('table', null, 'agr-table agr-table-sm');
		wrap.appendChild(t);
		var headRow = node('tr');
		heads.forEach(function (h) { headRow.appendChild(colHeader(h)); });
		var thead = node('thead');
		thead.appendChild(headRow);
		t.appendChild(thead);
		var tbody = node('tbody');
		rows.forEach(function (r) {
			var tr = node('tr');
			var cells = [partnerCell(r, mineIds, navigate), r.species ? emphasis(r.species) : '', r.type];
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
		return wrap;
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
		var token = (el.__agrInterReq = (el.__agrInterReq || 0) + 1);
		var stale = function () { return el.__agrInterReq !== token; };
		var gene = imEntity.Gene;
		var raw = gene && gene.value;
		var geneId = Array.isArray(raw) ? raw[0] : raw;
		clear(el);
		var wrap = node('div', null, 'alliance-interactions');
		el.appendChild(wrap);
		if (geneId === undefined || geneId === null || geneId === '') {
			wrap.appendChild(statusNode('No gene selected', 'agr-empty'));
			return;
		}
		wrap.appendChild(statusNode('Loading...', 'agr-loading'));

		var mineRoot = serviceRoot(service.root);
		var apiBase = apiBaseOf(config);

		postRows(mineRoot, buildQuery(GENE_VIEW, 'Gene.id', [geneId]))
			.then(function (rows) {
				if (stale()) return;
				var r = rows[0];
				if (!r) {
					clear(wrap);
					wrap.appendChild(statusNode('Gene not found in this mine', 'agr-empty'));
					return;
				}
				var curie = toAllianceCurie(r[0], r[3] || r[2]);
				if (!curie) {
					clear(wrap);
					wrap.appendChild(statusNode('No Alliance gene for ' + r[0], 'agr-empty'));
					return;
				}
				start(wrap, { mineRoot: mineRoot, apiBase: apiBase, curie: curie, symbol: r[1] || r[0], navigate: navigate, stale: stale });
			})
			.catch(function (err) {
				if (stale()) return;
				console.error('interactions: gene lookup failed', err);
				clear(wrap);
				wrap.appendChild(statusNode(errorText(err, 'Could not load the gene from the mine'), 'agr-error'));
			});
	}

	function start(wrap, ctx) {
		clear(wrap);
		var bar = node('ul', null, 'agr-tabs alliance-interactions-tabs');
		bar.setAttribute('role', 'tablist');
		var panel = node('div', null, 'alliance-interactions-panel');
		var foot = node('p', 'Data from the Alliance of Genome Resources API. ', 'agr-note alliance-interactions-source');
		foot.appendChild(externalLink('View ' + ctx.symbol + ' on the Alliance', allianceGeneUrl(ctx.curie)));
		wrap.appendChild(bar);
		wrap.appendChild(panel);
		wrap.appendChild(foot);

		var st = {};
		var buttons = {};
		var active = null;
		var mineIds = {};

		function refreshLabels() {
			TABS.forEach(function (t) {
				var s = st[t.key];
				var b = buttons[t.key];
				b.textContent = s.total == null ? t.label : t.label + ' ';
				if (s.total != null) b.appendChild(node('span', '(' + s.total + ')', 'agr-count'));
			});
		}

		function showActive() {
			var s = st[active];
			var tab = TABS.filter(function (t) { return t.key === active; })[0];
			clear(panel);
			if (s.status === 'error' && !s.rows.length) {
				panel.appendChild(statusNode('Could not load ' + active + ' interactions from the Alliance', 'agr-error'));
				return;
			}
			if (s.status === 'loading' && !s.rows.length) {
				panel.appendChild(statusNode('Loading...', 'agr-loading'));
				return;
			}
			if (s.status === 'idle') return;
			if (!s.rows.length) {
				panel.appendChild(statusNode(tab.empty, 'agr-empty'));
				return;
			}
			panel.appendChild(node('p', 'Showing ' + s.rows.length + ' of ' + s.total, 'agr-note alliance-interactions-summary'));
			panel.appendChild(table(s.rows, mineIds, ctx.navigate));
			if (s.status === 'error') panel.appendChild(statusNode('Could not load more ' + active + ' interactions', 'agr-error'));
			if (!s.done && s.rows.length < s.total) {
				var more = node('button', s.status === 'loading' ? 'Loading...' : 'Load more', 'agr-btn agr-btn-sm');
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
					if (res.results.length < PAGE_SIZE) s.done = true;
					return lookupPartners(ctx.mineRoot, rows.map(function (r) { return { curie: r.curie, taxon: r.taxon }; }))
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
			st[t.key] = { status: 'idle', rows: [], total: null, page: 0, done: false };
			var li = node('li');
			var b = node('button', t.label);
			b.type = 'button';
			b.setAttribute('role', 'tab');
			b.setAttribute('aria-selected', 'false');
			b.addEventListener('click', function () { select(t.key); });
			buttons[t.key] = b;
			li.appendChild(b);
			bar.appendChild(li);
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
		mineFetch: mineFetch,
		errorText: errorText,
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
		candidateIds: candidateIds,
		lookupPartners: lookupPartners
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceInteractions = api;
})(typeof window !== 'undefined' ? window : globalThis);
