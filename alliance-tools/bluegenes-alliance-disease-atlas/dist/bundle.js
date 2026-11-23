/*
 * Genes for this disease, a BlueGenes tool (tool API version 2).
 * Plain JavaScript without dependencies, so this file is both the source and
 * the bundle. BlueGenes loads it as a script and calls
 * bluegenesAllianceDiseaseAtlas.main(el, service, entity, state, config, navigate).
 *
 * On a DOTerm report page: genes annotated to the term (Gene.diseaseAnnotation)
 * and, with "include child terms", to its descendants (DOTerm.parents is the
 * transitive closure, so descendants are the terms with DOTerm.parents = this
 * term). Disease models (Gene.diseaseModels.disease) are listed in their own
 * column. Genes are grouped by organism. is_not_implicated_in annotations are
 * not counted and are listed separately.
 */
(function (root) {
	'use strict';

	// BlueGenes passes the mine root (for example https://host/mine); the web
	// services live under /service. Accept either form.
	function serviceRoot(root) {
		var r = String(root || '').replace(/\/+$/, '');
		return /\/service$/.test(r) ? r : r + '/service';
	}

	var MAX_ROWS = 100000;

	function escapeXml(v) {
		return String(v)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&apos;');
	}

	function oneOf(path, values) {
		return (
			'<constraint path="' + path + '" op="ONE OF">' +
			values.map(function (v) { return '<value>' + escapeXml(v) + '</value>'; }).join('') +
			'</constraint>'
		);
	}

	function query(view, constraints, joins) {
		return (
			'<query model="genomic" view="' + view.join(' ') + '">' +
			(joins || []).map(function (j) { return '<join path="' + j + '" style="OUTER"/>'; }).join('') +
			constraints.join('') +
			'</query>'
		);
	}

	var ANN = 'Gene.diseaseAnnotation';
	var GENE_VIEW = ['Gene.id', 'Gene.symbol', 'Gene.primaryIdentifier', 'Gene.organism.shortName'];

	// The term itself: [id, identifier, name].
	function termQuery(id) {
		return query(
			['DOTerm.id', 'DOTerm.identifier', 'DOTerm.name'],
			['<constraint path="DOTerm.id" op="=" value="' + escapeXml(id) + '"/>']
		);
	}

	// Descendants of the term (DOTerm.parents is the transitive closure): [id, identifier, name].
	function childTermsQuery(id) {
		return query(
			['DOTerm.id', 'DOTerm.identifier', 'DOTerm.name'],
			['<constraint path="DOTerm.parents.id" op="=" value="' + escapeXml(id) + '"/>']
		);
	}

	// Annotation rows: gene columns, term identifier, term name, qualifier, evidence code.
	function annotationQuery(identifiers) {
		return query(
			GENE_VIEW.concat([
				ANN + '.ontologyTerm.identifier',
				ANN + '.ontologyTerm.name',
				ANN + '.qualifier',
				ANN + '.evidence.code.code'
			]),
			[oneOf(ANN + '.ontologyTerm.identifier', identifiers)],
			[ANN + '.evidence', ANN + '.evidence.code']
		);
	}

	// Disease model rows: gene columns, term identifier, term name, model name, association type.
	function modelQuery(identifiers) {
		return query(
			GENE_VIEW.concat([
				'Gene.diseaseModels.disease.identifier',
				'Gene.diseaseModels.disease.name',
				'Gene.diseaseModels.modelName',
				'Gene.diseaseModels.associationType'
			]),
			[oneOf('Gene.diseaseModels.disease.identifier', identifiers)]
		);
	}

	// The id list goes in a POST body: a GET query string fails above about 250 ids.
	function post(sr, params) {
		var body = Object.keys(params)
			.map(function (k) { return k + '=' + encodeURIComponent(params[k]); })
			.join('&');
		return mineFetch(sr.replace(/\/+$/, '') + '/query/results', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: body
		}).then(function (res) {
			if (!res.ok) {
				throw httpError(res);
			}
			return res.json();
		});
	}

	// HTTP 400 is the mine rejecting a path: its model lacks that part. Optional
	// queries resolve to the fallback and call onMissing; any other failure still rejects.
	function optionalRows(sr, q, fallback, onMissing) {
		return rows(sr, q).catch(function (err) {
			if (err && err.status === 400) {
				onMissing();
				return fallback;
			}
			throw err;
		});
	}

	function rows(sr, q) {
		return post(sr, { format: 'json', size: MAX_ROWS, query: q }).then(function (j) {
			return (j && j.results) || [];
		});
	}

	// ---- classification ----

	// 'is_not_implicated_in', 'NOT' and similar. 'implicated_via_orthology' is not negated.
	function isNegated(qualifier) {
		return /(^|[^a-z])not([^a-z]|$)/i.test(String(qualifier || ''));
	}

	function isViaOrthology(qualifier) {
		return /via_orthology/i.test(String(qualifier || ''));
	}

	function addUnique(list, v) {
		if (v !== null && v !== undefined && v !== '' && list.indexOf(v) < 0) list.push(v);
	}

	// Gene record from the first four columns of a row.
	function geneOf(by, r) {
		var g = by[r[0]];
		if (!g) {
			g = by[r[0]] = {
				id: r[0],
				symbol: r[1] || r[2] || String(r[0]),
				primaryIdentifier: r[2],
				organism: r[3] || 'Unknown organism',
				direct: {},
				orthology: {},
				models: {},
				negated: {}
			};
		}
		return g;
	}

	function entry(bucket, key, label) {
		var e = bucket[key];
		if (!e) e = bucket[key] = { label: label, codes: [] };
		return e;
	}

	/*
	 * annotationRows: [geneId, symbol, pid, organism, termIdent, termName, qualifier, evidenceCode]
	 * modelRows:      [geneId, symbol, pid, organism, termIdent, termName, modelName, associationType]
	 * Returns { organisms: [{ name, genes: [gene], notGenes: [gene] }], geneCount, notCount }.
	 * A gene counts when it has a direct, orthology or model entry; genes with
	 * only negated annotations are in notGenes. Genes with both appear in both.
	 */
	function group(annotationRows, modelRows) {
		var by = {};
		annotationRows.forEach(function (r) {
			if (r[0] == null || r[4] == null) return;
			var g = geneOf(by, r);
			var q = r[6] || 'annotated';
			var bucket = isNegated(q) ? g.negated : isViaOrthology(q) ? g.orthology : g.direct;
			var e = entry(bucket, q + '|' + r[4], q);
			e.term = r[5] || r[4];
			addUnique(e.codes, r[7]);
		});
		modelRows.forEach(function (r) {
			if (r[0] == null || r[4] == null) return;
			var g = geneOf(by, r);
			var label = r[6] || 'disease model';
			var e = entry(g.models, label + '|' + r[4], label);
			e.term = r[5] || r[4];
			e.type = r[7];
		});
		var orgs = {};
		Object.keys(by).forEach(function (id) {
			var g = by[id];
			var o = (orgs[g.organism] = orgs[g.organism] || { name: g.organism, genes: [], notGenes: [] });
			if (Object.keys(g.direct).length || Object.keys(g.orthology).length || Object.keys(g.models).length) {
				o.genes.push(g);
			}
			if (Object.keys(g.negated).length) o.notGenes.push(g);
		});
		var list = Object.keys(orgs)
			.sort()
			.map(function (k) { return orgs[k]; })
			.filter(function (o) { return o.genes.length || o.notGenes.length; });
		var bySymbol = function (a, b) { return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0; };
		var geneCount = 0;
		var notCount = 0;
		list.forEach(function (o) {
			o.genes.sort(bySymbol);
			o.notGenes.sort(bySymbol);
			geneCount += o.genes.length;
			notCount += o.notGenes.length;
		});
		return { organisms: list, geneCount: geneCount, notCount: notCount };
	}

	// PathQuery object for navigate('query', ...): the genes of one organism by internal id.
	function geneQueryObject(genes) {
		return {
			from: 'Gene',
			select: ['Gene.primaryIdentifier', 'Gene.symbol', 'Gene.organism.shortName'],
			orderBy: [{ path: 'Gene.symbol', direction: 'ASC' }],
			where: [{ path: 'Gene.id', op: 'ONE OF', values: genes.map(function (g) { return String(g.id); }) }]
		};
	}

	// ---- loading ----

	// Resolves to { term, terms: [{identifier, name}], annotations, models, capped,
	// modelsUnavailable, childrenUnavailable }.
	function load(sr, id, includeChildren) {
		var modelsUnavailable = false;
		var childrenUnavailable = false;
		return rows(sr, termQuery(id)).then(function (t) {
			if (!t.length) {
				return { term: null, terms: [], annotations: [], models: [], capped: false, modelsUnavailable: false, childrenUnavailable: false };
			}
			var term = { id: t[0][0], identifier: t[0][1], name: t[0][2] };
			var kids = includeChildren
				? optionalRows(sr, childTermsQuery(id), [], function () { childrenUnavailable = true; })
				: Promise.resolve([]);
			return kids.then(function (children) {
				var seen = {};
				var terms = [];
				[[term.id, term.identifier, term.name]].concat(children).forEach(function (r) {
					if (r[1] == null || seen[r[1]]) return;
					seen[r[1]] = true;
					terms.push({ identifier: r[1], name: r[2] });
				});
				var idents = terms.map(function (x) { return x.identifier; });
				return Promise.all([
					rows(sr, annotationQuery(idents)),
					optionalRows(sr, modelQuery(idents), [], function () { modelsUnavailable = true; })
				]).then(function (res) {
					return {
						term: term,
						terms: terms,
						annotations: res[0],
						models: res[1],
						capped: res[0].length >= MAX_ROWS || res[1].length >= MAX_ROWS,
						modelsUnavailable: modelsUnavailable,
						childrenUnavailable: childrenUnavailable
					};
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
		var wrap = node('div', null, 'alliance-disease-atlas');
		wrap.appendChild(statusNode(text, cls));
		el.appendChild(wrap);
	}

	function symbolLink(gene, navigate) {
		var a = node('a', gene.symbol);
		a.href = '#';
		a.title = gene.primaryIdentifier || '';
		a.addEventListener('click', function (ev) {
			if (ev && ev.preventDefault) ev.preventDefault();
			if (typeof navigate === 'function') navigate('report', { type: 'Gene', id: gene.id });
		});
		return a;
	}

	function evidenceCell(bucket, withTerm, formatter) {
		var td = node('td');
		Object.keys(bucket).sort().forEach(function (k) {
			var e = bucket[k];
			var text = formatter(e) + (withTerm ? ' - ' + e.term : '');
			td.appendChild(node('div', text));
		});
		return td;
	}

	function annotationText(e) {
		return e.label + (e.codes.length ? ' (' + e.codes.join(', ') + ')' : '');
	}

	function modelText(e) {
		// Alliance model names carry <sup> markup for allele symbols; show them as plain text.
		return e.label.replace(/<\/?[a-z]+>/gi, '') + (e.type ? ' (' + e.type + ')' : '');
	}

	function organismSection(org, navigate, withTerm, showModels) {
		var sec = node('div', null, 'alliance-disease-atlas-organism');
		var head = node('h4');
		head.appendChild(node('em', org.name));
		head.appendChild(document.createTextNode(' '));
		head.appendChild(node('span', '(' + count(org.genes.length, 'gene') + ')', 'agr-count'));
		sec.appendChild(head);
		if (org.genes.length) {
			var btn = node('button', 'Open as query', 'agr-btn agr-btn-sm alliance-disease-atlas-open');
			btn.type = 'button';
			btn.addEventListener('click', function () {
				if (typeof navigate === 'function') navigate('query', geneQueryObject(org.genes));
			});
			sec.appendChild(btn);

			var table = node('table', null, 'agr-table agr-table-sm');
			var thead = node('thead');
			var hr = node('tr');
			['Gene', 'Direct', 'Via orthology'].concat(showModels ? ['Disease models'] : [])
					.forEach(function (h) { hr.appendChild(colHeader(h)); });
			thead.appendChild(hr);
			table.appendChild(thead);
			var tbody = node('tbody');
			org.genes.forEach(function (g) {
				var tr = node('tr');
				var first = node('td');
				first.appendChild(symbolLink(g, navigate));
				tr.appendChild(first);
				tr.appendChild(evidenceCell(g.direct, withTerm, annotationText));
				tr.appendChild(evidenceCell(g.orthology, withTerm, annotationText));
				if (showModels) tr.appendChild(evidenceCell(g.models, withTerm, modelText));
				tbody.appendChild(tr);
			});
			table.appendChild(tbody);
			var tableWrap = node('div', null, 'agr-table-wrap');
			tableWrap.appendChild(table);
			sec.appendChild(tableWrap);
		}
		if (org.notGenes.length) {
			var p = node('p', 'Annotated NOT (' + org.notGenes.length + '): ', 'agr-note alliance-disease-atlas-not');
			org.notGenes.forEach(function (g, i) {
				if (i) p.appendChild(document.createTextNode(', '));
				p.appendChild(symbolLink(g, navigate));
			});
			sec.appendChild(p);
		}
		return sec;
	}

	function render(el, data, navigate, includeChildren, onToggle) {
		clear(el);
		var wrap = node('div', null, 'alliance-disease-atlas');

		var bar = node('div', null, 'agr-filter-bar');
		var label = node('label', ' ');
		var box = node('input');
		box.type = 'checkbox';
		box.checked = !!includeChildren && !data.childrenUnavailable;
		box.disabled = !!data.childrenUnavailable;
		label.appendChild(box);
		label.appendChild(document.createTextNode(' include child terms'));
		box.addEventListener('change', function () { onToggle(!!box.checked); });
		bar.appendChild(label);

		var g = group(data.annotations, data.models);
		var nTerms = data.terms.length;
		var summary = (
			node(
				'p',
				count(g.geneCount, 'gene') + ' in ' + count(g.organisms.length, 'organism') + ' annotated to ' +
					(data.term.name || data.term.identifier) +
					(includeChildren ? ' and ' + count(nTerms - 1, 'child term') : '') +
					'. ' + count(g.notCount, 'gene') + ' annotated NOT.',
				'alliance-disease-atlas-summary'
			)
		);
		wrap.appendChild(summary);
		wrap.appendChild(bar);
		if (data.modelsUnavailable) {
			wrap.appendChild(node('p', 'This mine has no disease model data, so the disease models column is left out.', 'agr-note alliance-disease-atlas-note'));
		}
		if (data.childrenUnavailable) {
			wrap.appendChild(node('p', 'This mine has no child term data, so only the term itself is used.', 'agr-note alliance-disease-atlas-note'));
		}
		if (data.capped) wrap.appendChild(node('p', 'Result limit reached, the list may be incomplete.', 'agr-note'));
		if (!g.organisms.length) {
			wrap.appendChild(statusNode('No genes annotated to this disease term', 'agr-empty'));
		}
		g.organisms.forEach(function (o) {
			wrap.appendChild(organismSection(o, navigate, includeChildren, !data.modelsUnavailable));
		});
		wrap.appendChild(node('p', 'Disease annotations as stored in this mine. Direct annotations sit on the gene, via orthology ones are inferred from its orthologs.', 'agr-note'));
		el.appendChild(wrap);
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
		var entity = imEntity.DOTerm;
		var id = entity && entity.value;
		if (Array.isArray(id)) id = id[0];
		if (id === undefined || id === null || id === '') {
			message(el, 'No disease term', 'agr-empty');
			return;
		}
		var sr = serviceRoot(service.root);

		function run(includeChildren) {
			var token = (el.__agrAtlasReq = (el.__agrAtlasReq || 0) + 1);
			message(el, 'Loading', 'agr-loading');
			load(sr, id, includeChildren)
				.then(function (data) {
					if (el.__agrAtlasReq !== token) return;
					if (!data.term) {
						message(el, 'Disease term not found in this mine', 'agr-empty');
						return;
					}
					render(el, data, navigate, includeChildren, run);
				})
				.catch(function (err) {
					console.error('Disease atlas failed', err);
					if (el.__agrAtlasReq !== token) return;
					message(el, errorText(err, 'Could not load genes for this disease from the mine'), 'agr-error');
				});
		}
		run(false);
	}

	var api = {
		mineFetch: mineFetch,
		count: count,
		errorText: errorText,
		main: main,
		serviceRoot: serviceRoot,
		escapeXml: escapeXml,
		termQuery: termQuery,
		childTermsQuery: childTermsQuery,
		annotationQuery: annotationQuery,
		modelQuery: modelQuery,
		isNegated: isNegated,
		isViaOrthology: isViaOrthology,
		group: group,
		geneQueryObject: geneQueryObject,
		render: render
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceDiseaseAtlas = api;
})(typeof window !== 'undefined' ? window : globalThis);
