/*
 * GO ribbon (Alliance), a BlueGenes tool (tool API version 2).
 * Plain JavaScript without dependencies, so this file is both the source and
 * the bundle. BlueGenes loads it as a script and calls
 * bluegenesAllianceGoRibbon.main(el, service, entity, state, config, navigate, context).
 * A gene list or results page gives an array of ids and runs the set view.
 * Styles are in style.css, declared in config.json under files.css.
 *
 * The gene's identifier and organism come from the mine. The GO slim ribbon
 * and the annotation details come from the Gene Ontology API, the same
 * service the alliancegenome.org gene page uses. config.apiBase overrides its
 * base URL.
 */
(function (root) {
	'use strict';

	var DEFAULT_API_BASE = 'https://api.geneontology.org/api';
	var ALLIANCE_GENE_URL = 'https://www.alliancegenome.org/gene/';
	var SUBSET = 'goslim_agr';
	var MAX_RETRY_AFTER_MS = 10000;
	var MAX_ORTHOLOGS = 8;
	var MAX_DETAIL_ROWS = 500;
	var PROTEIN_BINDING = 'GO:0005515';

	// BlueGenes passes the mine root (for example https://host/mine); the web
	// services live under /service. Accept either form.
	function serviceRoot(root) {
		var r = String(root || '').replace(/\/+$/, '');
		return /\/service$/.test(r) ? r : r + '/service';
	}

	// Request timeouts in ms and the retry schedule. Exported so tests can shorten them.
	var settings = { timeout: 20000, ribbonTimeout: 60000, backoff: 1000, retries: 2 };

	// Alliance curie prefix, bare-id pattern, organism short names and taxon ids.
	var SPECIES = [
		{ prefix: 'HGNC', bare: null, names: ['h. sapiens', 'homo sapiens'], taxon: '9606' },
		{ prefix: 'MGI', bare: null, names: ['m. musculus', 'mus musculus'], taxon: '10090' },
		{ prefix: 'RGD', bare: null, names: ['r. norvegicus', 'rattus norvegicus'], taxon: '10116' },
		{ prefix: 'ZFIN', bare: /^ZDB-GENE-/, names: ['d. rerio', 'danio rerio'], taxon: '7955' },
		{ prefix: 'FB', bare: /^FBgn\d+$/, names: ['d. melanogaster', 'drosophila melanogaster'], taxon: '7227' },
		{ prefix: 'WB', bare: /^WBGene\d+$/, names: ['c. elegans', 'caenorhabditis elegans'], taxon: '6239' },
		{ prefix: 'SGD', bare: /^S\d{9}$/, names: ['s. cerevisiae', 'saccharomyces cerevisiae'], taxon: '559292' },
		{ prefix: 'Xenbase', bare: /^XB-GENE-\d+$/, names: ['x. tropicalis', 'xenopus tropicalis'], taxon: '8364' },
		{ prefix: 'Xenbase', bare: /^XB-GENE-\d+$/, names: ['x. laevis', 'xenopus laevis'], taxon: '8355' }
	];
	// YeastMine tags S. cerevisiae with taxon 4932; the Alliance uses 559292.
	var TAXON_ALIAS = { '4932': '559292' };

	function speciesOf(organism) {
		var o = String(organism == null ? '' : organism).trim().toLowerCase().replace(/^ncbitaxon:/, '');
		if (!o) return null;
		if (TAXON_ALIAS[o]) o = TAXON_ALIAS[o];
		for (var i = 0; i < SPECIES.length; i++) {
			if (SPECIES[i].taxon === o || SPECIES[i].names.indexOf(o) >= 0) return SPECIES[i];
		}
		return null;
	}

	// Alliance gene curie from a mine's primaryIdentifier. AllianceMine already
	// stores curies (so do the MOD mines for human, mouse and rat homologues);
	// WormMine, FlyMine and YeastMine store bare ids for their own genes
	// (WBGene..., FBgn..., S000...), ZFIN genes (ZDB-GENE-...) and Xenbase genes (XB-GENE-...).
	// Bare numbers are not mapped: the MOD mines use them as NCBI Gene ids.
	// organism is a short name ("D. rerio") or a taxon id (7955, NCBITaxon:7955).
	// Returns null when no curie can be made.
	function toAllianceCurie(primaryIdentifier, organism) {
		var id = String(primaryIdentifier == null ? '' : primaryIdentifier).trim();
		if (!id) return null;
		id = id.replace(/^MGI:MGI:/i, 'MGI:');
		var colon = id.indexOf(':');
		if (colon > 0) {
			var head = id.slice(0, colon).toUpperCase();
			for (var i = 0; i < SPECIES.length; i++) {
				if (SPECIES[i].prefix.toUpperCase() === head && id.length > colon + 1) return SPECIES[i].prefix + id.slice(colon);
			}
			return null;
		}
		var sp = speciesOf(organism);
		return sp && sp.bare && sp.bare.test(id) ? sp.prefix + ':' + id : null;
	}

	function escapeXml(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	var GENE_VIEW = ['Gene.primaryIdentifier', 'Gene.symbol', 'Gene.organism.shortName', 'Gene.organism.taxonId'];
	var ORTHOLOG_VIEW = [
		'Gene.homologues.homologue.primaryIdentifier',
		'Gene.homologues.homologue.symbol',
		'Gene.homologues.homologue.organism.shortName',
		'Gene.homologues.homologue.organism.taxonId'
	];

	// Taxon ids of the Alliance species, plus 4932 for YeastMine's S. cerevisiae.
	var ALLIANCE_TAXA = SPECIES.map(function (sp) { return sp.taxon; }).concat(['4932']);

	// taxonPath, when given, limits the rows to the Alliance species so the 1000-row
	// cap is not spent on fungi or other species that have no Alliance page.
	function buildQuery(view, id, taxonPath) {
		return (
			'<query model="genomic" view="' + view.join(' ') + '">' +
			'<constraint path="Gene.id" op="=" value="' + escapeXml(id) + '"/>' +
			(taxonPath
				? '<constraint path="' + taxonPath + '" op="ONE OF">' +
					ALLIANCE_TAXA.map(function (t) { return '<value>' + t + '</value>'; }).join('') +
					'</constraint>'
				: '') +
			'</query>'
		);
	}

	function resultsUrl(sr) {
		return sr.replace(/\/+$/, '') + '/query/results';
	}

	function requestBody(query) {
		return 'format=json&size=1000&query=' + encodeURIComponent(query);
	}

	function wait(ms) {
		return new Promise(function (resolve) { setTimeout(resolve, ms); });
	}

	// One request. The timer runs until the body is read. Resolves { res, body };
	// body is parsed for 2xx and 404 responses only.
	function attempt(url, init, timeout) {
		var ctl = typeof AbortController === 'function' ? new AbortController() : null;
		var opts = Object.assign({}, init);
		if (ctl) opts.signal = ctl.signal;
		var timer = setTimeout(function () {
			if (ctl) ctl.abort();
		}, timeout);
		return fetch(url, opts)
			.then(function (res) {
				if (res.ok) return res.json().then(function (body) { return { res: res, body: body }; });
				if (res.status === 404) {
					return res.json().then(
						function (body) { return { res: res, body: body }; },
						function () { return { res: res, body: null }; }
					);
				}
				return { res: res, body: null };
			})
			.then(
				function (r) { clearTimeout(timer); return r; },
				function (err) { clearTimeout(timer); throw err; }
			);
	}

	function retryDelay(res, n) {
		var ra = res && res.headers && typeof res.headers.get === 'function' ? Number(res.headers.get('Retry-After')) : NaN;
		return ra > 0 ? Math.min(ra * 1000, MAX_RETRY_AFTER_MS) : settings.backoff * Math.pow(2, n);
	}

	// Retries on timeout, network errors, 429 and 5xx with exponential backoff.
	// Resolves { status, body } for 2xx and 404, rejects otherwise.
	function request(url, init, timeout, n) {
		n = n || 0;
		var again = function (res) {
			return wait(retryDelay(res, n)).then(function () { return request(url, init, timeout, n + 1); });
		};
		return attempt(url, init, timeout).then(
			function (r) {
				if (r.res.ok || r.res.status === 404) return { status: r.res.status, body: r.body };
				if ((r.res.status === 429 || r.res.status >= 500) && n < settings.retries) return again(r.res);
				throw new Error('HTTP ' + r.res.status);
			},
			function (err) {
				if (n < settings.retries) return again(null);
				throw err;
			}
		);
	}

	function fetchMineRows(sr, query) {
		return request(resultsUrl(sr), {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: requestBody(query)
		}, settings.timeout).then(function (r) {
			if (r.status !== 200) throw new Error('HTTP ' + r.status);
			return (r.body && r.body.results) || [];
		});
	}

	// Resolves to the parsed JSON, or null on 404 (no data).
	function fetchApiJson(url) {
		return request(url, { headers: { Accept: 'application/json' } }, settings.timeout).then(function (r) {
			return r.status === 404 ? null : r.body;
		});
	}

	var NO_UNIPROT = /No UniProtKB IDs found for\s+(.+)$/;

	// The ribbon API answers 404 for the whole request when one subject has no
	// UniProt mapping, and names the first such subject in `detail`.
	function unmapped(body, curies) {
		var detail = body && typeof body.detail === 'string' ? body.detail : '';
		var m = NO_UNIPROT.exec(detail);
		var named = m ? m[1].split(/[\s,;]+/) : [];
		return curies.filter(function (c) { return named.indexOf(c) >= 0; });
	}

	// Resolves { json, skipped }. Subjects the API cannot map are dropped from the
	// request one by one and listed in skipped.
	function fetchRibbon(base, curies) {
		var skipped = [];
		function go(list) {
			if (!list.length) return Promise.resolve({ json: null, skipped: skipped });
			return request(ribbonUrl(base, list), { headers: { Accept: 'application/json' } }, settings.ribbonTimeout).then(function (r) {
				if (r.status !== 404) return { json: r.body, skipped: skipped };
				var missing = unmapped(r.body, list);
				if (!missing.length) {
					skipped = skipped.concat(list);
					return { json: null, skipped: skipped };
				}
				skipped = skipped.concat(missing);
				return go(list.filter(function (c) { return missing.indexOf(c) < 0; }));
			});
		}
		return go(curies);
	}

	function apiBase(config) {
		var b = config && typeof config.apiBase === 'string' && config.apiBase ? config.apiBase : DEFAULT_API_BASE;
		return b.replace(/\/+$/, '');
	}

	function ribbonUrl(base, curies) {
		return (
			base + '/ontology/ribbon/?subset=' + SUBSET +
			curies.map(function (c) { return '&subject=' + encodeURIComponent(c); }).join('') +
			'&exclude_PB=true&exclude_IBA=false&cross_aspect=false'
		);
	}

	var SLIM_CHUNK = 100;

	// Splits a slim list so each request URL stays well under common 8 KB limits.
	function chunk(list, size) {
		var out = [];
		for (var i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
		return out;
	}

	// One request per chunk of slims; the responses are concatenated for toDetails,
	// which dedupes by association id.
	function fetchSlimmer(base, curie, slims) {
		return Promise.all(
			chunk(slims, SLIM_CHUNK).map(function (part) { return fetchApiJson(slimmerUrl(base, curie, part)); })
		).then(function (parts) {
			return parts.reduce(function (all, r) { return all.concat(Array.isArray(r) ? r : []); }, []);
		});
	}

	function slimmerUrl(base, curie, slims) {
		return (
			base + '/bioentityset/slimmer/function?' +
			slims.map(function (s) { return 'slim=' + encodeURIComponent(s) + '&'; }).join('') +
			'subject=' + encodeURIComponent(curie) + '&rows=-1'
		);
	}

	// Takes a mine row [primaryIdentifier, symbol, shortName, taxonId] and returns
	// a ribbon subject, or null when the gene has no Alliance curie.
	function toSubject(r) {
		var curie = toAllianceCurie(r[0], r[2]) || toAllianceCurie(r[0], r[3]);
		if (!curie) return null;
		return { curie: curie, symbol: r[1] || r[0], species: r[2] || '' };
	}

	function prefixOf(curie) {
		return curie.slice(0, curie.indexOf(':'));
	}

	// Up to max orthologs, one species at a time in turn so every species shows.
	// Homologues of the focus gene's own species are paralogs and are skipped.
	function pickOrthologs(rows, focusCurie, max) {
		var focusPrefix = prefixOf(focusCurie);
		var bySpecies = {};
		var order = [];
		var seen = {};
		rows.map(toSubject).forEach(function (s) {
			if (!s || s.curie === focusCurie || prefixOf(s.curie) === focusPrefix || seen[s.curie]) return;
			seen[s.curie] = true;
			if (!bySpecies[s.species]) {
				bySpecies[s.species] = [];
				order.push(s.species);
			}
			bySpecies[s.species].push(s);
		});
		order.sort();
		var picked = [];
		var total = order.reduce(function (n, k) { return n + bySpecies[k].length; }, 0);
		for (var round = 0; picked.length < max && picked.length < total; round++) {
			for (var i = 0; i < order.length && picked.length < max; i++) {
				if (bySpecies[order[i]][round]) picked.push(bySpecies[order[i]][round]);
			}
		}
		return { picked: picked, total: total };
	}

	// Columns in aspect order: the "all" group, the slim terms, then "other".
	function buildColumns(categories) {
		var cols = [];
		(categories || []).forEach(function (cat) {
			var groups = cat.groups || [];
			var rank = { All: 0, Term: 1, Other: 2 };
			groups
				.map(function (g, i) { return { g: g, i: i }; })
				.sort(function (a, b) { return (rank[a.g.type] || 1) - (rank[b.g.type] || 1) || a.i - b.i; })
				.forEach(function (x) {
					cols.push({
						key: x.g.type === 'Other' ? x.g.id + '-other' : x.g.id,
						id: x.g.id,
						type: x.g.type,
						label: x.g.label || x.g.id,
						aspect: cat.label || cat.id,
						aspectId: cat.id
					});
				});
		});
		return cols;
	}

	function countOf(subject, col) {
		var g = subject && subject.groups && subject.groups[col.key];
		var n = g && g.ALL && g.ALL.nb_annotations;
		return typeof n === 'number' ? n : 0;
	}

	// Heat step for a count, 0 for none and 1 to 6 matching agr-heat-1 to agr-heat-6.
	function level(n) {
		return n <= 0 ? 0 : n < 2 ? 1 : n < 4 ? 2 : n < 10 ? 3 : n < 20 ? 4 : n < 50 ? 5 : 6;
	}

	// Slim ids to ask the details endpoint for one cell.
	function slimsFor(subject, col) {
		if (col.type === 'All') return [col.aspectId];
		if (col.type === 'Term') return [col.id];
		var g = subject && subject.groups && subject.groups[col.key];
		return (g && g.ALL && g.ALL.terms) || [];
	}

	function aspectOf(assoc) {
		var c = assoc && assoc.object && assoc.object.category && assoc.object.category[0];
		return c === 'molecular_activity' ? 'molecular_function' : c;
	}

	var KEPT_REF = /^(PMID:|DOI:|GO_REF:|Reactome:)/;

	// Flattens the slimmer response and merges rows of one term and qualifier
	// across evidence codes and references. aspect filters cross-aspect rows.
	function toDetails(response, aspect) {
		var seenAssoc = {};
		var byKey = {};
		var order = [];
		(response || []).forEach(function (entry) {
			((entry && entry.assocs) || []).forEach(function (a) {
				if (!a || !a.object || a.object.id === PROTEIN_BINDING) return;
				if (aspect && aspectOf(a) && aspectOf(a) !== aspect) return;
				var aid = a.id || a.object.id + '|' + a.evidence_type + '|' + (a.reference || []).join('#');
				if (seenAssoc[aid]) return;
				seenAssoc[aid] = true;
				var negated = !!a.negated;
				var key = a.object.id + '|' + negated + '|' + (a.qualifier || []).join('-');
				var d = byKey[key];
				if (!d) {
					d = byKey[key] = { id: a.object.id, term: a.object.label || a.object.id, negated: negated, evidence: [], references: [] };
					order.push(key);
				}
				var code = a.evidence_type || '';
				if (code && d.evidence.indexOf(code) < 0) d.evidence.push(code);
				(a.reference || []).forEach(function (ref) {
					if (KEPT_REF.test(ref) && d.references.indexOf(ref) < 0) d.references.push(ref);
				});
			});
		});
		return order
			.map(function (k) { return byKey[k]; })
			.sort(function (a, b) { return a.term < b.term ? -1 : a.term > b.term ? 1 : 0; });
	}

	function refUrl(ref) {
		var m = /^PMID:(\d+)$/.exec(ref);
		if (m) return 'https://pubmed.ncbi.nlm.nih.gov/' + m[1] + '/';
		m = /^DOI:(10\..+)$/.exec(ref);
		if (m) return 'https://doi.org/' + m[1];
		return null;
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
		var cls = /^Loading/.test(text) ? 'agr-loading' : /^Could not/.test(text) ? 'agr-error' : 'agr-empty';
		var p = node('p', text, cls);
		if (cls === 'agr-error') p.setAttribute('role', 'alert');
		else if (cls === 'agr-loading') p.setAttribute('role', 'status');
		el.appendChild(p);
	}

	function link(text, href) {
		var a = node('a', text);
		a.href = href;
		a.target = '_blank';
		a.rel = 'noopener noreferrer';
		a.className = 'agr-external';
		return a;
	}

	function colHead(text, className) {
		var th = node('th', text, className);
		th.setAttribute('scope', 'col');
		return th;
	}

	function caption(table, text) {
		table.appendChild(node('caption', text, 'alliance-go-ribbon-caption'));
	}

	function renderDetails(box, subject, col, rows) {
		clear(box);
		box.appendChild(node('h4', subject.symbol + ': ' + col.label + ' (' + rows.length + ' terms)'));
		if (!rows.length) {
			box.appendChild(node('p', 'No annotations for this cell', 'agr-empty'));
			return;
		}
		var tableWrap = node('div', null, 'agr-table-wrap');
		var t = node('table', null, 'agr-table agr-table-sm');
		caption(t, subject.symbol + ': ' + col.label + ' annotations');
		tableWrap.appendChild(t);
		var hr = node('tr');
		['Term', 'Evidence code', 'Reference'].forEach(function (h) { hr.appendChild(colHead(h)); });
		var thead = node('thead');
		thead.appendChild(hr);
		t.appendChild(thead);
		var tbody = node('tbody');
		rows.slice(0, MAX_DETAIL_ROWS).forEach(function (r) {
			var tr = node('tr');
			var termTd = node('td');
			if (r.negated) termTd.appendChild(node('strong', 'NOT '));
			termTd.appendChild(link(r.term, 'https://amigo.geneontology.org/amigo/term/' + encodeURIComponent(r.id)));
			tr.appendChild(termTd);
			tr.appendChild(node('td', r.evidence.join(', ')));
			var refTd = node('td');
			r.references.forEach(function (ref, i) {
				if (i) refTd.appendChild(document.createTextNode(', '));
				var url = refUrl(ref);
				refTd.appendChild(url ? link(ref, url) : document.createTextNode(ref));
			});
			tr.appendChild(refTd);
			tbody.appendChild(tr);
		});
		t.appendChild(tbody);
		box.appendChild(tableWrap);
		if (rows.length > MAX_DETAIL_ROWS) {
			box.appendChild(node('p', 'Showing the first ' + MAX_DETAIL_ROWS + ' of ' + rows.length + ' terms', 'agr-note alliance-go-ribbon-note'));
		}
	}

	function loadCellDetails(base, box, row, col, data, isCurrent) {
		var slims = slimsFor(data, col);
		clear(box);
		if (!slims.length) {
			renderDetails(box, row, col, []);
			return;
		}
		box.appendChild(node('p', 'Loading annotations...', 'agr-loading'));
		fetchSlimmer(base, row.curie, slims)
			.then(function (resp) {
				if (isCurrent()) renderDetails(box, row, col, toDetails(resp, col.aspect));
			})
			.catch(function (err) {
				if (!isCurrent()) return;
				console.error('go-ribbon: annotation details failed', err);
				message(box, 'Could not load GO annotations from the API');
			});
	}

	// Rows are subjects ({curie, symbol, species}); ribbon is the API response.
	function renderGrid(box, rows, ribbon, onCell, selected) {
		clear(box);
		var cols = buildColumns(ribbon.categories);
		var bySubject = {};
		(ribbon.subjects || []).forEach(function (s) { bySubject[s.id] = s; });

		var gridWrap = node('div', null, 'agr-table-wrap');
		var table = node('table', null, 'alliance-go-ribbon-grid');
		caption(table, 'GO slim annotation counts per gene');
		gridWrap.appendChild(table);
		var thead = node('thead');
		var top = node('tr');
		var corner = colHead('Gene');
		corner.rowSpan = 2;
		top.appendChild(corner);
		var sub = node('tr');
		var lastAspect = null;
		var span = null;
		cols.forEach(function (c) {
			if (c.aspectId !== lastAspect) {
				span = node('th', c.aspect);
				span.setAttribute('scope', 'colgroup');
				span.colSpan = 0;
				top.appendChild(span);
				lastAspect = c.aspectId;
			}
			span.colSpan += 1;
			sub.appendChild(colHead(c.label, 'alliance-go-ribbon-group'));
		});
		thead.appendChild(top);
		thead.appendChild(sub);
		table.appendChild(thead);

		var tbody = node('tbody');
		rows.forEach(function (row) {
			var data = bySubject[row.curie];
			var tr = node('tr');
			var rowHead = node('th', row.symbol + (row.species ? ' (' : ''));
			rowHead.setAttribute('scope', 'row');
			if (row.species) {
				rowHead.appendChild(node('em', row.species));
				rowHead.appendChild(document.createTextNode(')'));
			}
			tr.appendChild(rowHead);
			cols.forEach(function (c) {
				var n = countOf(data, c);
				var lv = level(n);
				var td = node('td', null, lv ? 'agr-heat-' + lv : 'alliance-go-ribbon-l0');
				var b = node('button', n || '', 'alliance-go-ribbon-cell');
				b.setAttribute('type', 'button');
				b.setAttribute('aria-label', row.symbol + ', ' + c.label + ', ' + n + (n === 1 ? ' annotation' : ' annotations'));
				var on = !!selected && selected.curie === row.curie && selected.key === c.key;
				b.setAttribute('aria-pressed', on ? 'true' : 'false');
				if (n > 0) b.addEventListener('click', function () { onCell(row, c, data); });
				else b.disabled = true;
				td.appendChild(b);
				tr.appendChild(td);
			});
			tbody.appendChild(tr);
		});
		table.appendChild(tbody);
		box.appendChild(gridWrap);
	}

	// Gene sets (lists and results pages).
	var RIBBON_CHUNK = 15;
	var RIBBON_PARALLEL = 4;
	var MAX_SET_GENES = 300;
	var MATRIX_ROWS = 50;
	var LOOKUP_BATCH = 500;
	var MAX_LOOKUP_IDS = 2000;
	var SET_VIEW = GENE_VIEW.concat(['Gene.id']);
	var ASPECT_RANK = { All: 0, Term: 1, Other: 2 };

	function buildSetQuery(ids) {
		return (
			'<query model="genomic" view="' + SET_VIEW.join(' ') + '">' +
			'<constraint path="Gene.id" op="ONE OF">' +
			ids.map(function (v) { return '<value>' + escapeXml(v) + '</value>'; }).join('') +
			'</constraint></query>'
		);
	}

	// Takes mine rows [primaryIdentifier, symbol, shortName, taxonId, id]; keeps
	// genes with an Alliance curie, one entry per curie.
	function toSetGenes(rows) {
		var seen = {};
		var genes = [];
		rows.forEach(function (r) {
			var s = toSubject(r);
			if (!s || seen[s.curie]) return;
			seen[s.curie] = true;
			s.id = r[4];
			genes.push(s);
		});
		return genes;
	}

	function isSetMode(ids, context) {
		if (!Array.isArray(ids)) return false;
		var page = context && context.page;
		return ids.length > 1 || page === 'list' || page === 'results';
	}

	// Requests the ribbon in chunks, RIBBON_PARALLEL at a time, and merges the
	// subjects. A chunk that fails is recorded in failed and the rest still load;
	// rejects only when every chunk failed. Stops starting chunks once stale().
	function fetchRibbonSubjects(base, genes, onProgress, stale) {
		var parts = chunk(genes, RIBBON_CHUNK);
		var out = { categories: null, subjects: [], skipped: [], failed: [] };
		var next = 0;
		var done = 0;
		function worker() {
			if (next >= parts.length || stale()) return Promise.resolve();
			var part = parts[next++];
			return fetchRibbon(base, part.map(function (g) { return g.curie; }))
				.then(
					function (r) {
						if (!out.categories && r.json && r.json.categories) out.categories = r.json.categories;
						out.subjects = out.subjects.concat((r.json && r.json.subjects) || []);
						out.skipped = out.skipped.concat(r.skipped);
					},
					function (err) { out.failed.push({ genes: part, error: err }); }
				)
				.then(function () {
					done += part.length;
					onProgress(done, genes.length);
					return worker();
				});
		}
		var workers = [];
		for (var i = 0; i < Math.min(RIBBON_PARALLEL, parts.length); i++) workers.push(worker());
		return Promise.all(workers).then(function () {
			if (out.failed.length && out.failed.length === parts.length) throw out.failed[0].error;
			return out;
		});
	}

	function mergeRibbon(a, b) {
		return {
			categories: a.categories || b.categories,
			subjects: a.subjects.concat(b.subjects),
			skipped: a.skipped.concat(b.skipped),
			failed: b.failed
		};
	}

	// Per aspect, the slim terms with the genes annotated to each (count above 0).
	function summarize(ribbon, genes) {
		var bySubject = {};
		(ribbon.subjects || []).forEach(function (s) { bySubject[s.id] = s; });
		var aspects = [];
		var byAspect = {};
		buildColumns(ribbon.categories).forEach(function (col) {
			var hits = [];
			genes.forEach(function (g) {
				var n = countOf(bySubject[g.curie], col);
				if (n > 0) hits.push({ gene: g, n: n });
			});
			if (!hits.length) return;
			var a = byAspect[col.aspectId];
			if (!a) {
				a = byAspect[col.aspectId] = { id: col.aspectId, label: String(col.aspect).replace(/_/g, ' '), terms: [] };
				aspects.push(a);
			}
			a.terms.push({ col: col, genes: hits });
		});
		aspects.forEach(function (a) {
			a.terms = a.terms
				.map(function (t, i) { return { t: t, i: i }; })
				.sort(function (x, y) {
					return ASPECT_RANK[x.t.col.type] - ASPECT_RANK[y.t.col.type] ||
						(x.t.col.type === 'Term' ? y.t.genes.length - x.t.genes.length : 0) || x.i - y.i;
				})
				.map(function (x) { return x.t; });
		});
		return aspects;
	}

	function csvCell(v) {
		var s = String(v == null ? '' : v);
		if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
		return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
	}

	function toCsv(rows) {
		return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
	}

	function summaryCsv(aspects) {
		var rows = [['Aspect', 'GO ID', 'Term', 'Genes', 'Gene symbols', 'Alliance IDs']];
		aspects.forEach(function (a) {
			a.terms.forEach(function (t) {
				rows.push([
					a.label, t.col.id, t.col.label, t.genes.length,
					t.genes.map(function (h) { return h.gene.symbol; }).join('; '),
					t.genes.map(function (h) { return h.gene.curie; }).join('; ')
				]);
			});
		});
		return toCsv(rows);
	}

	// One row per gene with data, one column per slim term, cells are annotation counts.
	function geneMatrixCsv(ribbon, genes) {
		var cols = buildColumns(ribbon.categories);
		var bySubject = {};
		(ribbon.subjects || []).forEach(function (s) { bySubject[s.id] = s; });
		var rows = [['Alliance ID', 'Symbol', 'Species'].concat(cols.map(function (c) {
			return c.aspect + ': ' + c.label + (c.type === 'Other' ? '' : ' (' + c.id + ')');
		}))];
		genes.forEach(function (g) {
			var data = bySubject[g.curie];
			if (!data) return;
			rows.push([g.curie, g.symbol, g.species].concat(cols.map(function (c) { return countOf(data, c); })));
		});
		return toCsv(rows);
	}

	function termCsv(term) {
		var rows = [['Symbol', 'Alliance ID', 'Species', 'Annotations']];
		term.genes.forEach(function (h) { rows.push([h.gene.symbol, h.gene.curie, h.gene.species, h.n]); });
		return toCsv(rows);
	}

	function downloadCsv(filename, text) {
		var url = URL.createObjectURL(new Blob(['\uFEFF', text], { type: 'text/csv;charset=utf-8' }));
		var a = node('a');
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	}

	function button(text, className, onClick) {
		var b = node('button', text, className);
		b.setAttribute('type', 'button');
		b.addEventListener('click', onClick);
		return b;
	}

	function termKey(a, t) {
		return a.id + '|' + t.col.key;
	}

	function renderSummary(box, aspects, onTerm, selectedKey) {
		clear(box);
		aspects.forEach(function (a) {
			box.appendChild(node('h4', a.label));
			var wrap = node('div', null, 'agr-table-wrap');
			var table = node('table', null, 'agr-table agr-table-sm alliance-go-ribbon-set');
			caption(table, a.label + ' GO slim terms');
			var hr = node('tr');
			['GO slim term', 'GO ID', 'Genes'].forEach(function (h) { hr.appendChild(colHead(h)); });
			var thead = node('thead');
			thead.appendChild(hr);
			table.appendChild(thead);
			var tbody = node('tbody');
			a.terms.forEach(function (t) {
				var tr = node('tr');
				var termTd = node('td');
				var b = button(t.col.label, 'alliance-go-ribbon-term', function () { onTerm(a, t); });
				b.setAttribute('aria-label', t.col.label + ', ' + t.genes.length + (t.genes.length === 1 ? ' gene' : ' genes'));
				b.setAttribute('aria-pressed', selectedKey === termKey(a, t) ? 'true' : 'false');
				termTd.appendChild(b);
				tr.appendChild(termTd);
				tr.appendChild(node('td', t.col.type === 'Other' ? '' : t.col.id));
				tr.appendChild(node('td', t.genes.length));
				tbody.appendChild(tr);
			});
			table.appendChild(tbody);
			wrap.appendChild(table);
			box.appendChild(wrap);
		});
	}

	function renderTermGenes(box, term, onSave) {
		clear(box);
		box.appendChild(node('h4', term.col.label + ': ' + term.genes.length + (term.genes.length === 1 ? ' gene' : ' genes')));
		var actions = node('div', null, 'alliance-go-ribbon-actions');
		actions.appendChild(button('Download genes as CSV', 'agr-btn agr-btn-sm', function () {
			downloadCsv('go-ribbon-' + term.col.id.replace(/[^A-Za-z0-9]+/g, '-') + '.csv', termCsv(term));
		}));
		if (onSave) actions.appendChild(button('Save genes in this term as a list', 'agr-btn agr-btn-sm', onSave));
		box.appendChild(actions);
		var status = node('p', null, 'agr-note alliance-go-ribbon-status');
		status.setAttribute('role', 'status');
		box.appendChild(status);
		var wrap = node('div', null, 'agr-table-wrap');
		var table = node('table', null, 'agr-table agr-table-sm');
		caption(table, term.col.label + ' genes');
		var hr = node('tr');
		['Gene', 'Species', 'Annotations'].forEach(function (h) { hr.appendChild(colHead(h)); });
		var thead = node('thead');
		thead.appendChild(hr);
		table.appendChild(thead);
		var tbody = node('tbody');
		term.genes.forEach(function (h) {
			var tr = node('tr');
			var td = node('td');
			td.appendChild(link(h.gene.symbol, ALLIANCE_GENE_URL + encodeURIComponent(h.gene.curie)));
			tr.appendChild(td);
			tr.appendChild(node('td', h.gene.species));
			tr.appendChild(node('td', h.n));
			tbody.appendChild(tr);
		});
		table.appendChild(tbody);
		wrap.appendChild(table);
		box.appendChild(wrap);
		return status;
	}

	function saveTerm(context, term, status, total) {
		status.textContent = 'Saving...';
		var ids = term.genes.map(function (h) { return h.gene.id; });
		var list = context.list && (context.list.title || context.list.name);
		var scope = total ? 'GO slim, first ' + MAX_SET_GENES + ' of ' + total : 'GO slim';
		context
			.saveList({ name: (list || 'Results') + ' / ' + term.col.label + ' (' + scope + ')', class: 'Gene', ids: ids, tags: ['go-ribbon'] })
			.then(function (name) {
				status.textContent = 'Saved list ' + name + ' (' + ids.length + ' genes)' +
					(total ? '. Only the first ' + MAX_SET_GENES + ' of ' + total + ' genes in the source were analysed.' : '');
			})
			.catch(function (err) {
				var needsLogin = err && err.message === 'login required';
				if (!needsLogin) console.error('go-ribbon: save list failed', err);
				status.textContent = needsLogin ? 'Log in to save a list' : 'Could not save the list';
			});
	}

	function plural(n, word) {
		return n + ' ' + word + (n === 1 ? '' : 's');
	}

	function setNote(idCount, rowCount, found, shown) {
		var parts = [];
		if (idCount > MAX_LOOKUP_IDS) {
			parts.push('Only the first ' + MAX_LOOKUP_IDS + ' of ' + idCount + ' genes were looked up in the mine.');
		}
		if (rowCount > found) {
			parts.push(plural(rowCount - found, 'gene') + (rowCount - found === 1 ? ' has' : ' have') + ' no Alliance identifier and ' + (rowCount - found === 1 ? 'is' : 'are') + ' left out.');
		}
		if (found > shown) {
			parts.push('This list has ' + found + ' genes with an Alliance identifier. The ribbon covers the first ' + shown + '; ' + (found - shown) + ' are left out. Use a smaller list to cover the rest.');
		}
		return parts.join(' ');
	}

	// Mine rows for every id, in batches, ordered like ids.
	function lookupGenes(sr, ids, stale) {
		var wanted = ids.slice(0, MAX_LOOKUP_IDS);
		var order = {};
		wanted.forEach(function (id, i) { order[String(id)] = i; });
		return chunk(wanted, LOOKUP_BATCH).reduce(function (prev, part) {
			return prev.then(function (acc) {
				if (stale()) return acc;
				return fetchMineRows(sr, buildSetQuery(part)).then(function (rows) { return acc.concat(rows); });
			});
		}, Promise.resolve([])).then(function (rows) {
			return rows.sort(function (a, b) { return order[String(a[4])] - order[String(b[4])]; });
		});
	}

	function symbolList(curies, genes) {
		var sym = {};
		genes.forEach(function (g) { sym[g.curie] = g.symbol; });
		var names = curies.map(function (c) { return sym[c] || c; });
		return names.length > 10 ? names.slice(0, 10).join(', ') + ' and ' + (names.length - 10) + ' more' : names.join(', ');
	}

	function mainSet(wrap, ids, service, config, context, stale) {
		var sr = serviceRoot(service.root);
		var base = apiBase(config);
		var noteEl = node('p', null, 'agr-note alliance-go-ribbon-note');
		var issueEl = node('div', null, 'agr-note alliance-go-ribbon-note');
		var actions = node('div', null, 'alliance-go-ribbon-actions');
		var body = node('div');
		var details = node('div', null, 'alliance-go-ribbon-details');
		var source = node('p', 'Data from the Alliance of Genome Resources API (GO annotations, api.geneontology.org).', 'agr-note alliance-go-ribbon-source');
		[noteEl, issueEl, actions, body, details, source].forEach(function (n) { wrap.appendChild(n); });
		var canSave = !!context && typeof context.saveList === 'function';
		var genes = [];
		var found = 0;
		var acc = null;
		var aspects = [];
		var view = 'terms';
		var selectedTerm = null;
		var selectedCell = null;
		var cellSeq = 0;

		function showTerm(a, t) {
			selectedTerm = termKey(a, t);
			renderSummary(body, aspects, showTerm, selectedTerm);
			var status = renderTermGenes(details, t, canSave ? function () { saveTerm(context, t, status, found > genes.length ? found : 0); } : null);
		}

		function matrixRows() {
			var have = {};
			acc.subjects.forEach(function (s) { have[s.id] = true; });
			return genes.filter(function (g) { return have[g.curie]; }).slice(0, MATRIX_ROWS);
		}

		function showCell(row, col, data) {
			var mine = ++cellSeq;
			selectedCell = { curie: row.curie, key: col.key };
			renderGrid(body, matrixRows(), acc, showCell, selectedCell);
			loadCellDetails(base, details, row, col, data, function () { return !stale() && mine === cellSeq; });
		}

		function renderView() {
			clear(details);
			cellSeq++;
			if (view === 'matrix') {
				selectedCell = null;
				renderGrid(body, matrixRows(), acc, showCell, null);
			} else {
				selectedTerm = null;
				renderSummary(body, aspects, showTerm, null);
			}
			renderActions();
		}

		function renderActions() {
			clear(actions);
			actions.appendChild(button('Download summary as CSV', 'agr-btn agr-btn-sm', function () {
				downloadCsv('go-ribbon-summary.csv', summaryCsv(aspects));
			}));
			actions.appendChild(button('Download gene matrix as CSV', 'agr-btn agr-btn-sm', function () {
				downloadCsv('go-ribbon-gene-matrix.csv', geneMatrixCsv(acc, genes));
			}));
			var matrixLabel = genes.length > MATRIX_ROWS ? 'Show gene matrix (first ' + MATRIX_ROWS + ' genes)' : 'Show gene matrix';
			actions.appendChild(button(view === 'matrix' ? 'Show term list' : matrixLabel, 'agr-btn agr-btn-sm', function () {
				view = view === 'matrix' ? 'terms' : 'matrix';
				renderView();
			}));
		}

		function renderIssues() {
			clear(issueEl);
			if (acc.skipped.length) {
				var n = acc.skipped.length;
				var p = node('p', plural(n, 'gene') + (n === 1 ? ' has' : ' have') + ' no GO data in the Alliance API: ' + symbolList(acc.skipped, genes), null);
				p.setAttribute('role', 'status');
				issueEl.appendChild(p);
			}
			var failed = acc.failed.reduce(function (all, f) { return all.concat(f.genes); }, []);
			if (failed.length) {
				var q = node('p', 'GO data missing for ' + failed.length + ' of ' + genes.length + ' genes (API error). ', null);
				q.setAttribute('role', 'alert');
				q.appendChild(button('Retry', 'agr-btn agr-btn-sm', function () { load(failed); }));
				issueEl.appendChild(q);
			}
		}

		function show() {
			aspects = summarize(acc, genes);
			renderIssues();
			if (!aspects.length) {
				clear(actions);
				message(body, 'No GO annotations for these genes');
				return;
			}
			renderView();
		}

		function fail(text, label) {
			return function (err) {
				if (stale()) return;
				console.error('go-ribbon: ' + label, err);
				message(body, text);
			};
		}

		function load(toLoad) {
			var progress = function (n, total) {
				if (!stale()) message(body, 'Loading GO annotations: ' + n + ' of ' + total + ' genes');
			};
			message(body, 'Loading GO annotations: 0 of ' + toLoad.length + ' genes');
			return fetchRibbonSubjects(base, toLoad, progress, stale).then(function (r) {
				if (stale()) return;
				acc = acc ? mergeRibbon(acc, r) : r;
				show();
			}, function (err) {
				if (stale()) return;
				if (!acc) {
					fail('Could not load the GO ribbon from the API', 'ribbon failed')(err);
					return;
				}
				console.error('go-ribbon: retry failed', err);
				show();
			});
		}

		message(body, 'Loading genes from the mine...');
		lookupGenes(sr, ids, stale)
			.then(function (rows) {
				if (stale()) return null;
				var all = toSetGenes(rows);
				found = all.length;
				genes = all.slice(0, MAX_SET_GENES);
				noteEl.textContent = setNote(ids.length, rows.length, found, genes.length);
				if (!genes.length) {
					message(body, 'No Alliance identifier for these genes');
					return null;
				}
				return load(genes);
			})
			.catch(fail('Could not load the genes from the mine', 'gene lookup failed'));
	}

	function main(el, service, imEntity, state, config, navigate, context) {
		if (!el || !service || !imEntity) {
			throw new Error('Call main with correct signature');
		}
		// main runs again on every entity change; a response for an older entity must not overwrite the newer one.
		var token = (el.__agrGoRibbonReq = (el.__agrGoRibbonReq || 0) + 1);
		var stale = function () { return el.__agrGoRibbonReq !== token; };
		var gene = imEntity.Gene;
		var ids = gene && gene.value;
		var list = (Array.isArray(ids) ? ids : [ids]).filter(function (v) {
			return v !== undefined && v !== null && v !== '';
		});
		clear(el);
		var wrap = node('div', null, 'alliance-go-ribbon');
		el.appendChild(wrap);
		if (!list.length) {
			wrap.appendChild(node('p', 'No GO annotations for this gene', 'agr-empty'));
			return;
		}
		if (isSetMode(ids, context)) {
			mainSet(wrap, list, service, config, context, stale);
			return;
		}
		var sr = serviceRoot(service.root);
		var base = apiBase(config);
		var internalId = list[0];

		var controls = node('div', null, 'agr-filter-bar alliance-go-ribbon-controls');
		var ribbonNote = node('p', null, 'agr-note alliance-go-ribbon-note');
		var body = node('div');
		var details = node('div', null, 'alliance-go-ribbon-details');
		var source = node('p', null, 'agr-note alliance-go-ribbon-source');
		wrap.appendChild(controls);
		wrap.appendChild(ribbonNote);
		wrap.appendChild(body);
		wrap.appendChild(details);
		wrap.appendChild(source);
		message(body, 'Loading...');

		var focus = null;
		var orthologs = null; // { picked, total }, loaded on first use
		var seq = 0; // each view change bumps it; older responses are ignored
		var detailSeq = 0;
		var selected = null;
		var ribbon = null;
		var rows = [];

		function showDetails(row, col, data) {
			var mine = ++detailSeq;
			selected = { curie: row.curie, key: col.key };
			renderGrid(body, rows, ribbon, showDetails, selected);
			loadCellDetails(base, details, row, col, data, function () { return !stale() && mine === detailSeq; });
		}

		function drawRibbon() {
			var mine = ++seq;
			detailSeq++;
			selected = null;
			clear(details);
			var asked = [focus].concat(compare.checked && orthologs ? orthologs.picked : []);
			ribbonNote.textContent = '';
			message(body, 'Loading...');
			fetchRibbon(base, asked.map(function (r) { return r.curie; }))
				.then(function (r) {
					if (stale() || mine !== seq) return;
					var json = r.json;
					rows = asked.filter(function (a) { return r.skipped.indexOf(a.curie) < 0; });
					if (r.skipped.length && rows.length) {
						ribbonNote.textContent = 'No GO data in the Alliance API for: ' + symbolList(r.skipped, asked);
					}
					if (!json || !json.categories || !(json.subjects || []).length) {
						message(body, 'No GO annotations for this gene');
						return;
					}
					ribbon = json;
					renderGrid(body, rows, ribbon, showDetails, null);
				})
				.catch(function (err) {
					if (stale() || mine !== seq) return;
					console.error('go-ribbon: ribbon failed', err);
					message(body, 'Could not load the GO ribbon from the API');
				});
		}

		var compare = node('input');
		compare.type = 'checkbox';
		compare.checked = false;
		compare.disabled = true;
		var compareLabel = node('label');
		compareLabel.appendChild(compare);
		compareLabel.appendChild(document.createTextNode(' Compare with orthologs'));
		controls.appendChild(compareLabel);
		var orthoNote = node('span', null, 'agr-note alliance-go-ribbon-note');
		controls.appendChild(orthoNote);

		compare.addEventListener('change', function () {
			if (!compare.checked || orthologs) {
				drawRibbon();
				return;
			}
			var mine = ++seq;
			message(body, 'Loading orthologs...');
			fetchMineRows(sr, buildQuery(ORTHOLOG_VIEW, internalId, 'Gene.homologues.homologue.organism.taxonId'))
				.then(function (res) {
					if (stale() || mine !== seq) return;
					orthologs = pickOrthologs(res, focus.curie, MAX_ORTHOLOGS);
					orthoNote.textContent = !orthologs.total
						? 'No orthologs for this gene'
						: orthologs.total > orthologs.picked.length
							? 'Showing ' + orthologs.picked.length + ' of ' + orthologs.total + ' orthologs'
							: '';
					drawRibbon();
				})
				.catch(function (err) {
					if (stale() || mine !== seq) return;
					console.error('go-ribbon: orthologs failed', err);
					compare.checked = false;
					orthoNote.textContent = 'Could not load orthologs from the mine';
					drawRibbon();
				});
		});

		fetchMineRows(sr, buildQuery(GENE_VIEW, internalId))
			.then(function (res) {
				if (stale()) return;
				var s = res.length ? toSubject(res[0]) : null;
				if (!s) {
					message(body, res.length ? 'No Alliance identifier for this gene' : 'No GO annotations for this gene');
					return;
				}
				focus = s;
				compare.disabled = false;
				source.appendChild(document.createTextNode('Data from the Alliance of Genome Resources API (GO annotations, api.geneontology.org). '));
				source.appendChild(link('View ' + s.symbol + ' on the Alliance', ALLIANCE_GENE_URL + encodeURIComponent(s.curie)));
				drawRibbon();
			})
			.catch(function (err) {
				if (stale()) return;
				console.error('go-ribbon: gene lookup failed', err);
				message(body, 'Could not load the gene from the mine');
			});
	}

	var api = {
		main: main,
		serviceRoot: serviceRoot,
		toAllianceCurie: toAllianceCurie,
		buildQuery: buildQuery,
		buildColumns: buildColumns,
		countOf: countOf,
		level: level,
		slimsFor: slimsFor,
		toDetails: toDetails,
		pickOrthologs: pickOrthologs,
		ribbonUrl: ribbonUrl,
		slimmerUrl: slimmerUrl,
		chunk: chunk,
		apiBase: apiBase,
		buildSetQuery: buildSetQuery,
		toSetGenes: toSetGenes,
		summarize: summarize,
		toCsv: toCsv,
		summaryCsv: summaryCsv,
		geneMatrixCsv: geneMatrixCsv,
		settings: settings,
		termCsv: termCsv
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceGoRibbon = api;
})(typeof window !== 'undefined' ? window : globalThis);
