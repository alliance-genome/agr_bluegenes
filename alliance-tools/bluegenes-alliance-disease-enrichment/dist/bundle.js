/*
 * Disease enrichment, a BlueGenes tool (tool API version 2).
 * Plain JavaScript without dependencies, so this file is both the source and
 * the bundle. BlueGenes loads it as a script and calls
 * bluegenesAllianceDiseaseEnrichment.main(el, service, entity, state, config, navigate).
 *
 * For each Disease Ontology term annotated to genes of the list:
 *   k = list genes annotated to the term, n = list genes,
 *   K = mine genes of the same organism(s) annotated to the term, N = mine genes of those organism(s).
 * p is the hypergeometric upper tail P(X >= k), corrected with Benjamini-Hochberg.
 * Annotations are direct: terms are not propagated to their ancestors.
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

	function query(view, constraints) {
		return '<query model="genomic" view="' + view.join(' ') + '">' + constraints.join('') + '</query>';
	}

	var ORG = 'Gene.organism.shortName';
	var TERM = 'Gene.diseaseAnnotation.ontologyTerm';
	var QUAL = 'Gene.diseaseAnnotation.qualifier';

	// Genes of the list with their organism.
	function listGenesQuery(ids) {
		return query(['Gene.id', ORG], [oneOf('Gene.id', ids)]);
	}

	// Annotation rows of the list genes.
	function listAnnotationsQuery(ids) {
		return query(['Gene.id', TERM + '.id', TERM + '.identifier', TERM + '.name', QUAL], [oneOf('Gene.id', ids)]);
	}

	// Annotation rows of every mine gene in the organisms, for the given terms only.
	function backgroundQuery(organisms, termIdentifiers) {
		return query(
			['Gene.id', TERM + '.identifier', QUAL],
			[oneOf(ORG, organisms), oneOf(TERM + '.identifier', termIdentifiers)]
		);
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

	// 'is_not_implicated_in', 'NOT' and similar. 'implicated_via_orthology' is not negated.
	function isNegated(qualifier) {
		return /(^|[^a-z])not([^a-z]|$)/i.test(String(qualifier || ''));
	}

	// Distinct genes per term identifier, optionally dropping negated qualifiers.
	function genesByTerm(annotationRows, identIndex, qualIndex, includeNegated) {
		var by = {};
		annotationRows.forEach(function (r) {
			if (r[identIndex] == null || r[0] == null) return;
			if (!includeNegated && isNegated(r[qualIndex])) return;
			var s = (by[r[identIndex]] = by[r[identIndex]] || {});
			s[r[0]] = true;
		});
		return by;
	}

	/*
	 * data: { n, N, listAnnotations, background }
	 *   listAnnotations rows: [geneId, termId, identifier, name, qualifier]
	 *   background rows: [geneId, identifier, qualifier]
	 * opts: { includeNegated }
	 * Returns all tested terms sorted by p, each with fdr; callers filter on fdr.
	 */
	function compute(data, opts) {
		var includeNegated = !!(opts && opts.includeNegated);
		var list = genesByTerm(data.listAnnotations, 2, 4, includeNegated);
		var back = genesByTerm(data.background, 1, 2, includeNegated);
		var info = {};
		data.listAnnotations.forEach(function (r) {
			if (r[2] != null && !info[r[2]]) info[r[2]] = { id: r[1], name: r[3] };
		});
		var out = Object.keys(list).map(function (ident) {
			var k = Object.keys(list[ident]).length;
			var K = Math.max(back[ident] ? Object.keys(back[ident]).length : 0, k);
			return {
				identifier: ident,
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
		out.sort(function (a, b) { return a.p - b.p || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
		return out;
	}

	// ---- loading ----

	function load(sr, ids) {
		return Promise.all([rows(sr, listGenesQuery(ids)), rows(sr, listAnnotationsQuery(ids))]).then(function (res) {
			var genes = res[0].filter(function (g) { return g[1]; });
			var annotations = res[1];
			var orgSet = {};
			genes.forEach(function (g) { orgSet[g[1]] = true; });
			var organisms = Object.keys(orgSet).sort();
			var terms = {};
			annotations.forEach(function (r) { if (r[2] != null) terms[r[2]] = true; });
			var termList = Object.keys(terms).sort();
			var base = { n: genes.length, N: 0, organisms: organisms, listAnnotations: annotations, background: [] };
			if (!organisms.length || !termList.length) {
				base.capped = false;
				return base;
			}
			return Promise.all([
				organismCounts(sr, organisms),
				rows(sr, backgroundQuery(organisms, termList))
			]).then(function (bg) {
				base.N = bg[0];
				base.background = bg[1];
				base.capped = bg[1].length >= MAX_ROWS || annotations.length >= MAX_ROWS;
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
		var wrap = node('div', null, 'alliance-disease-enrichment');
		wrap.appendChild(node('span', text));
		el.appendChild(wrap);
	}

	function formatP(p) {
		if (p === 0) return '0';
		return p < 0.001 ? p.toExponential(2) : p.toFixed(4);
	}

	function render(el, data, navigate, opts) {
		clear(el);
		var wrap = node('div', null, 'alliance-disease-enrichment');

		var controls = node('div', null, 'alliance-disease-enrichment-options');
		var fdrLabel = node('label', 'Max FDR ');
		var fdrInput = node('input');
		fdrInput.type = 'number';
		fdrInput.min = '0';
		fdrInput.max = '1';
		fdrInput.step = '0.01';
		fdrInput.value = String(opts.maxFdr);
		fdrLabel.appendChild(fdrInput);
		controls.appendChild(fdrLabel);
		var negLabel = node('label', ' ');
		var negInput = node('input');
		negInput.type = 'checkbox';
		negInput.checked = !!opts.includeNegated;
		negLabel.appendChild(negInput);
		negLabel.appendChild(document.createTextNode(' Include negated annotations (is not implicated in)'));
		controls.appendChild(negLabel);
		wrap.appendChild(controls);

		function update() {
			var v = parseFloat(fdrInput.value);
			opts.maxFdr = isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_MAX_FDR;
			opts.includeNegated = !!negInput.checked;
			render(el, data, navigate, opts);
		}
		fdrInput.addEventListener('change', update);
		negInput.addEventListener('change', update);

		var results = compute(data, opts);
		var shown = results.filter(function (t) { return t.fdr <= opts.maxFdr; });

		wrap.appendChild(
			node(
				'p',
				'Background: all ' + data.N + ' genes of ' + data.organisms.join(', ') +
					' in this mine. List: ' + data.n + ' genes. ' +
					results.length + ' terms tested, ' + shown.length + ' with FDR <= ' + opts.maxFdr + '.',
				'alliance-disease-enrichment-background'
			)
		);
		if (data.capped) {
			wrap.appendChild(node('p', 'Result limit reached, counts may be incomplete.'));
		}

		if (!shown.length) {
			wrap.appendChild(node('p', 'No enriched disease terms at this FDR'));
			el.appendChild(wrap);
			return;
		}

		var table = node('table', null, 'table table-striped');
		var thead = node('thead');
		var hr = node('tr');
		['Disease term', 'k/n', 'K/N', 'Fold', 'p', 'FDR'].forEach(function (h) { hr.appendChild(node('th', h)); });
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
				if (typeof navigate === 'function') navigate('report', { type: 'DOTerm', id: t.id });
			});
			cell.appendChild(a);
			tr.appendChild(cell);
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
		var token = (el.__agrEnrichReq = (el.__agrEnrichReq || 0) + 1);
		var gene = imEntity.Gene;
		var ids = gene && gene.value;
		var list = (Array.isArray(ids) ? ids : [ids]).filter(function (v) {
			return v !== undefined && v !== null && v !== '';
		});
		if (!list.length) {
			message(el, 'No genes to analyse');
			return;
		}
		message(el, 'Loading...');
		load(serviceRoot(service.root), list)
			.then(function (data) {
				if (el.__agrEnrichReq !== token) return;
				if (!data.n) {
					message(el, 'No genes with an organism in this list');
					return;
				}
				render(el, data, navigate, { maxFdr: DEFAULT_MAX_FDR, includeNegated: false });
			})
			.catch(function (err) {
				console.error('Disease enrichment failed', err);
				if (el.__agrEnrichReq !== token) return;
				message(el, 'Could not compute disease enrichment from the mine');
			});
	}

	var api = {
		main: main,
		serviceRoot: serviceRoot,
		hypergeomUpperTail: hypergeomUpperTail,
		benjaminiHochberg: benjaminiHochberg,
		isNegated: isNegated,
		compute: compute,
		escapeXml: escapeXml,
		listGenesQuery: listGenesQuery,
		listAnnotationsQuery: listAnnotationsQuery,
		backgroundQuery: backgroundQuery,
		organismCountQuery: organismCountQuery,
		render: render
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceDiseaseEnrichment = api;
})(typeof window !== 'undefined' ? window : globalThis);
