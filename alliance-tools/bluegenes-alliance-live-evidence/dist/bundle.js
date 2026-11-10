/*
 * Alliance models, alleles and phenotypes, a BlueGenes tool (tool API version 2).
 * Plain JavaScript without dependencies, so this file is both the source and
 * the bundle. BlueGenes loads it as a script and calls
 * bluegenesAllianceLiveEvidence.main(el, service, entity, state, config, navigate).
 * It maps the gene to its Alliance curie and reads three lists from the Alliance API.
 */
(function (root) {
	'use strict';

	var DEFAULT_API_BASE = 'https://www.alliancegenome.org/api';
	var SITE_BASE = 'https://www.alliancegenome.org';
	var PAGE_SIZE = 50;
	var TIMEOUT_MS = 20000;

	// BlueGenes passes the mine root (for example https://host/mine); the web
	// services live under /service. Accept either form.
	function serviceRoot(root) {
		var r = String(root || '').replace(/\/+$/, '');
		return /\/service$/.test(r) ? r : r + '/service';
	}

	// Alliance gene curie prefix and bare-id pattern per species, keyed by NCBI taxon id.
	var SPECIES = {
		// Bare numbers are Entrez or NCBI Gene ids (HumanMine, and the MOD mines for
		// non-native species such as WormMine D. rerio 110292), not HGNC, MGI or RGD ids,
		// so only curies map. AllianceMine and the MOD mines store those as curies.
		'9606': { prefix: 'HGNC', bare: null },
		'10090': { prefix: 'MGI', bare: null },
		'10116': { prefix: 'RGD', bare: null },
		'7955': { prefix: 'ZFIN', bare: /^ZDB-GENE-/ },
		'7227': { prefix: 'FB', bare: /^FBgn\d+$/ },
		'6239': { prefix: 'WB', bare: /^WBGene\d+$/ },
		'559292': { prefix: 'SGD', bare: /^S\d+$/ }
	};
	var SHORT_NAMES = {
		'h. sapiens': '9606',
		'm. musculus': '10090',
		'r. norvegicus': '10116',
		'd. rerio': '7955',
		'd. melanogaster': '7227',
		'c. elegans': '6239',
		's. cerevisiae': '559292'
	};
	var KNOWN_PREFIXES = ['HGNC', 'MGI', 'RGD', 'ZFIN', 'FB', 'WB', 'SGD'];

	function speciesOf(organism) {
		var key = String(organism == null ? '' : organism).trim().toLowerCase();
		if (key === '4932') key = '559292';
		return SPECIES[SHORT_NAMES[key] || key] || null;
	}

	// Returns the Alliance curie for a mine gene identifier, or null when it cannot be mapped.
	// organism is an organism short name ("D. melanogaster") or an NCBI taxon id.
	function toAllianceCurie(primaryIdentifier, organism) {
		var id = String(primaryIdentifier == null ? '' : primaryIdentifier).trim();
		if (!id) return null;
		var m = /^([A-Za-z]+):(.+)$/.exec(id);
		if (m && KNOWN_PREFIXES.indexOf(m[1].toUpperCase()) !== -1) {
			return m[1].toUpperCase() + ':' + m[2];
		}
		var sp = speciesOf(organism);
		if (!sp) return null;
		return sp.bare && sp.bare.test(id) ? sp.prefix + ':' + id : null;
	}

	function escapeXml(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function buildQuery(view, id) {
		return (
			'<query model="genomic" view="' + view.join(' ') + '">' +
			'<constraint path="Gene.id" op="=" value="' + escapeXml(id) + '"/>' +
			'</query>'
		);
	}

	function resultsUrl(root) {
		return root.replace(/\/+$/, '') + '/query/results';
	}

	function post(root, query, format) {
		return fetch(resultsUrl(root), {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: 'format=' + format + '&query=' + encodeURIComponent(query)
		}).then(function (res) {
			if (!res.ok) throw new Error('HTTP ' + res.status);
			return format === 'count' ? res.text() : res.json();
		});
	}

	var GENE_VIEW = ['Gene.primaryIdentifier', 'Gene.symbol', 'Gene.organism.shortName', 'Gene.organism.taxonId'];

	function fetchGene(root, id) {
		return post(root, buildQuery(GENE_VIEW, id), 'json').then(function (json) {
			var row = json && json.results && json.results[0];
			if (!row) return null;
			return { primaryIdentifier: row[0], symbol: row[1] || '', organism: row[2] || '', taxonId: row[3] };
		});
	}

	// True when the model has the dotted path (for example Gene.diseaseModels), following
	// each referenced type and the extends chain. FlyMine, WormMine and YeastMine have no
	// Gene.diseaseModels, and a query on a missing path fails with HTTP 400.
	function modelHasPath(classes, path) {
		function member(cls, name) {
			var c = classes[cls];
			if (!c) return null;
			var hit = (c.attributes && c.attributes[name]) || (c.references && c.references[name]) || (c.collections && c.collections[name]);
			if (hit) return hit;
			var parents = c.extends || [];
			for (var i = 0; i < parents.length; i++) {
				var found = member(parents[i], name);
				if (found) return found;
			}
			return null;
		}
		var parts = path.split('.');
		var cls = parts[0];
		for (var i = 1; i < parts.length; i++) {
			var m = member(cls, parts[i]);
			if (!m) return false;
			cls = m.referencedType;
		}
		return !!classes[parts[0]];
	}

	// One model request per mine root and page load.
	var modelChecks = {};

	function mineHasDiseaseModels(root) {
		if (!modelChecks[root]) {
			modelChecks[root] = fetch(root.replace(/\/+$/, '') + '/model?format=json', { headers: { Accept: 'application/json' } })
				.then(function (res) {
					if (!res.ok) throw new Error('HTTP ' + res.status);
					return res.json();
				})
				.then(function (json) {
					var classes = json && json.model && json.model.classes;
					if (!classes) throw new Error('Bad model response');
					return modelHasPath(classes, 'Gene.diseaseModels');
				});
			modelChecks[root].catch(function () { delete modelChecks[root]; });
		}
		return modelChecks[root];
	}

	// Cheap count of the mine's own disease models for this gene.
	function fetchMineModelCount(root, id) {
		return post(root, buildQuery(['Gene.diseaseModels.id'], id), 'count').then(function (txt) {
			var n = parseInt(String(txt).trim(), 10);
			if (isNaN(n)) throw new Error('Bad count response');
			return n;
		});
	}

	function configOf(config) {
		return (config && config.config) || config || {};
	}

	function apiBaseOf(config) {
		var base = configOf(config).apiBase;
		return (typeof base === 'string' && base ? base : DEFAULT_API_BASE).replace(/\/+$/, '');
	}

	function hideOptionOf(config) {
		return configOf(config).hideInAllianceMine !== false;
	}

	function geneUrl(curie) {
		return SITE_BASE + '/gene/' + encodeURIComponent(curie);
	}

	function apiUrl(base, curie, endpoint, page) {
		return base + '/gene/' + encodeURIComponent(curie) + '/' + endpoint + '?limit=' + PAGE_SIZE + '&page=' + page +
			(endpoint === 'alleles' ? '&sortBy=alleleSymbol' : '');
	}

	// Resolves to { total, results }. A 404 means the Alliance has no data: total 0.
	function fetchApi(url) {
		var ctl = typeof AbortController === 'function' ? new AbortController() : null;
		var timer = ctl ? setTimeout(function () { ctl.abort(); }, TIMEOUT_MS) : null;
		var done = function () { if (timer) clearTimeout(timer); };
		return fetch(url, { headers: { Accept: 'application/json' }, signal: ctl ? ctl.signal : undefined })
			.then(function (res) {
				if (res.status === 404) return { total: 0, results: [] };
				if (!res.ok) throw new Error('HTTP ' + res.status);
				return res.json().then(function (j) {
					var results = (j && j.results) || [];
					return { total: j && typeof j.total === 'number' ? j.total : results.length, results: results };
				});
			})
			.then(
				function (v) { done(); return v; },
				function (e) {
					done();
					if (e && e.name === 'AbortError') throw new Error('Request timed out after ' + TIMEOUT_MS / 1000 + ' s');
					throw e;
				}
			);
	}

	// The API returns some names with HTML, for example Atm<sup>tm1Bal</sup>.
	function plain(s) {
		return s == null ? '' : String(s).replace(/<\/?[a-zA-Z][^>]*>/g, '');
	}

	function textOf(o) {
		return o ? plain(o.displayText || o.formatText) : '';
	}

	function toModelRow(r) {
		var model = r.model || {};
		var dm = r.diseaseModels || [];
		return {
			id: model.primaryExternalId || model.curie || '',
			name: textOf(model.agmFullName),
			type: (model.subtype && model.subtype.name) || '',
			disease: dm.map(function (d) { return plain((d.disease && d.disease.name) || d.diseaseModel || ''); }).filter(Boolean).join(', '),
			association: dm.map(function (d) { return d.associationType; }).filter(Boolean).join(', '),
			provider: r.dataProvider || (model.dataProvider && model.dataProvider.abbreviation) || ''
		};
	}

	function toAlleleRow(r) {
		var a = r.allele || {};
		var v = (r.variantList || [])[0];
		var loc = v && v.curatedVariantGenomicLocations && v.curatedVariantGenomicLocations[0];
		var id = a.primaryExternalId || a.curie || '';
		return {
			id: id,
			symbol: textOf(a.alleleSymbol) || (loc && loc.hgvs) || id,
			type: r.alterationType || (v && v.variantType && v.variantType.name) || '',
			phenotype: r.hasPhenotype ? 'yes' : 'no',
			disease: r.hasDisease ? 'yes' : 'no'
		};
	}

	function toPhenotypeRow(r) {
		var sources = {};
		(r.primaryAnnotations || []).forEach(function (p) {
			var ab = p.dataProvider && p.dataProvider.abbreviation;
			if (ab) sources[ab] = true;
		});
		return {
			phenotype: plain(r.phenotypeStatement),
			sources: Object.keys(sources).sort().join(', '),
			publications: (r.pubmedPublications || []).length || (r.references || []).length
		};
	}

	var TABS = [
		{ key: 'models', label: 'Disease models', endpoint: 'models', toRow: toModelRow, empty: 'No disease models in the Alliance for this gene' },
		{ key: 'alleles', label: 'Alleles', endpoint: 'alleles', toRow: toAlleleRow, empty: 'No alleles in the Alliance for this gene' },
		{ key: 'phenotypes', label: 'Phenotypes', endpoint: 'phenotypes', toRow: toPhenotypeRow, empty: 'No phenotypes in the Alliance for this gene' }
	];

	var COLUMNS = {
		models: { heads: ['Model', 'Type', 'Disease', 'Association', 'Provider'], cells: function (r) { return [r.name || r.id, r.type, r.disease, r.association, r.provider]; } },
		alleles: { heads: ['Symbol', 'Identifier', 'Type', 'Phenotype', 'Disease'], cells: function (r) { return [r.symbol, r.id, r.type, r.phenotype, r.disease]; } },
		phenotypes: { heads: ['Phenotype', 'Sources', 'Publications'], cells: function (r) { return [r.phenotype, r.sources, r.publications]; } }
	};

	function node(tag, txt, className) {
		var e = document.createElement(tag);
		if (txt !== undefined && txt !== null) e.textContent = String(txt);
		if (className) e.className = className;
		return e;
	}

	function clear(el) {
		while (el.firstChild) el.removeChild(el.firstChild);
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
			cellsOf(row).forEach(function (c) { tr.appendChild(node('td', c == null ? '' : c)); });
			tbody.appendChild(tr);
		});
		t.appendChild(tbody);
		return t;
	}

	function pad(n) { return n < 10 ? '0' + n : String(n); }

	function timeStamp(d) {
		return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
	}

	function attribution(curie) {
		var p = node('p', null, 'alliance-live-evidence-source');
		p.appendChild(node('span', 'Data from the Alliance of Genome Resources API. '));
		var a = node('a', 'Gene page for ' + curie);
		a.href = geneUrl(curie);
		a.setAttribute('target', '_blank');
		a.setAttribute('rel', 'noopener noreferrer');
		p.appendChild(a);
		return p;
	}

	function main(el, service, imEntity, state, config, navigate) {
		if (!el || !service || !imEntity) {
			throw new Error('Call main with correct signature');
		}
		// main runs again on every entity change; a response for an older entity must not overwrite the newer one.
		var token = (el.__agrLiveReq = (el.__agrLiveReq || 0) + 1);
		var stale = function () { return el.__agrLiveReq !== token; };
		var gene = imEntity.Gene;
		var value = gene && gene.value;
		var geneId = Array.isArray(value) ? value[0] : value;
		clear(el);
		var wrap = node('div', null, 'alliance-live-evidence');
		el.appendChild(wrap);
		if (geneId === undefined || geneId === null || geneId === '') {
			wrap.appendChild(node('span', 'No gene selected'));
			return;
		}
		var root = serviceRoot(service.root);
		var base = apiBaseOf(config);
		var note = node('p', null, 'alliance-live-evidence-note');
		var bar = node('div', null, 'alliance-live-evidence-tabs');
		bar.setAttribute('role', 'tablist');
		var panel = node('div', null, 'alliance-live-evidence-panel');
		var source = node('div', null, 'alliance-live-evidence-footer');
		wrap.appendChild(note);
		wrap.appendChild(bar);
		wrap.appendChild(panel);
		wrap.appendChild(source);
		panel.appendChild(node('span', 'Loading...'));

		var curie = null;
		var st = {};
		var buttons = {};
		var active = null;

		function showMessage(msg) {
			clear(panel);
			panel.appendChild(node('span', msg));
		}

		function refreshLabels() {
			TABS.forEach(function (t) {
				var s = st[t.key];
				buttons[t.key].textContent = s.status === 'done' ? t.label + ' (' + s.total + ')' : t.label;
			});
		}

		function pager(key, s) {
			var from = (s.page - 1) * PAGE_SIZE + 1;
			var to = from + s.rows.length - 1;
			var box = node('div', null, 'alliance-live-evidence-pager');
			var prev = node('button', 'Previous', 'btn btn-default btn-sm');
			prev.setAttribute('type', 'button');
			var next = node('button', 'Next', 'btn btn-default btn-sm');
			next.setAttribute('type', 'button');
			if (s.page <= 1) prev.setAttribute('disabled', 'disabled');
			if (to >= s.total) next.setAttribute('disabled', 'disabled');
			prev.addEventListener('click', function () { if (s.page > 1) load(key, s.page - 1); });
			next.addEventListener('click', function () { if (to < s.total) load(key, s.page + 1); });
			box.appendChild(prev);
			box.appendChild(node('span', ' ' + from + '-' + to + ' of ' + s.total + ' '));
			box.appendChild(next);
			box.appendChild(node('span', ' Fetched ' + timeStamp(s.fetchedAt)));
			return box;
		}

		function showActive() {
			var s = st[active];
			var t = TABS.filter(function (x) { return x.key === active; })[0];
			if (s.status === 'idle' || s.status === 'loading') return showMessage('Loading...');
			if (s.status === 'error') return showMessage('Could not load ' + t.label.toLowerCase() + ' from the Alliance API: ' + s.error);
			clear(panel);
			if (!s.rows.length) {
				panel.appendChild(node('span', t.empty + '. Fetched ' + timeStamp(s.fetchedAt)));
				return;
			}
			var cols = COLUMNS[active];
			panel.appendChild(pager(active, s));
			panel.appendChild(table(cols.heads, s.rows, cols.cells));
		}

		function load(key, page) {
			if (!curie) return;
			var s = st[key];
			var t = TABS.filter(function (x) { return x.key === key; })[0];
			var seq = (s.seq = (s.seq || 0) + 1);
			var current = function () { return !stale() && s.seq === seq; };
			s.status = 'loading';
			if (active === key) showActive();
			fetchApi(apiUrl(base, curie, t.endpoint, page))
				.then(function (res) {
					if (!current()) return;
					s.rows = res.results.map(t.toRow);
					s.total = res.total;
					s.page = page;
					s.fetchedAt = new Date();
					s.status = 'done';
				})
				.catch(function (err) {
					if (!current()) return;
					console.error('live-evidence: ' + key + ' failed', err);
					s.status = 'error';
					s.error = err && err.message ? err.message : 'request failed';
				})
				.then(function () {
					if (!current()) return;
					refreshLabels();
					if (active === key) showActive();
				});
		}

		function select(key) {
			if (!curie) return;
			active = key;
			TABS.forEach(function (t) {
				buttons[t.key].setAttribute('aria-selected', t.key === key ? 'true' : 'false');
			});
			if (st[key].status === 'idle' || st[key].status === 'error') load(key, 1);
			else showActive();
		}

		// Tab buttons exist only once the gene maps to a curie, so no click can run with curie null.
		function buildTabs() {
			TABS.forEach(function (t) {
				st[t.key] = { status: 'idle', rows: [], total: 0, page: 1 };
				var b = node('button', t.label, 'btn btn-default');
				b.setAttribute('type', 'button');
				b.setAttribute('role', 'tab');
				b.setAttribute('aria-selected', 'false');
				b.addEventListener('click', function () { select(t.key); });
				buttons[t.key] = b;
				bar.appendChild(b);
			});
		}

		fetchGene(root, geneId)
			.then(function (g) {
				if (stale()) return;
				if (!g) return showMessage('Gene not found in this mine');
				curie = toAllianceCurie(g.primaryIdentifier, g.taxonId) || toAllianceCurie(g.primaryIdentifier, g.organism);
				if (!curie) {
					return showMessage('Cannot map ' + g.primaryIdentifier + ' (' + (g.organism || 'unknown organism') + ') to an Alliance gene id');
				}
				source.appendChild(attribution(curie));
				buildTabs();
				if (hideOptionOf(config)) {
					mineHasDiseaseModels(root)
						.then(function (has) {
							return has ? fetchMineModelCount(root, geneId) : 0;
						})
						.then(function (n) {
							if (stale() || !n) return;
							note.textContent = 'This mine already has disease model data for this gene (' + n + ' rows). The Alliance data below is a second source.';
						})
						.catch(function (err) {
							console.warn('live-evidence: mine disease model check skipped', err);
						});
				}
				select('models');
			})
			.catch(function (err) {
				if (stale()) return;
				console.error('live-evidence: gene lookup failed', err);
				showMessage('Could not read the gene from the mine');
			});
	}

	var api = {
		main: main,
		serviceRoot: serviceRoot,
		toAllianceCurie: toAllianceCurie,
		apiBaseOf: apiBaseOf,
		apiUrl: apiUrl,
		geneUrl: geneUrl,
		buildQuery: buildQuery,
		modelHasPath: modelHasPath,
		toModelRow: toModelRow,
		toAlleleRow: toAlleleRow,
		toPhenotypeRow: toPhenotypeRow,
		plain: plain
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceLiveEvidence = api;
})(typeof window !== 'undefined' ? window : globalThis);
