/*
 * Variants (Alliance), a BlueGenes tool (tool API version 2).
 * Plain JavaScript without dependencies, so this file is both the source and
 * the bundle. BlueGenes loads it as a script and calls
 * bluegenesAllianceVariants.main(el, service, entity, state, config, navigate).
 * It reads the gene from the mine, then lists its variants from the Alliance API
 * (GET <apiBase>/gene/<curie>/alleles; each result row is an allele or a variant
 * and carries a variantList).
 */
(function (root) {
	'use strict';

	var DEFAULT_API_BASE = 'https://www.alliancegenome.org/api';
	var PAGE_SIZE = 50;
	var TIMEOUT_MS = 20000;
	var GENE_PAGE = 'https://www.alliancegenome.org/gene/';
	var EMPTY_TEXT = 'No variants in the Alliance for this gene';

	// BlueGenes passes the mine root (for example https://host/mine); the web
	// services live under /service. Accept either form.
	function serviceRoot(root) {
		var r = String(root || '').replace(/\/+$/, '');
		return /\/service$/.test(r) ? r : r + '/service';
	}

	function apiBase(config) {
		var b = config && typeof config.apiBase === 'string' && config.apiBase ? config.apiBase : DEFAULT_API_BASE;
		return b.replace(/\/+$/, '');
	}

	// Identifier prefix and bare-id shape per species, keyed by NCBI taxon id.
	var SPECIES = {
		'9606': { prefix: 'HGNC', test: /^\d+$/ },
		'10090': { prefix: 'MGI', test: /^\d+$/ },
		'10116': { prefix: 'RGD', test: /^\d+$/ },
		'7955': { prefix: 'ZFIN', test: /^ZDB-GENE-/ },
		'7227': { prefix: 'FB', test: /^FBgn\d+$/ },
		'6239': { prefix: 'WB', test: /^WBGene\d+$/ },
		'559292': { prefix: 'SGD', test: /^S\d{9}$/ }
	};
	var NAME_TO_TAXON = {
		'h. sapiens': '9606', 'homo sapiens': '9606',
		'm. musculus': '10090', 'mus musculus': '10090',
		'r. norvegicus': '10116', 'rattus norvegicus': '10116',
		'd. rerio': '7955', 'danio rerio': '7955',
		'd. melanogaster': '7227', 'drosophila melanogaster': '7227',
		'c. elegans': '6239', 'caenorhabditis elegans': '6239',
		's. cerevisiae': '559292', 'saccharomyces cerevisiae': '559292'
	};
	var KNOWN_PREFIX = /^(HGNC|MGI|RGD|ZFIN|FB|WB|SGD):/;

	// Mines store some ids as Alliance curies and some bare. Returns null when the
	// species or id shape is not one the Alliance API takes.
	function toAllianceCurie(primaryIdentifier, organism) {
		var id = primaryIdentifier == null ? '' : String(primaryIdentifier).trim();
		if (!id) return null;
		if (KNOWN_PREFIX.test(id)) return id;
		var key = organism == null ? '' : String(organism).trim().toLowerCase();
		var taxon = SPECIES[key] ? key : NAME_TO_TAXON[key];
		var sp = taxon && SPECIES[taxon];
		if (!sp || !sp.test.test(id)) return null;
		return sp.prefix + ':' + id;
	}

	function escapeXml(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	var GENE_VIEW = ['Gene.id', 'Gene.primaryIdentifier', 'Gene.symbol', 'Gene.organism.shortName', 'Gene.organism.taxonId'];

	// ids is one internal Gene.id or an array of them.
	function buildQuery(ids) {
		var list = (Array.isArray(ids) ? ids : [ids]).map(String);
		var constraint =
			list.length === 1
				? '<constraint path="Gene.id" op="=" value="' + escapeXml(list[0]) + '"/>'
				: '<constraint path="Gene.id" op="ONE OF">' +
					list.map(function (v) { return '<value>' + escapeXml(v) + '</value>'; }).join('') +
					'</constraint>';
		return '<query model="genomic" view="' + GENE_VIEW.join(' ') + '">' + constraint + '</query>';
	}

	function resultsUrl(root) {
		return root.replace(/\/+$/, '') + '/query/results';
	}

	// The id list goes in a POST body: a GET query string fails above about 250 ids.
	function requestBody(query) {
		return 'format=json&query=' + encodeURIComponent(query);
	}

	// fetch with a 20 s timeout.
	function timedFetch(url, init) {
		var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
		var timer = null;
		var opts = init || {};
		if (ctl) {
			opts.signal = ctl.signal;
			timer = setTimeout(function () { ctl.abort(); }, TIMEOUT_MS);
		}
		var done = function () { if (timer) clearTimeout(timer); };
		return fetch(url, opts).then(
			function (res) { done(); return res; },
			function (err) { done(); throw err; }
		);
	}

	function fetchGenes(root, ids) {
		return timedFetch(resultsUrl(root), {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: requestBody(buildQuery(ids))
		})
			.then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status);
				return res.json();
			})
			.then(function (json) {
				return ((json && json.results) || []).map(function (r) {
					return { id: r[0], identifier: r[1], symbol: r[2] || '', organism: r[3] || '', taxonId: r[4] };
				});
			});
	}

	function variantsUrl(base, curie, page, filters) {
		var q = ['limit=' + PAGE_SIZE, 'page=' + page];
		if (filters && filters.type) q.push('filter.variantType=' + encodeURIComponent(filters.type));
		if (filters && filters.consequence) q.push('filter.molecularConsequence=' + encodeURIComponent(filters.consequence));
		return base + '/gene/' + encodeURIComponent(curie) + '/alleles?' + q.join('&');
	}

	// Resolves to the parsed body, or null for 404 (no data).
	function fetchVariants(base, curie, page, filters) {
		return timedFetch(variantsUrl(base, curie, page, filters), { headers: { Accept: 'application/json' } }).then(function (res) {
			if (res.status === 404) return null;
			if (!res.ok) throw new Error('HTTP ' + res.status);
			return res.json();
		});
	}

	// Alliance symbols carry HTML, for example Brca1<sup>tm5.1Cxd</sup>.
	function plain(s) {
		return s == null ? '' : String(s).replace(/<\/?[a-zA-Z][^>]*>/g, '');
	}

	function consequenceNames(c) {
		return ((c && c.vepConsequences) || []).map(function (v) { return v && v.name; }).filter(Boolean);
	}

	// One table row per variant in a result row.
	function toVariantRows(result) {
		var allele = (result && result.allele) || {};
		var symbol = plain(allele.alleleSymbol && allele.alleleSymbol.displayText);
		var out = [];
		((result && result.variantList) || []).forEach(function (v) {
			var loc = ((v && v.curatedVariantGenomicLocations) || [])[0] || {};
			var predicted = loc.predictedVariantConsequences || [];
			var names = consequenceNames(loc.mostSevereConsequence);
			if (!names.length) {
				predicted.forEach(function (p) {
					consequenceNames(p).forEach(function (n) { if (names.indexOf(n) < 0) names.push(n); });
				});
			}
			var protein = '';
			for (var i = 0; i < predicted.length && !protein; i++) {
				protein = predicted[i].hgvsProteinNomenclature || predicted[i].hgvsProtein || '';
			}
			var chr = loc.variantGenomicLocationAssociationObject && loc.variantGenomicLocationAssociationObject.name;
			var position = '';
			if (loc.start != null) {
				position = (chr ? chr + ':' : '') + loc.start + (loc.end != null && loc.end !== loc.start ? '-' + loc.end : '');
			}
			out.push({
				id: loc.hgvs || allele.primaryExternalId || allele.curie || '',
				type: (v.variantType && v.variantType.name) || '',
				consequence: names.join(', '),
				protein: protein,
				position: position,
				allele: symbol || allele.primaryExternalId || allele.curie || ''
			});
		});
		return out;
	}

	function distinct(body, key) {
		var d = body && body.supplementalData && body.supplementalData.distinctFieldValues;
		return (d && d[key]) || [];
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

	function attribution(curie) {
		var p = node('p', null, 'alliance-variants-source');
		p.appendChild(node('span', 'Data from the Alliance of Genome Resources API'));
		if (curie) {
			p.appendChild(node('span', ' ('));
			var a = node('a', 'gene page');
			a.setAttribute('href', GENE_PAGE + curie);
			a.setAttribute('target', '_blank');
			a.setAttribute('rel', 'noopener noreferrer');
			p.appendChild(a);
			p.appendChild(node('span', ')'));
		}
		return p;
	}

	function table(rows) {
		var t = node('table', null, 'table table-striped table-condensed');
		var head = node('tr');
		['Variant', 'Type', 'Molecular consequence', 'Amino acid change', 'Position', 'Allele'].forEach(function (h) {
			head.appendChild(node('th', h));
		});
		var thead = node('thead');
		thead.appendChild(head);
		t.appendChild(thead);
		var tbody = node('tbody');
		rows.forEach(function (r) {
			var tr = node('tr');
			[r.id, r.type, r.consequence, r.protein || '-', r.position, r.allele].forEach(function (v) {
				tr.appendChild(node('td', v));
			});
			tbody.appendChild(tr);
		});
		t.appendChild(tbody);
		return t;
	}

	function select(label, values, current, onChange) {
		var wrap = node('label', label + ' ', 'alliance-variants-filter');
		var s = node('select');
		var all = node('option', 'All');
		all.setAttribute('value', '');
		s.appendChild(all);
		values.forEach(function (v) {
			var o = node('option', v);
			o.setAttribute('value', v);
			s.appendChild(o);
		});
		s.value = current || '';
		s.addEventListener('change', function () { onChange(s.value); });
		wrap.appendChild(s);
		return wrap;
	}

	function button(label, disabled, onClick) {
		var b = node('button', label, 'btn btn-default');
		b.setAttribute('type', 'button');
		if (disabled) b.setAttribute('disabled', 'disabled');
		b.addEventListener('click', onClick);
		return b;
	}

	function main(el, service, imEntity, state, config, navigate) {
		if (!el || !service || !imEntity) {
			throw new Error('Call main with correct signature');
		}
		// main runs again on every entity change; a response for an older entity must not overwrite the newer one.
		var token = (el.__agrVariantsReq = (el.__agrVariantsReq || 0) + 1);
		var stale = function () { return el.__agrVariantsReq !== token; };
		var gene = imEntity.Gene;
		var ids = gene && gene.value;
		var list = (Array.isArray(ids) ? ids : [ids]).filter(function (v) {
			return v !== undefined && v !== null && v !== '';
		});
		clear(el);
		var wrap = node('div', null, 'alliance-variants');
		el.appendChild(wrap);
		if (!list.length) {
			wrap.appendChild(node('span', EMPTY_TEXT));
			return;
		}
		var base = apiBase(config);
		var body = node('div', null, 'alliance-variants-body');
		wrap.appendChild(body);
		body.appendChild(node('span', 'Loading...'));

		fetchGenes(serviceRoot(service.root), list)
			.then(function (genes) {
				if (stale()) return;
				clear(body);
				if (!genes.length) {
					body.appendChild(node('span', EMPTY_TEXT));
					return;
				}
				showGenes(genes);
			})
			.catch(function (err) {
				if (stale()) return;
				console.error('variants: gene lookup in the mine failed', err);
				clear(body);
				body.appendChild(node('span', 'Could not load the gene from the mine'));
			});

		function showGenes(genes) {
			var cur = genes[0];
			var view = null;
			var geneBar = node('div', null, 'alliance-variants-genes');
			var panel = node('div', null, 'alliance-variants-panel');
			if (genes.length > 1) {
				var sel = node('select');
				genes.forEach(function (g, i) {
					var o = node('option', (g.symbol || g.identifier) + (g.organism ? ' (' + g.organism + ')' : ''));
					o.setAttribute('value', String(i));
					sel.appendChild(o);
				});
				sel.addEventListener('change', function () {
					cur = genes[Number(sel.value)];
					start();
				});
				geneBar.appendChild(sel);
			}
			body.appendChild(geneBar);
			body.appendChild(panel);
			start();

			// A new gene resets page and filters. view.req guards each request against a newer one.
			function start() {
				view = { page: 1, type: '', consequence: '', types: [], consequences: [], req: 0, last: null };
				load();
			}

			function load(prev) {
				var v = view;
				var myReq = ++v.req;
				var curie = toAllianceCurie(cur.identifier, cur.taxonId || cur.organism);
				if (!curie) {
					clear(panel);
					panel.appendChild(node('span', 'No Alliance identifier for ' + cur.identifier));
					return;
				}
				if (!v.types.length) {
					clear(panel);
					panel.appendChild(node('span', 'Loading...'));
				}
				var current = function () { return !stale() && view === v && v.req === myReq; };
				fetchVariants(base, curie, v.page, { type: v.type, consequence: v.consequence })
					.then(function (res) {
						if (!current()) return;
						v.last = res;
						render(curie, res);
					})
					.catch(function (err) {
						if (!current()) return;
						console.error('variants: Alliance request failed', err);
						var msg = 'Could not load variants from the Alliance API';
						if (prev && v.last) {
							v.page = prev.page;
							v.type = prev.type;
							v.consequence = prev.consequence;
							render(curie, v.last, msg);
							return;
						}
						clear(panel);
						panel.appendChild(node('span', msg));
						panel.appendChild(attribution(curie));
					});
			}

			function render(curie, res, errMsg) {
				var v = view;
				var total = res && typeof res.total === 'number' ? res.total : 0;
				var results = (res && res.results) || [];
				if (!v.types.length) v.types = distinct(res, 'variantType');
				if (!v.consequences.length) v.consequences = distinct(res, 'molecularConsequence');
				clear(panel);
				var filtered = !!(v.type || v.consequence);
				if (!total && !filtered) {
					panel.appendChild(node('span', EMPTY_TEXT));
					panel.appendChild(attribution(curie));
					return;
				}
				var prevOf = function () { return { page: v.page, type: v.type, consequence: v.consequence }; };
				var bar = node('div', null, 'alliance-variants-filters');
				bar.appendChild(select('Type', v.types, v.type, function (x) { var p = prevOf(); v.type = x; v.page = 1; load(p); }));
				bar.appendChild(select('Consequence', v.consequences, v.consequence, function (x) { var p = prevOf(); v.consequence = x; v.page = 1; load(p); }));
				panel.appendChild(bar);
				if (errMsg) panel.appendChild(node('p', errMsg, 'alliance-variants-error'));
				var rows = [];
				results.forEach(function (r) {
					toVariantRows(r).forEach(function (x) { rows.push(x); });
				});
				var first = (v.page - 1) * PAGE_SIZE + 1;
				var last = (v.page - 1) * PAGE_SIZE + results.length;
				var count = total ? first + '-' + last + ' of ' + total + ' records (alleles and variants), ' + rows.length + ' variant rows on this page' : 'No variants match the filters';
				panel.appendChild(node('p', count, 'alliance-variants-count'));
				if (rows.length) panel.appendChild(table(rows));
				else if (total) panel.appendChild(node('p', 'No variants on this page'));
				var pager = node('div', null, 'alliance-variants-pager');
				pager.appendChild(button('Previous', v.page <= 1, function () { if (v.page > 1) { var p = prevOf(); v.page -= 1; load(p); } }));
				pager.appendChild(button('Next', last >= total, function () { if (last < total) { var p = prevOf(); v.page += 1; load(p); } }));
				panel.appendChild(pager);
				panel.appendChild(attribution(curie));
			}
		}
	}

	var api = {
		main: main,
		serviceRoot: serviceRoot,
		apiBase: apiBase,
		toAllianceCurie: toAllianceCurie,
		buildQuery: buildQuery,
		resultsUrl: resultsUrl,
		requestBody: requestBody,
		variantsUrl: variantsUrl,
		escapeXml: escapeXml,
		plain: plain,
		toVariantRows: toVariantRows,
		PAGE_SIZE: PAGE_SIZE
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceVariants = api;
})(typeof window !== 'undefined' ? window : globalThis);
