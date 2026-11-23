/*
 * Disease via orthologs, a BlueGenes tool (tool API version 2).
 * Plain JavaScript without dependencies, so this file is both the source and
 * the bundle. BlueGenes loads it as a script and calls
 * bluegenesAllianceOrthologDisease.main(el, service, entity, state, config, navigate).
 */
(function (root) {
	'use strict';

	// BlueGenes passes the mine root (for example https://host/mine); the web
	// services live under /service. Accept either form.
	function serviceRoot(root) {
		var r = String(root || '').replace(/\/+$/, '');
		return /\/service$/.test(r) ? r : r + '/service';
	}

	var DO_URL = 'https://disease-ontology.org/?id=';
	var MAX_ROWS = 5000;
	var COLLAPSE_AFTER = 25;
	var ORTHOLOG = 'Gene.homologues.homologue';
	var VIEW = [
		'Gene.id',
		'Gene.primaryIdentifier',
		ORTHOLOG + '.symbol',
		ORTHOLOG + '.primaryIdentifier',
		ORTHOLOG + '.organism.shortName',
		ORTHOLOG + '.diseaseAnnotation.ontologyTerm.identifier',
		ORTHOLOG + '.diseaseAnnotation.ontologyTerm.name',
		ORTHOLOG + '.diseaseAnnotation.qualifier',
		ORTHOLOG + '.diseaseAnnotation.evidence.code.code'
	];
	var OWN_VIEW = ['Gene.id', 'Gene.diseaseAnnotation.ontologyTerm.identifier'];
	// Orthology-inferred annotations are copies of other orthologs' evidence and would double-count species.
	var ORTHOLOG_QUALIFIER = ORTHOLOG + '.diseaseAnnotation.qualifier';
	var OWN_QUALIFIER = 'Gene.diseaseAnnotation.qualifier';
	var EXCLUDED_QUALIFIERS = ['implicated_via_orthology', 'biomarker_via_orthology', 'is_not_implicated_in'];
	var OWN_EXCLUDED_QUALIFIERS = ['is_not_implicated_in'];

	function escapeXml(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	// ids is one internal Gene.id or an array of them.
	function buildQuery(ids, view, sortOrder, qualifierPath, excluded) {
		var list = (Array.isArray(ids) ? ids : [ids]).map(String);
		var constraint =
			list.length === 1
				? '<constraint path="Gene.id" op="=" value="' + escapeXml(list[0]) + '"/>'
				: '<constraint path="Gene.id" op="ONE OF">' +
					list.map(function (v) { return '<value>' + escapeXml(v) + '</value>'; }).join('') +
					'</constraint>';
		return (
			'<query model="genomic" view="' + view.join(' ') + '"' +
			(sortOrder ? ' sortOrder="' + sortOrder + '"' : '') + '>' +
			constraint +
			'<constraint path="' + qualifierPath + '" op="NONE OF">' +
			excluded.map(function (v) { return '<value>' + escapeXml(v) + '</value>'; }).join('') +
			'</constraint>' +
			'</query>'
		);
	}

	function resultsUrl(serviceRootUrl) {
		return serviceRootUrl.replace(/\/+$/, '') + '/query/results';
	}

	function requestBody(query) {
		return 'format=json&size=' + MAX_ROWS + '&query=' + encodeURIComponent(query);
	}

	function toRow(r) {
		return {
			sourceId: r[0],
			source: r[1],
			symbol: r[2],
			identifier: r[3],
			species: r[4],
			termId: r[5],
			termName: r[6],
			qualifier: r[7],
			code: r[8]
		};
	}

	function cmp(a, b) {
		a = a == null ? '' : String(a);
		b = b == null ? '' : String(b);
		return a < b ? -1 : a > b ? 1 : 0;
	}

	function addUnique(list, v) {
		if (v != null && v !== '' && list.indexOf(v) === -1) list.push(v);
	}

	// Rows without a disease term (orthologs with no annotation) are dropped.
	// Returns [{id, name, species, orthologs, own}] sorted by species count
	// (descending), then term name. ownSet maps a term identifier to true when
	// the query gene itself has the term.
	function groupRows(rows, ownSet) {
		var terms = {};
		rows.forEach(function (row) {
			if (!row.termId && !row.termName) return;
			var key = row.termId || row.termName;
			var t = (terms[key] = terms[key] || {
				id: row.termId,
				name: row.termName || row.termId,
				species: [],
				byOrtholog: {},
				orthologs: []
			});
			var species = row.species || 'Unknown species';
			addUnique(t.species, species);
			var okey = (row.sourceId || '') + '|' + (row.identifier || row.symbol || '');
			var o = t.byOrtholog[okey];
			if (!o) {
				o = t.byOrtholog[okey] = {
					source: row.source,
					symbol: row.symbol,
					identifier: row.identifier,
					species: species,
					qualifiers: [],
					codes: []
				};
				t.orthologs.push(o);
			}
			addUnique(o.qualifiers, row.qualifier);
			addUnique(o.codes, row.code);
		});
		return Object.keys(terms)
			.map(function (k) {
				var t = terms[k];
				t.orthologs.sort(function (a, b) {
					return (
						cmp(a.species, b.species) ||
						cmp(a.symbol || a.identifier, b.symbol || b.identifier) ||
						cmp(a.identifier, b.identifier)
					);
				});
				t.species.sort(cmp);
				return {
					id: t.id,
					name: t.name,
					species: t.species,
					orthologs: t.orthologs,
					own: !!(t.id && ownSet && ownSet[t.id])
				};
			})
			.sort(function (a, b) {
				return b.species.length - a.species.length || cmp(a.name, b.name) || cmp(a.id, b.id);
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

	function message(el, text, cls) {
		clear(el);
		var wrap = node('div', null, 'alliance-ortholog-disease');
		wrap.appendChild(statusNode(text, cls));
		el.appendChild(wrap);
	}

	// One tbody per disease term; the term cell spans the term's ortholog rows.
	function termBody(t, multi) {
		var tbody = node('tbody', null, 'alliance-ortholog-disease-term');
		t.orthologs.forEach(function (o, i) {
			var tr = node('tr');
			if (i === 0) {
				var head = node('td');
				if (t.id && /^DOID:\d+$/.test(t.id)) {
					var a = node('a', t.name);
					a.href = DO_URL + t.id;
					a.className = 'agr-external';
					a.target = '_blank';
					a.rel = 'noopener noreferrer';
					head.appendChild(a);
				} else {
					head.appendChild(node('strong', t.name));
				}
				if (t.id) head.appendChild(node('small', ' ' + t.id, 'agr-note'));
				head.appendChild(document.createTextNode(' '));
				head.appendChild(node('span', t.species.length + ' species', 'agr-badge'));
				if (t.own) {
					head.appendChild(document.createTextNode(' '));
					head.appendChild(node('span', 'also annotated to this gene', 'agr-badge agr-badge-primary alliance-ortholog-disease-own'));
				}
				head.rowSpan = t.orthologs.length;
				tr.appendChild(head);
			}
			if (multi) tr.appendChild(node('td', o.source || ''));
			tr.appendChild(node('td', o.symbol || o.identifier || '?'));
			var sp = node('td');
			sp.appendChild(node('em', o.species));
			tr.appendChild(sp);
			tr.appendChild(node('td', o.qualifiers.join(', ').replace(/_/g, ' ')));
			tr.appendChild(node('td', o.codes.join(', ')));
			tbody.appendChild(tr);
		});
		return tbody;
	}

	function render(el, rows, ownSet, multi, truncated) {
		clear(el);
		var wrap = node('div', null, 'alliance-ortholog-disease');
		var terms = groupRows(rows, ownSet);
		if (!terms.length) {
			wrap.appendChild(statusNode(multi ? 'No disease annotations on orthologs for these genes' : 'No disease annotations on orthologs for this gene', 'agr-empty'));
			el.appendChild(wrap);
			return;
		}
		wrap.appendChild(node('p', terms.length + ' disease terms on orthologs.', 'alliance-ortholog-disease-summary'));
		if (truncated) wrap.appendChild(node('p', 'Showing the first ' + MAX_ROWS + ' annotation rows.', 'agr-note'));
		var table = node('table', null, 'agr-table agr-table-sm');
		var headRow = node('tr');
		['Disease'].concat(multi ? ['Query gene'] : [], ['Ortholog', 'Species', 'Association', 'Evidence']).forEach(function (h) {
			headRow.appendChild(colHeader(h));
		});
		var thead = node('thead');
		thead.appendChild(headRow);
		table.appendChild(thead);
		var extra = [];
		terms.forEach(function (t, i) {
			var body = termBody(t, multi);
			if (i >= COLLAPSE_AFTER) {
				body.style = body.style || {};
				body.style.display = 'none';
				extra.push(body);
			}
			table.appendChild(body);
		});
		var tableWrap = node('div', null, 'agr-table-wrap');
		tableWrap.appendChild(table);
		wrap.appendChild(tableWrap);
		if (extra.length) {
			var btn = node('button', 'Show all ' + terms.length + ' terms', 'agr-btn agr-btn-sm');
			btn.addEventListener('click', function () {
				extra.forEach(function (b) { b.style.display = ''; });
				if (btn.parentNode) btn.parentNode.removeChild(btn);
			});
			wrap.appendChild(btn);
		}
		wrap.appendChild(node('p', 'Disease annotations on orthologs as stored in this mine. Terms are ordered by the number of species annotated.', 'agr-note'));
		el.appendChild(wrap);
	}

	function post(serviceRootUrl, query) {
		return mineFetch(resultsUrl(serviceRootUrl), {
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

	function fetchRows(serviceRootUrl, ids) {
		var sort = ORTHOLOG + '.diseaseAnnotation.ontologyTerm.name asc';
		return post(serviceRootUrl, buildQuery(ids, VIEW, sort, ORTHOLOG_QUALIFIER, EXCLUDED_QUALIFIERS)).then(function (r) { return r.map(toRow); });
	}

	// Terms the query genes carry themselves. A failure only drops the badges.
	function fetchOwn(serviceRootUrl, ids) {
		return post(serviceRootUrl, buildQuery(ids, OWN_VIEW, null, OWN_QUALIFIER, OWN_EXCLUDED_QUALIFIERS))
			.then(function (rs) {
				var set = {};
				rs.forEach(function (r) { if (r[1]) set[r[1]] = true; });
				return set;
			})
			.catch(function (err) {
				console.error('Disease via orthologs: could not load the gene\'s own annotations', err);
				return {};
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
		var token = (el.__agrOrthDisReq = (el.__agrOrthDisReq || 0) + 1);
		var gene = imEntity.Gene;
		var ids = gene && gene.value;
		var list = (Array.isArray(ids) ? ids : [ids]).filter(function (v) {
			return v !== undefined && v !== null && v !== '';
		});
		if (!list.length) {
			message(el, 'No disease annotations on orthologs for this gene', 'agr-empty');
			return;
		}
		message(el, 'Loading', 'agr-loading');
		var mineService = serviceRoot(service.root);
		Promise.all([fetchRows(mineService, list), fetchOwn(mineService, list)])
			.then(function (res) {
				if (el.__agrOrthDisReq !== token) return;
				render(el, res[0], res[1], list.length > 1, res[0].length >= MAX_ROWS);
			})
			.catch(function (err) {
				console.error('Disease via orthologs: request failed', err);
				if (el.__agrOrthDisReq !== token) return;
				message(el, errorText(err, 'Could not load disease annotations from the mine'), 'agr-error');
			});
	}

	var api = {
		mineFetch: mineFetch,
		errorText: errorText,
		main: main,
		serviceRoot: serviceRoot,
		buildQuery: buildQuery,
		resultsUrl: resultsUrl,
		requestBody: requestBody,
		escapeXml: escapeXml,
		toRow: toRow,
		groupRows: groupRows,
		render: render
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceOrthologDisease = api;
})(typeof window !== 'undefined' ? window : globalThis);
