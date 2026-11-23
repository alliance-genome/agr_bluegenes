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
		return mineFetch(sr.replace(/\/+$/, '') + '/query/results', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: body
		}).then(function (res) {
			if (!res.ok) throw httpError(res);
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
	 * Returns all terms sorted by p, each with fdr; terms with incomplete counts come last with p and fdr null.
	 */
	function compute(data, opts) {
		var includeNegated = !!(opts && opts.includeNegated);
		var list = genesByTerm(data.listAnnotations, 2, 4, includeNegated);
		var back = genesByTerm(data.background, 1, 2, includeNegated);
		var info = {};
		data.listAnnotations.forEach(function (r) {
			if (r[2] != null && !info[r[2]]) info[r[2]] = { id: r[1], name: r[3] };
		});
		var truncated = data.truncated || {};
		var out = Object.keys(list).map(function (ident) {
			var incomplete = !!(data.listCapped || truncated[ident]);
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
				incomplete: incomplete,
				fold: !incomplete && data.n > 0 && K > 0 && data.N > 0 ? (k / data.n) / (K / data.N) : null,
				p: incomplete ? null : hypergeomUpperTail(k, data.n, K, data.N)
			};
		});
		// Terms whose counts were cut off by the row limit have no valid p; BH runs over the complete terms only.
		var complete = out.filter(function (t) { return !t.incomplete; });
		var fdr = benjaminiHochberg(complete.map(function (t) { return t.p; }));
		complete.forEach(function (t, i) { t.fdr = fdr[i]; });
		out.forEach(function (t) { if (t.incomplete) t.fdr = null; });
		out.sort(function (a, b) {
			if (a.incomplete !== b.incomplete) return a.incomplete ? 1 : -1;
			var an = a.name || a.identifier;
			var bn = b.name || b.identifier;
			return (a.p || 0) - (b.p || 0) || (an < bn ? -1 : an > bn ? 1 : 0);
		});
		return out;
	}

	// ---- loading ----

	var TERM_CHUNK = 200;

	// Background rows for the terms, fetched in chunks one after another. A chunk that hits the row limit is split;
	// a single term that still hits it is reported in truncated, because its gene count is incomplete.
	function backgroundRows(sr, organisms, termList, truncated) {
		function fetchTerms(terms) {
			return rows(sr, backgroundQuery(organisms, terms)).then(function (b) {
				if (b.length < MAX_ROWS) return b;
				if (terms.length === 1) {
					truncated[terms[0]] = true;
					return b;
				}
				var mid = Math.ceil(terms.length / 2);
				return fetchTerms(terms.slice(0, mid)).then(function (first) {
					return fetchTerms(terms.slice(mid)).then(function (second) { return first.concat(second); });
				});
			});
		}
		var all = [];
		var chain = Promise.resolve();
		for (var i = 0; i < termList.length; i += TERM_CHUNK) {
			chain = chain.then(
				function (chunk) {
					return function () {
						return fetchTerms(chunk).then(function (b) { all = all.concat(b); });
					};
				}(termList.slice(i, i + TERM_CHUNK))
			);
		}
		return chain.then(function () { return all; });
	}

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
			var listCapped = annotations.length >= MAX_ROWS;
			var base = {
				n: genes.length,
				N: 0,
				organisms: organisms,
				listAnnotations: annotations,
				background: [],
				listCapped: listCapped,
				truncated: {},
				capped: listCapped
			};
			if (!organisms.length || !termList.length) return base;
			return organismCounts(sr, organisms).then(function (total) {
				base.N = total;
				return backgroundRows(sr, organisms, termList, base.truncated).then(function (b) {
					base.background = b;
					if (Object.keys(base.truncated).length) base.capped = true;
					return base;
				});
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

	function message(el, text, cls) {
		clear(el);
		var wrap = node('div', null, 'alliance-disease-enrichment');
		wrap.appendChild(statusNode(text, cls));
		el.appendChild(wrap);
	}

	function formatP(p) {
		if (p === 0) return '0';
		return p < 0.001 ? p.toExponential(2) : p.toFixed(4);
	}

	var TOP_ROWS = 10;
	var CSV_HEADER = ['Term', 'Identifier', 'k', 'n', 'K', 'N', 'Fold', 'p', 'FDR', 'Counts complete'];

	function csvRow(t) {
		return [
			t.name || '', t.identifier, t.k, t.n, t.K, t.N,
			t.fold == null ? '' : t.fold,
			t.p == null ? '' : t.p,
			t.fdr == null ? '' : t.fdr,
			t.incomplete ? 'no' : 'yes'
		];
	}

	function render(el, data, navigate, opts) {
		clear(el);
		var wrap = node('div', null, 'alliance-disease-enrichment');

		var controls = node('div', null, 'agr-filter-bar alliance-disease-enrichment-options');
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

		function update() {
			var v = parseFloat(fdrInput.value);
			opts.maxFdr = isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_MAX_FDR;
			opts.includeNegated = !!negInput.checked;
			render(el, data, navigate, opts);
		}
		fdrInput.addEventListener('change', update);
		negInput.addEventListener('change', update);

		var results = compute(data, opts);
		var shown = results.filter(function (t) { return t.incomplete || t.fdr <= opts.maxFdr; });
		var tested = results.filter(function (t) { return !t.incomplete; }).length;

		var summary = node('p', null, 'alliance-disease-enrichment-background');
		summary.appendChild(document.createTextNode('Background: all ' + count(data.N, 'gene') + ' of '));
		data.organisms.forEach(function (o, i) {
			if (i > 0) summary.appendChild(document.createTextNode(', '));
			summary.appendChild(node('em', o));
		});
		summary.appendChild(document.createTextNode(
			' in this mine. List: ' + count(data.n, 'gene') + '. ' +
				count(tested, 'term') + ' tested, ' + shown.length + ' shown with FDR <= ' + opts.maxFdr + '.'
		));
		wrap.appendChild(summary);
		wrap.appendChild(controls);
		if (data.listCapped) {
			wrap.appendChild(node('p', 'Result limit reached for the list annotations: counts are incomplete, p and FDR are not shown.', 'agr-error alliance-disease-enrichment-capped'));
		} else if (data.capped) {
			wrap.appendChild(node('p', 'Result limit reached for some terms: their background counts are incomplete, so p and FDR are not shown for them.', 'agr-error alliance-disease-enrichment-capped'));
		}

		var note = node('p', 'Hypergeometric upper-tail test with Benjamini-Hochberg FDR. k/n is the list genes with the term, K/N the background genes with the term.', 'agr-note');
		if (!shown.length) {
			wrap.appendChild(statusNode('No enriched disease terms at this FDR', 'agr-empty'));
			wrap.appendChild(note);
			el.appendChild(wrap);
			return;
		}

		var visible = opts.showAll ? shown : shown.slice(0, TOP_ROWS);
		var table = node('table', null, 'agr-table agr-table-sm');
		var thead = node('thead');
		var hr = node('tr');
		['Disease term', 'k/n', 'K/N', 'Fold', 'p', 'FDR'].forEach(function (h, i) { hr.appendChild(colHeader(h, i ? 'num' : null)); });
		thead.appendChild(hr);
		table.appendChild(thead);
		var tbody = node('tbody');
		visible.forEach(function (t) {
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
			tr.appendChild(node('td', t.k + '/' + t.n, 'num'));
			tr.appendChild(node('td', t.incomplete ? '>=' + t.K + '/' + t.N : t.K + '/' + t.N, 'num'));
			tr.appendChild(node('td', t.fold == null ? '' : t.fold.toFixed(2), 'num'));
			tr.appendChild(node('td', t.incomplete ? 'n/a' : formatP(t.p), 'num'));
			tr.appendChild(node('td', t.incomplete ? 'n/a' : formatP(t.fdr), 'num'));
			tbody.appendChild(tr);
		});
		table.appendChild(tbody);
		var tableWrap = node('div', null, 'agr-table-wrap');
		tableWrap.appendChild(table);
		var toolbar = node('div', null, 'agr-filter-bar');
		toolbar.appendChild(csvButton('disease-enrichment.csv', CSV_HEADER, shown.map(csvRow)));
		if (shown.length > TOP_ROWS) {
			var more = node('button', opts.showAll ? 'Show top ' + TOP_ROWS : 'Show all ' + shown.length, 'agr-btn agr-btn-sm');
			more.type = 'button';
			more.addEventListener('click', function () {
				opts.showAll = !opts.showAll;
				render(el, data, navigate, opts);
			});
			toolbar.appendChild(more);
		}
		wrap.appendChild(toolbar);
		wrap.appendChild(tableWrap);
		wrap.appendChild(note);
		el.appendChild(wrap);
	}

	function csvCell(v) {
		var s = String(v === null || v === undefined ? '' : v);
		if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
		return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
	}

	function toCsv(header, rows) {
		return [header].concat(rows).map(function (l) { return l.map(csvCell).join(','); }).join('\r\n') + '\r\n';
	}

	function download(text, filename) {
		var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
		var url = URL.createObjectURL(blob);
		var a = document.createElement('a');
		a.href = url;
		a.download = filename;
		a.click();
		URL.revokeObjectURL(url);
	}

	function csvButton(filename, header, rows) {
		var b = node('button', 'Download CSV', 'agr-btn agr-btn-sm');
		b.type = 'button';
		b.addEventListener('click', function () { download(toCsv(header, rows), filename); });
		return b;
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
		var token = (el.__agrEnrichReq = (el.__agrEnrichReq || 0) + 1);
		var gene = imEntity.Gene;
		var ids = gene && gene.value;
		var list = (Array.isArray(ids) ? ids : [ids]).filter(function (v) {
			return v !== undefined && v !== null && v !== '';
		});
		if (!list.length) {
			message(el, 'No genes to analyse', 'agr-empty');
			return;
		}
		message(el, 'Loading', 'agr-loading');
		load(serviceRoot(service.root), list)
			.then(function (data) {
				if (el.__agrEnrichReq !== token) return;
				if (!data.n) {
					message(el, 'No genes with an organism in this list', 'agr-empty');
					return;
				}
				render(el, data, navigate, { maxFdr: DEFAULT_MAX_FDR, includeNegated: false });
			})
			.catch(function (err) {
				console.error('Disease enrichment failed', err);
				if (el.__agrEnrichReq !== token) return;
				message(el, errorText(err, 'Could not compute disease enrichment from the mine'), 'agr-error');
			});
	}

	var api = {
		mineFetch: mineFetch,
		count: count,
		toCsv: toCsv,
		csvRow: csvRow,
		CSV_HEADER: CSV_HEADER,
		errorText: errorText,
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
