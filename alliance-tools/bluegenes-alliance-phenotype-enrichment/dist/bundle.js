/*
 * Phenotype enrichment, a BlueGenes tool (tool API version 2).
 * Plain JavaScript without dependencies, so this file is both the source and
 * the bundle. BlueGenes loads it as a script and calls
 * bluegenesAlliancePhenotypeEnrichment.main(el, service, entity, state, config, navigate).
 *
 * For each phenotype ontology term (MP, WBPhenotype, FBcv, ZP, HP...) annotated to genes of the list:
 *   k = list genes annotated to the term, n = list genes,
 *   K = mine genes of the same organism(s) annotated to the term, N = mine genes of those organism(s).
 * p is the hypergeometric upper tail P(X >= k), corrected with Benjamini-Hochberg over all tested terms.
 * Annotations are direct: terms are not propagated to their ancestors.
 * Annotations without an ontology term cannot be tested and are counted as skipped.
 * Optionally the phenotype annotations of a gene's alleles count as annotations of the gene.
 */
(function (root) {
	'use strict';

	// BlueGenes passes the mine root (for example https://host/mine); the web
	// services live under /service. Accept either form.
	function serviceRoot(root) {
		var r = String(root || '').replace(/\/+$/, '');
		return /\/service$/.test(r) ? r : r + '/service';
	}

	var MAX_ROWS = 200000;
	var DEFAULT_MAX_FDR = 0.05;

	// ---- statistics (log space, no dependencies) ----

	var LANCZOS = [
		0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
		-176.61502916214059, 12.507343278686905, -0.13857109526572012,
		9.9843695780195716e-6, 1.5056327351493116e-7
	];

	function lgamma(x) {
		if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
		x -= 1;
		var a = LANCZOS[0];
		var t = x + 7.5;
		for (var i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
		return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
	}

	function logChoose(n, r) {
		if (r < 0 || r > n) return -Infinity;
		if (r === 0 || r === n) return 0;
		return lgamma(n + 1) - lgamma(r + 1) - lgamma(n - r + 1);
	}

	// log P(X = x) for X ~ Hypergeometric(population N, K successes, n draws).
	function logPmf(x, N, K, n) {
		return logChoose(K, x) + logChoose(N - K, n - x) - logChoose(N, n);
	}

	// Upper tail P(X >= k), summed in log space from the largest term.
	function hypergeomUpperTail(k, n, K, N) {
		var support = Math.max(0, n - (N - K));
		var hi = Math.min(n, K);
		if (k <= support) return 1;
		if (k > hi) return 0;
		var logs = [];
		var max = -Infinity;
		for (var x = k; x <= hi; x++) {
			var l = logPmf(x, N, K, n);
			logs.push(l);
			if (l > max) max = l;
		}
		var sum = 0;
		for (var i = 0; i < logs.length; i++) sum += Math.exp(logs[i] - max);
		return Math.min(1, Math.exp(max + Math.log(sum)));
	}

	// Benjamini-Hochberg adjusted p-values, returned in the input order.
	function benjaminiHochberg(ps) {
		var m = ps.length;
		var order = ps
			.map(function (p, i) { return i; })
			.sort(function (a, b) { return ps[a] - ps[b]; });
		var out = new Array(m);
		var running = 1;
		for (var r = m - 1; r >= 0; r--) {
			running = Math.min(running, (ps[order[r]] * m) / (r + 1));
			out[order[r]] = running;
		}
		return out;
	}

	// ---- queries ----

	function escapeXml(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function oneOf(path, values) {
		return (
			'<constraint path="' + path + '" op="ONE OF">' +
			values.map(function (v) { return '<value>' + escapeXml(v) + '</value>'; }).join('') +
			'</constraint>'
		);
	}

	function outerJoin(path) {
		return '<join path="' + path + '" style="OUTER"/>';
	}

	function query(view, constraints, joins) {
		return (
			'<query model="genomic" view="' + view.join(' ') + '">' +
			(joins || []).map(outerJoin).join('') +
			constraints.join('') +
			'</query>'
		);
	}

	var ORG = 'Gene.organism.shortName';
	var GENE_ANN = 'Gene.phenotypeAnnotations';
	var ALLELE_ANN = 'Gene.alleles.phenotypeAnnotations';

	// Genes of the list with their organism.
	function listGenesQuery(ids) {
		return query(['Gene.id', ORG], [oneOf('Gene.id', ids)]);
	}

	// Annotation rows of the list genes. Outer joins keep annotations without a term (null term columns) and genes without annotations.
	function listAnnotationsQuery(ids, annPath) {
		var term = annPath + '.ontologyTerm';
		return query(
			['Gene.id', annPath + '.id', term + '.id', term + '.identifier', term + '.name'],
			[oneOf('Gene.id', ids)],
			(annPath === ALLELE_ANN ? ['Gene.alleles'] : []).concat([annPath, term])
		);
	}

	// Annotation rows of every mine gene in the organisms, for the given terms only.
	function backgroundQuery(organisms, termIdentifiers, annPath) {
		var term = annPath + '.ontologyTerm.identifier';
		return query(['Gene.id', term], [oneOf(ORG, organisms), oneOf(term, termIdentifiers)]);
	}

	// Gene count per organism: the column summary of Gene.organism.shortName.
	function organismCountQuery(organisms) {
		return query(['Gene.id', ORG], [oneOf(ORG, organisms)]);
	}

	// The id and term lists go in a POST body: a GET query string fails above about 250 ids.
	function post(sr, params) {
		var body = Object.keys(params)
			.map(function (k) { return k + '=' + encodeURIComponent(params[k]); })
			.join('&');
		return fetch(sr.replace(/\/+$/, '') + '/query/results', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: body
		}).then(function (res) {
			if (!res.ok) throw new Error('HTTP ' + res.status);
			return res.json();
		});
	}

	function rows(sr, q) {
		return post(sr, { format: 'json', size: MAX_ROWS, query: q }).then(function (j) {
			return (j && j.results) || [];
		});
	}

	function organismCounts(sr, organisms) {
		return post(sr, {
			format: 'json',
			summaryPath: ORG,
			size: organisms.length + 1,
			query: organismCountQuery(organisms)
		}).then(function (j) {
			var total = 0;
			((j && j.results) || []).forEach(function (r) { total += Number(r[1]) || 0; });
			return total;
		});
	}

	// ---- computation ----

	// 'MP:0002169' gives 'MP'; an identifier without a colon gives 'other'.
	function prefixOf(identifier) {
		var s = String(identifier);
		var i = s.indexOf(':');
		return i > 0 ? s.slice(0, i) : 'other';
	}

	// Distinct genes per term identifier.
	function genesByTerm(annotationRows, identIndex) {
		var by = {};
		annotationRows.forEach(function (r) {
			if (r[identIndex] == null || r[0] == null) return;
			var s = (by[r[identIndex]] = by[r[identIndex]] || {});
			s[r[0]] = true;
		});
		return by;
	}

	// Distinct annotations (by annotation id) that have no ontology term.
	function skippedCount(annotationRows) {
		var seen = {};
		var n = 0;
		annotationRows.forEach(function (r) {
			if (r[3] != null || r[1] == null || seen[r[1]]) return;
			seen[r[1]] = true;
			n++;
		});
		return n;
	}

	/*
	 * data: { n, N, listAnnotations, background }
	 *   listAnnotations rows: [geneId, annotationId, termId, identifier, name]
	 *   background rows: [geneId, identifier]
	 * Returns all tested terms sorted by p, each with fdr and prefix; callers filter.
	 */
	function compute(data) {
		var list = genesByTerm(data.listAnnotations, 3);
		var back = genesByTerm(data.background, 1);
		var info = {};
		data.listAnnotations.forEach(function (r) {
			if (r[3] != null && !info[r[3]]) info[r[3]] = { id: r[2], name: r[4] };
		});
		var out = Object.keys(list).map(function (ident) {
			var k = Object.keys(list[ident]).length;
			var K = Math.max(back[ident] ? Object.keys(back[ident]).length : 0, k);
			return {
				identifier: ident,
				prefix: prefixOf(ident),
				id: info[ident].id,
				name: info[ident].name,
				k: k,
				n: data.n,
				K: K,
				N: data.N,
				fold: data.n > 0 && K > 0 && data.N > 0 ? (k / data.n) / (K / data.N) : null,
				p: hypergeomUpperTail(k, data.n, K, data.N)
			};
		});
		var fdr = benjaminiHochberg(out.map(function (t) { return t.p; }));
		out.forEach(function (t, i) { t.fdr = fdr[i]; });
		out.sort(function (a, b) {
			var an = a.name || a.identifier;
			var bn = b.name || b.identifier;
			return a.p - b.p || (an < bn ? -1 : an > bn ? 1 : 0);
		});
		return out;
	}

	// ---- loading ----

	function load(sr, ids, includeAlleles) {
		var paths = includeAlleles ? [GENE_ANN, ALLELE_ANN] : [GENE_ANN];
		var annotationRequests = paths.map(function (p) { return rows(sr, listAnnotationsQuery(ids, p)); });
		return Promise.all([rows(sr, listGenesQuery(ids))].concat(annotationRequests)).then(function (res) {
			var genes = res[0].filter(function (g) { return g[1]; });
			var annotations = [];
			res.slice(1).forEach(function (a) { annotations = annotations.concat(a); });
			var orgSet = {};
			genes.forEach(function (g) { orgSet[g[1]] = true; });
			var organisms = Object.keys(orgSet).sort();
			var terms = {};
			annotations.forEach(function (r) { if (r[3] != null) terms[r[3]] = true; });
			var termList = Object.keys(terms).sort();
			var base = {
				n: genes.length,
				N: 0,
				organisms: organisms,
				listAnnotations: annotations,
				background: [],
				skipped: skippedCount(annotations),
				capped: annotations.length >= MAX_ROWS
			};
			if (!organisms.length) return base;
			var backgroundRequests = termList.length === 0 ? [] : paths.map(function (p) { return rows(sr, backgroundQuery(organisms, termList, p)); });
			return Promise.all([organismCounts(sr, organisms)].concat(backgroundRequests)).then(function (bg) {
				base.N = bg[0];
				bg.slice(1).forEach(function (b) {
					base.background = base.background.concat(b);
					if (b.length >= MAX_ROWS) base.capped = true;
				});
				return base;
			});
		});
	}

	// ---- rendering ----

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
		var wrap = node('div', null, 'alliance-phenotype-enrichment');
		wrap.appendChild(node('span', text));
		el.appendChild(wrap);
	}

	function formatP(p) {
		if (p === 0) return '0';
		return p < 0.001 ? p.toExponential(2) : p.toFixed(4);
	}

	/*
	 * opts: { maxFdr, includeAlleles, hiddenPrefixes: { PREFIX: true } }
	 * ctx.setAlleles(bool, opts) reloads the data when the allele option changes.
	 */
	function render(el, data, navigate, opts, ctx) {
		clear(el);
		var wrap = node('div', null, 'alliance-phenotype-enrichment');
		opts.hiddenPrefixes = opts.hiddenPrefixes || {};

		var controls = node('div', null, 'alliance-phenotype-enrichment-options');
		var fdrLabel = node('label', 'Max FDR ');
		var fdrInput = node('input');
		fdrInput.type = 'number';
		fdrInput.min = '0';
		fdrInput.max = '1';
		fdrInput.step = '0.01';
		fdrInput.value = String(opts.maxFdr);
		fdrLabel.appendChild(fdrInput);
		controls.appendChild(fdrLabel);
		var alleleLabel = node('label', ' ');
		var alleleInput = node('input');
		alleleInput.type = 'checkbox';
		alleleInput.checked = !!opts.includeAlleles;
		alleleLabel.appendChild(alleleInput);
		alleleLabel.appendChild(document.createTextNode(' Include allele phenotype annotations'));
		controls.appendChild(alleleLabel);
		wrap.appendChild(controls);

		function update() {
			var v = parseFloat(fdrInput.value);
			opts.maxFdr = isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_MAX_FDR;
			render(el, data, navigate, opts, ctx);
		}
		fdrInput.addEventListener('change', update);
		alleleInput.addEventListener('change', function () {
			opts.includeAlleles = !!alleleInput.checked;
			if (ctx && ctx.setAlleles) ctx.setAlleles(opts.includeAlleles, opts);
		});

		var results = compute(data);
		var prefixes = [];
		results.forEach(function (t) { if (prefixes.indexOf(t.prefix) < 0) prefixes.push(t.prefix); });
		prefixes.sort();
		if (prefixes.length) {
			var pre = node('div', null, 'alliance-phenotype-enrichment-prefixes');
			pre.appendChild(node('span', 'Ontology: '));
			prefixes.forEach(function (pfx) {
				var l = node('label', ' ');
				var cb = node('input');
				cb.type = 'checkbox';
				cb.checked = !opts.hiddenPrefixes[pfx];
				cb.addEventListener('change', function () {
					if (cb.checked) delete opts.hiddenPrefixes[pfx];
					else opts.hiddenPrefixes[pfx] = true;
					render(el, data, navigate, opts, ctx);
				});
				l.appendChild(cb);
				l.appendChild(document.createTextNode(' ' + pfx + ' '));
				pre.appendChild(l);
			});
			wrap.appendChild(pre);
		}

		var shown = results.filter(function (t) { return t.fdr <= opts.maxFdr && !opts.hiddenPrefixes[t.prefix]; });

		wrap.appendChild(
			node(
				'p',
				'Background: all ' + data.N + ' genes of ' + data.organisms.join(', ') +
					' in this mine. List: ' + data.n + ' genes. ' +
					results.length + ' terms tested, ' + shown.length + ' shown with FDR <= ' + opts.maxFdr + '.',
				'alliance-phenotype-enrichment-background'
			)
		);
		if (data.skipped > 0) {
			wrap.appendChild(
				node('p', data.skipped + ' annotations without a term were skipped', 'alliance-phenotype-enrichment-skipped')
			);
		}
		if (data.capped) {
			wrap.appendChild(node('p', 'Result limit reached, counts may be incomplete.'));
		}

		if (!shown.length) {
			wrap.appendChild(node('p', 'No enriched phenotype terms at this FDR'));
			el.appendChild(wrap);
			return;
		}

		var table = node('table', null, 'table table-striped');
		var thead = node('thead');
		var hr = node('tr');
		['Phenotype term', 'Ontology', 'k/n', 'K/N', 'Fold', 'p', 'FDR'].forEach(function (h) { hr.appendChild(node('th', h)); });
		thead.appendChild(hr);
		table.appendChild(thead);
		var tbody = node('tbody');
		shown.forEach(function (t) {
			var tr = node('tr');
			var cell = node('td');
			var a = node('a', t.name || t.identifier);
			a.href = '#';
			a.title = t.identifier;
			a.addEventListener('click', function (ev) {
				if (ev && ev.preventDefault) ev.preventDefault();
				if (typeof navigate === 'function') navigate('report', { type: 'OntologyTerm', id: t.id });
			});
			cell.appendChild(a);
			tr.appendChild(cell);
			tr.appendChild(node('td', t.prefix));
			tr.appendChild(node('td', t.k + '/' + t.n));
			tr.appendChild(node('td', t.K + '/' + t.N));
			tr.appendChild(node('td', t.fold == null ? '' : t.fold.toFixed(2)));
			tr.appendChild(node('td', formatP(t.p)));
			tr.appendChild(node('td', formatP(t.fdr)));
			tbody.appendChild(tr);
		});
		table.appendChild(tbody);
		wrap.appendChild(table);
		el.appendChild(wrap);
	}

	function main(el, service, imEntity, state, config, navigate) {
		if (!el || !service || !imEntity) {
			throw new Error('Call main with correct signature');
		}
		// main runs again on every entity change; a response for an older entity must not overwrite the newer one.
		var token = (el.__agrPhenEnrichReq = (el.__agrPhenEnrichReq || 0) + 1);
		var gene = imEntity.Gene;
		var ids = gene && gene.value;
		var list = (Array.isArray(ids) ? ids : [ids]).filter(function (v) {
			return v !== undefined && v !== null && v !== '';
		});
		if (!list.length) {
			message(el, 'No genes to analyse');
			return;
		}
		var sr = serviceRoot(service.root);

		function run(opts) {
			message(el, 'Loading...');
			load(sr, list, !!opts.includeAlleles)
				.then(function (data) {
					if (el.__agrPhenEnrichReq !== token) return;
					if (!data.n) {
						message(el, 'No genes with an organism in this list');
						return;
					}
					render(el, data, navigate, opts, {
						setAlleles: function (flag, o) {
							o.includeAlleles = flag;
							run(o);
						}
					});
				})
				.catch(function (err) {
					console.error('Phenotype enrichment failed', err);
					if (el.__agrPhenEnrichReq !== token) return;
					message(el, 'Could not compute phenotype enrichment from the mine');
				});
		}
		run({ maxFdr: DEFAULT_MAX_FDR, includeAlleles: false, hiddenPrefixes: {} });
	}

	var api = {
		main: main,
		serviceRoot: serviceRoot,
		hypergeomUpperTail: hypergeomUpperTail,
		benjaminiHochberg: benjaminiHochberg,
		prefixOf: prefixOf,
		skippedCount: skippedCount,
		compute: compute,
		escapeXml: escapeXml,
		listGenesQuery: listGenesQuery,
		listAnnotationsQuery: listAnnotationsQuery,
		backgroundQuery: backgroundQuery,
		organismCountQuery: organismCountQuery,
		render: render
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAlliancePhenotypeEnrichment = api;
})(typeof window !== 'undefined' ? window : globalThis);
