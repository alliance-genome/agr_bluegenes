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
	var TIMEOUT_MS = 20000;
	var MAX_ORTHOLOGS = 8;
	var MAX_DETAIL_ROWS = 500;
	var PROTEIN_BINDING = 'GO:0005515';

	// BlueGenes passes the mine root (for example https://host/mine); the web
	// services live under /service. Accept either form.
	function serviceRoot(root) {
		var r = String(root || '').replace(/\/+$/, '');
		return /\/service$/.test(r) ? r : r + '/service';
	}

	// Alliance curie prefix, bare-id pattern, organism short names and taxon ids.
	var SPECIES = [
		{ prefix: 'HGNC', bare: null, names: ['h. sapiens', 'homo sapiens'], taxon: '9606' },
		{ prefix: 'MGI', bare: null, names: ['m. musculus', 'mus musculus'], taxon: '10090' },
		{ prefix: 'RGD', bare: null, names: ['r. norvegicus', 'rattus norvegicus'], taxon: '10116' },
		{ prefix: 'ZFIN', bare: /^ZDB-GENE-/, names: ['d. rerio', 'danio rerio'], taxon: '7955' },
		{ prefix: 'FB', bare: /^FBgn\d+$/, names: ['d. melanogaster', 'drosophila melanogaster'], taxon: '7227' },
		{ prefix: 'WB', bare: /^WBGene\d+$/, names: ['c. elegans', 'caenorhabditis elegans'], taxon: '6239' },
		{ prefix: 'SGD', bare: /^S\d{9}$/, names: ['s. cerevisiae', 'saccharomyces cerevisiae'], taxon: '559292' }
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
	// (WBGene..., FBgn..., S000...) and ZFIN genes (ZDB-GENE-...).
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
				if (SPECIES[i].prefix === head && id.length > colon + 1) return head + id.slice(colon);
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

	// Taxon ids of the 7 Alliance species, plus 4932 for YeastMine's S. cerevisiae.
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

	function fetchWithTimeout(url, init) {
		var ctl = typeof AbortController === 'function' ? new AbortController() : null;
		var opts = init || {};
		if (ctl) opts.signal = ctl.signal;
		var timer = setTimeout(function () {
			if (ctl) ctl.abort();
		}, TIMEOUT_MS);
		var done = function () { clearTimeout(timer); };
		return fetch(url, opts).then(
			function (res) { done(); return res; },
			function (err) { done(); throw err; }
		);
	}

	function fetchMineRows(sr, query) {
		return fetchWithTimeout(resultsUrl(sr), {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: requestBody(query)
		})
			.then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status);
				return res.json();
			})
			.then(function (json) { return (json && json.results) || []; });
	}

	// Resolves to the parsed JSON, or null on 404 (no data).
	function fetchApiJson(url) {
		return fetchWithTimeout(url, { headers: { Accept: 'application/json' } }).then(function (res) {
			if (res.status === 404) return null;
			if (!res.ok) throw new Error('HTTP ' + res.status);
			return res.json();
		});
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
		el.appendChild(node('p', text, cls));
	}

	function link(text, href) {
		var a = node('a', text);
		a.href = href;
		a.target = '_blank';
		a.rel = 'noopener noreferrer';
		a.className = 'agr-external';
		return a;
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
		tableWrap.appendChild(t);
		var hr = node('tr');
		['Term', 'Evidence code', 'Reference'].forEach(function (h) { hr.appendChild(node('th', h)); });
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

	// Rows are subjects ({curie, symbol, species}); ribbon is the API response.
	function renderGrid(box, rows, ribbon, onCell, selected) {
		clear(box);
		var cols = buildColumns(ribbon.categories);
		var bySubject = {};
		(ribbon.subjects || []).forEach(function (s) { bySubject[s.id] = s; });

		var gridWrap = node('div', null, 'agr-table-wrap');
		var table = node('table', null, 'alliance-go-ribbon-grid');
		gridWrap.appendChild(table);
		var thead = node('thead');
		var top = node('tr');
		var corner = node('th', 'Gene');
		corner.rowSpan = 2;
		top.appendChild(corner);
		var sub = node('tr');
		var lastAspect = null;
		var span = null;
		cols.forEach(function (c) {
			if (c.aspectId !== lastAspect) {
				span = node('th', c.aspect);
				span.colSpan = 0;
				top.appendChild(span);
				lastAspect = c.aspectId;
			}
			span.colSpan += 1;
			sub.appendChild(node('th', c.label, 'alliance-go-ribbon-group'));
		});
		thead.appendChild(top);
		thead.appendChild(sub);
		table.appendChild(thead);

		var tbody = node('tbody');
		rows.forEach(function (row) {
			var data = bySubject[row.curie];
			var tr = node('tr');
			var rowHead = node('th', row.symbol + (row.species ? ' (' : ''));
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
	var SET_CHUNK = 50;
	var MAX_SET_GENES = 300;
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

	// Requests the ribbon for each chunk of genes in turn and merges the subjects.
	function fetchRibbonSubjects(base, genes, onProgress) {
		var done = 0;
		return chunk(genes, SET_CHUNK).reduce(function (prev, part) {
			return prev.then(function (acc) {
				var curies = part.map(function (g) { return g.curie; });
				return fetchApiJson(ribbonUrl(base, curies)).then(function (json) {
					done += part.length;
					onProgress(done, genes.length);
					return {
						categories: acc.categories || (json && json.categories) || null,
						subjects: acc.subjects.concat((json && json.subjects) || [])
					};
				});
			});
		}, Promise.resolve({ categories: null, subjects: [] }));
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
		return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
	}

	function toCsv(rows) {
		return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
	}

	function summaryCsv(aspects) {
		var rows = [['Aspect', 'GO ID', 'Term', 'Genes', 'Gene symbols']];
		aspects.forEach(function (a) {
			a.terms.forEach(function (t) {
				rows.push([
					a.label, t.col.id, t.col.label, t.genes.length,
					t.genes.map(function (h) { return h.gene.symbol; }).join('; ')
				]);
			});
		});
		return toCsv(rows);
	}

	function termCsv(term) {
		var rows = [['Symbol', 'Alliance ID', 'Species', 'Annotations']];
		term.genes.forEach(function (h) { rows.push([h.gene.symbol, h.gene.curie, h.gene.species, h.n]); });
		return toCsv(rows);
	}

	function downloadCsv(filename, text) {
		var url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
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
			var hr = node('tr');
			['GO slim term', 'GO ID', 'Genes'].forEach(function (h) { hr.appendChild(node('th', h)); });
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
		box.appendChild(status);
		var wrap = node('div', null, 'agr-table-wrap');
		var table = node('table', null, 'agr-table agr-table-sm');
		var hr = node('tr');
		['Gene', 'Species', 'Annotations'].forEach(function (h) { hr.appendChild(node('th', h)); });
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

	function saveTerm(context, term, status) {
		status.textContent = 'Saving...';
		var ids = term.genes.map(function (h) { return h.gene.id; });
		context
			.saveList({ name: term.col.label + ' (GO slim genes)', class: 'Gene', ids: ids, tags: ['go-ribbon'] })
			.then(function (name) { status.textContent = 'Saved list ' + name + ' (' + ids.length + ' genes)'; })
			.catch(function (err) {
				var needsLogin = err && err.message === 'login required';
				if (!needsLogin) console.error('go-ribbon: save list failed', err);
				status.textContent = needsLogin ? 'Log in to save a list' : 'Could not save the list';
			});
	}

	function setNote(ids, genes, rows) {
		var parts = [];
		if (ids.length > MAX_SET_GENES) {
			parts.push('This list has ' + ids.length + ' genes. The ribbon covers the first ' + MAX_SET_GENES + '; use a smaller list to cover the rest.');
		}
		if (rows.length > genes.length) {
			parts.push(rows.length - genes.length + ' genes have no Alliance identifier and are left out.');
		}
		return parts.join(' ');
	}

	function mainSet(wrap, ids, service, config, context, stale) {
		var sr = serviceRoot(service.root);
		var base = apiBase(config);
		var capped = ids.slice(0, MAX_SET_GENES);
		var noteEl = node('p', null, 'agr-note alliance-go-ribbon-note');
		var actions = node('div', null, 'alliance-go-ribbon-actions');
		var body = node('div');
		var details = node('div', null, 'alliance-go-ribbon-details');
		var source = node('p', 'Data from the Alliance of Genome Resources API (GO annotations, api.geneontology.org).', 'agr-note alliance-go-ribbon-source');
		[noteEl, actions, body, details, source].forEach(function (n) { wrap.appendChild(n); });
		var canSave = !!context && typeof context.saveList === 'function';
		var aspects = [];

		function showTerm(a, t) {
			renderSummary(body, aspects, showTerm, termKey(a, t));
			var status = renderTermGenes(details, t, canSave ? function () { saveTerm(context, t, status); } : null);
		}

		function show(ribbon, genes) {
			aspects = summarize(ribbon, genes);
			if (!aspects.length) {
				message(body, 'No GO annotations for these genes');
				return;
			}
			actions.appendChild(button('Download summary as CSV', 'agr-btn agr-btn-sm', function () {
				downloadCsv('go-ribbon-summary.csv', summaryCsv(aspects));
			}));
			renderSummary(body, aspects, showTerm, null);
		}

		function fail(text, label) {
			return function (err) {
				if (stale()) return;
				console.error('go-ribbon: ' + label, err);
				message(body, text);
			};
		}

		message(body, 'Loading genes from the mine...');
		fetchMineRows(sr, buildSetQuery(capped))
			.then(function (rows) {
				if (stale()) return null;
				var genes = toSetGenes(rows);
				noteEl.textContent = setNote(ids, genes, rows);
				if (!genes.length) {
					message(body, 'No Alliance identifier for these genes');
					return null;
				}
				var progress = function (n, total) {
					if (!stale()) message(body, 'Loading GO annotations: ' + n + ' of ' + total + ' genes');
				};
				message(body, 'Loading GO annotations: 0 of ' + genes.length + ' genes');
				return fetchRibbonSubjects(base, genes, progress).then(function (ribbon) {
					if (!stale()) show(ribbon, genes);
				}, fail('Could not load the GO ribbon from the API', 'ribbon failed'));
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
		var body = node('div');
		var details = node('div', null, 'alliance-go-ribbon-details');
		var source = node('p', null, 'agr-note alliance-go-ribbon-source');
		wrap.appendChild(controls);
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
			var slims = slimsFor(data, col);
			selected = { curie: row.curie, key: col.key };
			renderGrid(body, rows, ribbon, showDetails, selected);
			clear(details);
			if (!slims.length) {
				renderDetails(details, row, col, []);
				return;
			}
			details.appendChild(node('p', 'Loading annotations...', 'agr-loading'));
			fetchSlimmer(base, row.curie, slims)
				.then(function (resp) {
					if (stale() || mine !== detailSeq) return;
					renderDetails(details, row, col, toDetails(resp, col.aspect));
				})
				.catch(function (err) {
					if (stale() || mine !== detailSeq) return;
					console.error('go-ribbon: annotation details failed', err);
					message(details, 'Could not load GO annotations from the API');
				});
		}

		function drawRibbon() {
			var mine = ++seq;
			detailSeq++;
			selected = null;
			clear(details);
			rows = [focus].concat(compare.checked && orthologs ? orthologs.picked : []);
			message(body, 'Loading...');
			fetchApiJson(ribbonUrl(base, rows.map(function (r) { return r.curie; })))
				.then(function (json) {
					if (stale() || mine !== seq) return;
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
		termCsv: termCsv
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceGoRibbon = api;
})(typeof window !== 'undefined' ? window : globalThis);
