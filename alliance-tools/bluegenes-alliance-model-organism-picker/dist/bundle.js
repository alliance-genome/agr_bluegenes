/*
 * Model organism picker, a BlueGenes tool (tool API version 2).
 * Plain JavaScript without dependencies, so this file is both the source and
 * the bundle. BlueGenes loads it as a script and calls
 * bluegenesAllianceModelOrganismPicker.main(el, service, entity, state, config, navigate).
 *
 * Ranks the orthologs of one gene by an ortholog confidence term times a
 * resource term built from the alleles, phenotype annotations, direct disease
 * annotations, disease models and expression annotations of each ortholog.
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
	var BEST_BONUS = 0.1;

	var HOMOLOGUE_VIEW = [
		'Gene.homologues.homologue.id',
		'Gene.homologues.homologue.primaryIdentifier',
		'Gene.homologues.homologue.symbol',
		'Gene.homologues.homologue.organism.shortName',
		'Gene.homologues.algorithmsMatch',
		'Gene.homologues.algorithmsAttempted',
		'Gene.homologues.isBestScore',
		'Gene.homologues.isBestReverseScore'
	];

	// One query per resource type; each lists Gene.id and the id of the counted object.
	var COUNT_QUERIES = {
		alleles: ['Gene.id', 'Gene.alleles.id'],
		phenotypes: ['Gene.id', 'Gene.phenotypeAnnotations.id'],
		diseases: ['Gene.id', 'Gene.diseaseAnnotation.id', 'Gene.diseaseAnnotation.qualifier'],
		models: ['Gene.id', 'Gene.diseaseModels.id'],
		expression: ['Gene.id', 'Gene.expressionAnnotations.id']
	};
	var RESOURCE_KEYS = ['alleles', 'phenotypes', 'diseases', 'models', 'expression'];
	var RESOURCE_LABELS = {
		alleles: 'Alleles',
		phenotypes: 'Phenotypes',
		diseases: 'Disease',
		models: 'Disease models',
		expression: 'Expression'
	};

	function escapeXml(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function constraintFor(ids) {
		var list = (Array.isArray(ids) ? ids : [ids]).map(String);
		return list.length === 1
			? '<constraint path="Gene.id" op="=" value="' + escapeXml(list[0]) + '"/>'
			: '<constraint path="Gene.id" op="ONE OF">' +
				list.map(function (v) { return '<value>' + escapeXml(v) + '</value>'; }).join('') +
				'</constraint>';
	}

	// ids is one internal Gene.id or an array of them.
	function buildQuery(view, ids) {
		return (
			'<query model="genomic" view="' + view.join(' ') + '" sortOrder="' + view[0] + ' asc">' +
			constraintFor(ids) +
			'</query>'
		);
	}

	function resultsUrl(serviceRoot) {
		return serviceRoot.replace(/\/+$/, '') + '/query/results';
	}

	// The id list goes in a POST body: a GET query string fails above about 250 ids.
	function requestBody(view, ids) {
		return 'format=json&size=' + MAX_ROWS + '&query=' + encodeURIComponent(buildQuery(view, ids));
	}

	// Disease qualifiers asserted directly on the gene: not inferred through
	// orthology and not a negation.
	function isDirectQualifier(q) {
		if (typeof q !== 'string' || !q.trim()) return false;
		q = q.trim().toLowerCase();
		return q !== 'is_not_implicated_in' && !/_via_orthology$/.test(q);
	}

	// Ortholog confidence: fraction of attempted algorithms that matched, plus
	// 0.1 for each of isBestScore and isBestReverseScore. Range 0 to 1.2.
	function confidence(match, attempted, best, bestReverse) {
		var m = Number(match);
		var a = Number(attempted);
		var ratio = a > 0 && m >= 0 ? Math.min(m / a, 1) : 0;
		return ratio + (best ? BEST_BONUS : 0) + (bestReverse ? BEST_BONUS : 0);
	}

	// Resource term: 1 + sum of ln(1 + count) over the five resource counts.
	function resourceTerm(counts) {
		var sum = 0;
		RESOURCE_KEYS.forEach(function (k) {
			var n = Number(counts && counts[k]);
			if (n > 0) sum += Math.log1p(n);
		});
		return 1 + sum;
	}

	// score = confidence * resource term. Pure function, no I/O.
	function score(o) {
		o = o || {};
		return confidence(o.match, o.attempted, o.best, o.bestReverse) * resourceTerm(o);
	}

	function cmp(a, b) {
		a = a == null ? '' : String(a);
		b = b == null ? '' : String(b);
		return a < b ? -1 : a > b ? 1 : 0;
	}

	// Highest score first; ties by species, symbol, identifier.
	function rank(orthologs) {
		return orthologs
			.map(function (o) {
				var copy = {};
				Object.keys(o).forEach(function (k) { copy[k] = o[k]; });
				copy.score = score(o);
				return copy;
			})
			.sort(function (a, b) {
				return (
					b.score - a.score ||
					cmp(a.species, b.species) ||
					cmp(a.symbol || a.identifier, b.symbol || b.identifier) ||
					cmp(a.identifier, b.identifier)
				);
			});
	}

	// Rows [id, ..., match, attempted, best, bestReverse] to one entry per
	// homologue id, keeping the entry with the higher confidence.
	function toOrthologs(rows) {
		var by = {};
		rows.forEach(function (r) {
			if (r[0] == null) return;
			var o = {
				id: r[0],
				identifier: r[1],
				symbol: r[2],
				species: r[3],
				match: r[4],
				attempted: r[5],
				best: r[6] === true,
				bestReverse: r[7] === true
			};
			var key = String(o.id);
			if (!by[key] || confidence(o.match, o.attempted, o.best, o.bestReverse) >
				confidence(by[key].match, by[key].attempted, by[key].best, by[key].bestReverse)) {
				by[key] = o;
			}
		});
		return Object.keys(by).map(function (k) { return by[k]; });
	}

	// Counts distinct counted-object ids per Gene.id. Rows are [geneId, objectId, ...].
	// keep(row) may drop a row (used for the disease qualifier filter).
	function countByGene(rows, keep) {
		var seen = {};
		rows.forEach(function (r) {
			if (r[0] == null || r[1] == null) return;
			if (keep && !keep(r)) return;
			(seen[String(r[0])] = seen[String(r[0])] || {})[String(r[1])] = true;
		});
		var out = {};
		Object.keys(seen).forEach(function (g) { out[g] = Object.keys(seen[g]).length; });
		return out;
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

	function message(el, text, cls) {
		clear(el);
		var wrap = node('div', null, 'alliance-model-organism-picker');
		wrap.appendChild(statusNode(text, cls));
		el.appendChild(wrap);
	}

	function support(o) {
		if (o.match == null || o.attempted == null) return '';
		var s = o.match + '/' + o.attempted;
		if (o.best && o.bestReverse) return s + ', best both ways';
		if (o.best) return s + ', best';
		if (o.bestReverse) return s + ', best reverse';
		return s;
	}

	// Count cells shade from heat-1 (1) to heat-6 (20 or more). Zero stays unshaded.
	function heatClass(n) {
		if (!n) return 'num';
		var step = n >= 20 ? 6 : n >= 10 ? 5 : n >= 5 ? 4 : n >= 3 ? 3 : n >= 2 ? 2 : 1;
		return 'num agr-heat-' + step;
	}

	function formatScore(n) {
		return (Math.round(n * 100) / 100).toFixed(2);
	}

	function howRanked() {
		var details = node('details', null, 'agr-note alliance-model-organism-picker-formula');
		details.appendChild(node('summary', 'How is this ranked?'));
		[
			'score = confidence x resource',
			'confidence = algorithmsMatch / algorithmsAttempted, plus ' + BEST_BONUS +
				' if the ortholog is the best score and ' + BEST_BONUS + ' if it is the best reverse score (0 to ' +
				(1 + 2 * BEST_BONUS).toFixed(1) + ').',
			'resource = 1 + ln(1 + alleles) + ln(1 + phenotype annotations) + ln(1 + disease annotations) + ' +
				'ln(1 + disease models) + ln(1 + expression annotations).',
			'Disease annotations count direct qualifiers only: is_not_implicated_in and *_via_orthology are excluded.',
			'Logarithms keep one very large count from outweighing the other four.'
		].forEach(function (t) { details.appendChild(node('p', t)); });
		return details;
	}

	function buildSection(orthologs, navigate, truncated, unavailable) {
		unavailable = unavailable || [];
		var keys = RESOURCE_KEYS.filter(function (k) { return unavailable.indexOf(k) < 0; });
		var wrap = node('div', null, 'alliance-model-organism-picker');
		if (!orthologs.length) {
			wrap.appendChild(statusNode('No orthologs for this gene', 'agr-empty'));
			return wrap;
		}
		var ranked = rank(orthologs);
		var species = {};
		ranked.forEach(function (o) { species[o.species || 'Unknown species'] = true; });
		var top = ranked[0];
		var summary = node('p', null, 'alliance-model-organism-picker-summary');
		summary.appendChild(document.createTextNode(
			count(ranked.length, 'ortholog') + ' in ' + count(Object.keys(species).length, 'species', 'species') + '. Top: ' +
				(top.symbol || top.identifier) + ' ('
		));
		summary.appendChild(node('em', top.species || 'Unknown species'));
		summary.appendChild(document.createTextNode('), score ' + formatScore(top.score) + '.'));
		wrap.appendChild(summary);
		if (truncated) {
			wrap.appendChild(node('p', 'A result set was cut at ' + MAX_ROWS + ' rows, so some counts are lower bounds.', 'agr-note'));
		}

		var table = node('table', null, 'agr-table agr-table-sm');
		var headRow = node('tr');
		['Species', 'Symbol', 'Confidence']
			.concat(keys.map(function (k) { return RESOURCE_LABELS[k]; }), ['Score'])
			.forEach(function (h, i) { headRow.appendChild(colHeader(h, i >= 3 ? 'num' : null)); });
		var thead = node('thead');
		thead.appendChild(headRow);
		table.appendChild(thead);

		var tbody = node('tbody');
		ranked.forEach(function (o) {
			var tr = node('tr');
			var spCell = node('td');
			if (o.species) spCell.appendChild(node('em', o.species));
			tr.appendChild(spCell);
			var symCell = node('td');
			var a = node('a', o.symbol || o.identifier || o.id);
			a.href = '#';
			a.title = o.identifier || '';
			a.addEventListener('click', function (ev) {
				if (ev && ev.preventDefault) ev.preventDefault();
				if (typeof navigate === 'function') navigate('report', { type: 'Gene', id: o.id });
			});
			symCell.appendChild(a);
			tr.appendChild(symCell);
			tr.appendChild(node('td', support(o)));
			keys.forEach(function (k) { tr.appendChild(node('td', o[k] || 0, heatClass(o[k]))); });
			tr.appendChild(node('td', formatScore(o.score), 'num'));
			tbody.appendChild(tr);
		});
		table.appendChild(tbody);
		var tableWrap = node('div', null, 'agr-table-wrap');
		tableWrap.appendChild(table);
		wrap.appendChild(tableWrap);
		if (unavailable.length) {
			wrap.appendChild(
				node(
					'p',
					'This mine has no data for: ' +
						unavailable.map(function (k) { return RESOURCE_LABELS[k].toLowerCase(); }).join(', ') +
						'. Those columns are left out of the score.',
					'agr-note alliance-model-organism-picker-note'
				)
			);
		}
		wrap.appendChild(howRanked());
		return wrap;
	}

	function render(el, orthologs, navigate, truncated, unavailable) {
		clear(el);
		el.appendChild(buildSection(orthologs, navigate, truncated, unavailable));
	}

	// One section per gene. genes: [{ id, label, orthologs, truncated }].
	function renderMany(el, genes, navigate, note) {
		clear(el);
		var outer = node('div', null, 'alliance-model-organism-picker-list');
		if (note) outer.appendChild(node('p', note, 'agr-note'));
		genes.forEach(function (g) {
			var section = node('div', null, 'alliance-model-organism-picker-gene');
			section.appendChild(node('h4', g.label));
			section.appendChild(buildSection(g.orthologs, navigate, g.truncated, g.unavailable));
			outer.appendChild(section);
		});
		el.appendChild(outer);
	}

	// Applies fn to each item one after another and resolves to the results in order.
	function sequence(items, fn) {
		var out = [];
		return items
			.reduce(function (chain, item) {
				return chain.then(function () {
					return fn(item).then(function (v) { out.push(v); });
				});
			}, Promise.resolve())
			.then(function () { return out; });
	}

	function fetchRows(serviceRoot, view, ids) {
		return mineFetch(resultsUrl(serviceRoot), {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: requestBody(view, ids)
		})
			.then(function (res) {
				if (!res.ok) {
					throw httpError(res);
				}
				return res.json();
			})
			.then(function (json) {
				return (json && json.results) || [];
			});
	}

	// Orthologs of one gene, then one count query per resource over all ortholog ids, one after another.
	function load(sRoot, geneId) {
		return fetchRows(sRoot, HOMOLOGUE_VIEW, geneId).then(function (rows) {
			var orthologs = toOrthologs(rows);
			if (!orthologs.length) return { orthologs: [], truncated: false, unavailable: [] };
			var ids = orthologs.map(function (o) { return o.id; });
			var truncated = rows.length >= MAX_ROWS;
			var unavailable = [];
			return sequence(
				RESOURCE_KEYS,
				function (k) {
					return fetchRows(sRoot, COUNT_QUERIES[k], ids).then(function (r) {
						if (r.length >= MAX_ROWS) truncated = true;
						return countByGene(r, k === 'diseases' ? function (row) { return isDirectQualifier(row[2]); } : null);
					}, function (err) {
						// HTTP 400 is the mine rejecting the path: its model lacks this data.
						// Anything else (network, 5xx) still fails the whole tool.
						if (err && err.status === 400) {
							unavailable.push(k);
							return {};
						}
						throw err;
					});
				}
			).then(function (counts) {
				orthologs.forEach(function (o) {
					RESOURCE_KEYS.forEach(function (k, i) { o[k] = counts[i][String(o.id)] || 0; });
				});
				return { orthologs: orthologs, truncated: truncated, unavailable: unavailable };
			});
		});
	}

	var MAX_GENES = 10;

	// Symbols for the gene headings of a list, in one query.
	function loadLabels(sRoot, ids) {
		return fetchRows(sRoot, ['Gene.id', 'Gene.symbol', 'Gene.primaryIdentifier'], ids).then(function (rows) {
			var out = {};
			rows.forEach(function (r) { out[String(r[0])] = r[1] || r[2]; });
			return out;
		}).catch(function (err) {
			console.error('Model organism picker could not load gene symbols', err);
			return {};
		});
	}

	function loadMany(sRoot, ids) {
		return loadLabels(sRoot, ids).then(function (labels) {
			return sequence(ids, function (id) { return load(sRoot, id); }).then(function (loaded) {
				return ids.map(function (id, i) {
					return {
						id: id,
						label: labels[id] || 'Gene ' + id,
						orthologs: loaded[i].orthologs,
						truncated: loaded[i].truncated,
						unavailable: loaded[i].unavailable
					};
				});
			});
		});
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
		var token = (el.__agrPickerReq = (el.__agrPickerReq || 0) + 1);
		var gene = imEntity.Gene;
		var value = gene && gene.value;
		if (Array.isArray(value)) {
			var all = value.filter(function (v) { return v !== undefined && v !== null && v !== ''; }).map(String);
			if (all.length > 1) {
				var shown = all.slice(0, MAX_GENES);
				var note = all.length > shown.length
					? 'Showing the first ' + shown.length + ' of ' + all.length + ' genes.'
					: null;
				message(el, 'Loading orthologs', 'agr-loading');
				loadMany(serviceRoot(service.root), shown)
					.then(function (genes) {
						if (el.__agrPickerReq !== token) return;
						renderMany(el, genes, navigate, note);
					})
					.catch(function (err) {
						console.error('Model organism picker failed', err);
						if (el.__agrPickerReq !== token) return;
						message(el, errorText(err, 'Could not load orthologs from the mine'), 'agr-error');
					});
				return;
			}
			value = all[0];
		}
		if (value === undefined || value === null || value === '') {
			message(el, 'No orthologs for this gene', 'agr-empty');
			return;
		}
		message(el, 'Loading orthologs', 'agr-loading');
		load(serviceRoot(service.root), String(value))
			.then(function (result) {
				if (el.__agrPickerReq !== token) return;
				render(el, result.orthologs, navigate, result.truncated, result.unavailable);
			})
			.catch(function (err) {
				console.error('Model organism picker failed', err);
				if (el.__agrPickerReq !== token) return;
				message(el, errorText(err, 'Could not load orthologs from the mine'), 'agr-error');
			});
	}

	var api = {
		mineFetch: mineFetch,
		count: count,
		errorText: errorText,
		main: main,
		serviceRoot: serviceRoot,
		buildQuery: buildQuery,
		resultsUrl: resultsUrl,
		requestBody: requestBody,
		escapeXml: escapeXml,
		isDirectQualifier: isDirectQualifier,
		confidence: confidence,
		resourceTerm: resourceTerm,
		score: score,
		rank: rank,
		toOrthologs: toOrthologs,
		countByGene: countByGene,
		render: render,
		renderMany: renderMany
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceModelOrganismPicker = api;
})(typeof window !== 'undefined' ? window : globalThis);
