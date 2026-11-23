/*
 * Expression ribbon grid, a BlueGenes tool (tool API version 2).
 * Plain JavaScript without dependencies, so this file is both the source and
 * the bundle. BlueGenes loads it as a script and calls
 * bluegenesAllianceExpression.main(el, service, entity, state, config, navigate).
 * Styles are in style.css, declared in config.json under files.css.
 */
(function (root) {
	'use strict';

	// BlueGenes passes the mine root (for example https://host/mine); the web
	// services live under /service. Accept either form.
	function serviceRoot(root) {
		var r = String(root || '').replace(/\/+$/, '');
		return /\/service$/.test(r) ? r : r + '/service';
	}

	var MAX_ROWS = 5000;
	var TOP_ROWS = 30;
	var NO_ANATOMY = 'Unspecified anatomy';
	var NO_STAGE = 'Unspecified stage';
	var ANY_STAGE = 'Any stage';
	var PUBMED_URL = 'https://pubmed.ncbi.nlm.nih.gov/';
	var VIEW = [
		'Gene.primaryIdentifier',
		'Gene.expressionAnnotations.id',
		'Gene.expressionAnnotations.anatomy.name',
		'Gene.expressionAnnotations.anatomy.identifier',
		'Gene.expressionAnnotations.stageTerm',
		'Gene.expressionAnnotations.assay.name',
		'Gene.expressionAnnotations.source',
		'Gene.expressionAnnotations.publications.pubMedId'
	];

	function escapeXml(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	// ids is one internal Gene.id or an array of them.
	function buildQuery(ids) {
		var list = (Array.isArray(ids) ? ids : [ids]).map(String);
		var constraint =
			list.length === 1
				? '<constraint path="Gene.id" op="=" value="' + escapeXml(list[0]) + '"/>'
				: '<constraint path="Gene.id" op="ONE OF">' +
					list.map(function (v) { return '<value>' + escapeXml(v) + '</value>'; }).join('') +
					'</constraint>';
		return (
			'<query model="genomic" view="' + VIEW.join(' ') + '"' +
			' sortOrder="Gene.expressionAnnotations.anatomy.name asc">' +
			constraint +
			'</query>'
		);
	}

	function resultsUrl(serviceRoot) {
		return serviceRoot.replace(/\/+$/, '') + '/query/results';
	}

	// The id list goes in a POST body: a GET query string fails above about 250 ids.
	function requestBody(ids) {
		return 'format=json&size=' + MAX_ROWS + '&query=' + encodeURIComponent(buildQuery(ids));
	}

	function toRow(r) {
		return {
			gene: r[0],
			id: r[1],
			anatomy: r[2],
			anatomyId: r[3],
			stage: r[4],
			assay: r[5],
			source: r[6],
			pubMedId: r[7]
		};
	}

	// One annotation yields one row per publication; merge them by annotation id.
	function toAnnotations(rows) {
		var byId = {};
		var out = [];
		rows.forEach(function (row) {
			if (row.id == null) return;
			var a = byId[row.id];
			if (!a) {
				a = byId[row.id] = {
					id: row.id,
					gene: row.gene,
					anatomy: row.anatomy || NO_ANATOMY,
					anatomyId: row.anatomyId || '',
					stage: row.stage || NO_STAGE,
					assay: row.assay || '',
					source: row.source || '',
					pubs: []
				};
				out.push(a);
			}
			// The mine stores pubMedId as "PMID:123" or "123"; keep the number.
			var pmid = row.pubMedId == null ? '' : String(row.pubMedId).replace(/^PMID:\s*/i, '');
			if (pmid && a.pubs.indexOf(pmid) === -1) a.pubs.push(pmid);
		});
		return out;
	}

	function cmp(a, b) {
		a = a == null ? '' : String(a);
		b = b == null ? '' : String(b);
		return a < b ? -1 : a > b ? 1 : 0;
	}

	// Rows are anatomy terms by annotation count (ties by name); columns are stage
	// terms by count. counts[anatomy][stage] and counts[anatomy][ANY_STAGE] hold numbers.
	// max is the largest stage cell, anyMax the largest "any stage" cell.
	function buildGrid(annotations) {
		var counts = {};
		var stageTotals = {};
		var anatomyTotals = {};
		annotations.forEach(function (a) {
			var row = (counts[a.anatomy] = counts[a.anatomy] || {});
			row[a.stage] = (row[a.stage] || 0) + 1;
			row[ANY_STAGE] = (row[ANY_STAGE] || 0) + 1;
			stageTotals[a.stage] = (stageTotals[a.stage] || 0) + 1;
			anatomyTotals[a.anatomy] = (anatomyTotals[a.anatomy] || 0) + 1;
		});
		var anatomies = Object.keys(anatomyTotals).sort(function (a, b) {
			return anatomyTotals[b] - anatomyTotals[a] || cmp(a, b);
		});
		var stages = Object.keys(stageTotals).sort(function (a, b) {
			return stageTotals[b] - stageTotals[a] || cmp(a, b);
		});
		var max = 0;
		anatomies.forEach(function (an) {
			stages.forEach(function (st) {
				if ((counts[an][st] || 0) > max) max = counts[an][st];
			});
		});
		var anyMax = anatomies.length ? anatomyTotals[anatomies[0]] : 0;
		return { anatomies: anatomies, stages: stages, counts: counts, max: max, anyMax: anyMax, total: annotations.length };
	}

	// Shading level 0 to 4 from a count relative to the largest cell in its column group.
	function level(count, max) {
		if (!count || !max) return 0;
		return Math.min(4, Math.max(1, Math.ceil((4 * count) / max)));
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
		var wrap = node('div', null, 'alliance-expression');
		wrap.appendChild(statusNode(text, cls));
		el.appendChild(wrap);
	}

	function plural(n, word) {
		return n + ' ' + word + (n === 1 ? '' : 's');
	}

	function renderDetails(box, annotations, anatomy, stage, multi) {
		clear(box);
		var picked = annotations.filter(function (a) {
			return a.anatomy === anatomy && (stage === ANY_STAGE || a.stage === stage);
		});
		box.appendChild(node('h4', anatomy + ', ' + stage + ': ' + plural(picked.length, 'annotation')));
		var table = node('table', null, 'agr-table agr-table-sm');
		var headRow = node('tr');
		var heads = ['Anatomy', 'Stage', 'Assay', 'Source', 'Publication'];
		if (multi) heads.unshift('Gene');
		heads.forEach(function (h) { headRow.appendChild(colHeader(h)); });
		var thead = node('thead');
		thead.appendChild(headRow);
		table.appendChild(thead);
		var tbody = node('tbody');
		picked.forEach(function (a) {
			var tr = node('tr');
			if (multi) tr.appendChild(node('td', a.gene || ''));
			tr.appendChild(node('td', a.anatomy + (a.anatomyId ? ' (' + a.anatomyId + ')' : '')));
			tr.appendChild(node('td', a.stage));
			tr.appendChild(node('td', a.assay));
			tr.appendChild(node('td', a.source));
			var pubCell = node('td');
			a.pubs.forEach(function (p, i) {
				if (i) pubCell.appendChild(document.createTextNode(', '));
				var link = node('a', 'PMID ' + p);
				link.href = PUBMED_URL + encodeURIComponent(p) + '/';
				link.className = 'agr-external';
				link.target = '_blank';
				link.rel = 'noopener noreferrer';
				pubCell.appendChild(link);
			});
			tr.appendChild(pubCell);
			tbody.appendChild(tr);
		});
		table.appendChild(tbody);
		var tableWrap = node('div', null, 'agr-table-wrap');
		tableWrap.appendChild(table);
		box.appendChild(tableWrap);
	}

	function render(el, annotations, multi, truncated) {
		clear(el);
		var wrap = node('div', null, 'alliance-expression');
		if (!annotations.length) {
			wrap.appendChild(statusNode(multi ? 'No expression annotations for these genes' : 'No expression annotations for this gene', 'agr-empty'));
			el.appendChild(wrap);
			return;
		}
		var grid = buildGrid(annotations);
		var columns = [ANY_STAGE].concat(grid.stages);
		var showAll = false;
		var buttons = [];
		wrap.appendChild(
			node(
				'p',
				plural(grid.total, 'annotation') + ' in ' + plural(grid.anatomies.length, 'anatomy term') +
					' and ' + plural(grid.stages.length, 'stage term'),
				'alliance-expression-summary'
			)
		);
		if (truncated) wrap.appendChild(node('p', 'Showing annotations from the first ' + MAX_ROWS + ' result rows.', 'agr-note'));

		var gridBox = node('div', null, 'agr-table-wrap');
		var details = node('div', null, 'alliance-expression-details');

		function select(btn, anatomy, stage) {
			buttons.forEach(function (b) { b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'); });
			renderDetails(details, annotations, anatomy, stage, multi);
		}

		function drawCell(tr, an, st) {
			var n = grid.counts[an][st] || 0;
			var td = node('td', null, 'alliance-expression-l' + level(n, st === ANY_STAGE ? grid.anyMax : grid.max));
			if (n) {
				var btn = node('button', n, 'alliance-expression-cell');
				btn.type = 'button';
				btn.setAttribute('aria-label', an + ', ' + st + ': ' + plural(n, 'annotation'));
				btn.setAttribute('aria-pressed', 'false');
				btn.addEventListener('click', function () { select(btn, an, st); });
				buttons.push(btn);
				td.appendChild(btn);
			}
			tr.appendChild(td);
		}

		function drawGrid() {
			clear(gridBox);
			buttons = [];
			var table = node('table', null, 'alliance-expression-grid');
			var thead = node('thead');
			var headRow = node('tr');
			headRow.appendChild(colHeader('Anatomy'));
			columns.forEach(function (s) { headRow.appendChild(colHeader(s)); });
			thead.appendChild(headRow);
			table.appendChild(thead);
			var tbody = node('tbody');
			var shown = showAll ? grid.anatomies : grid.anatomies.slice(0, TOP_ROWS);
			shown.forEach(function (an) {
				var tr = node('tr');
				tr.appendChild(rowHeader(an));
				columns.forEach(function (st) { drawCell(tr, an, st); });
				tbody.appendChild(tr);
			});
			table.appendChild(tbody);
			gridBox.appendChild(table);
			if (grid.anatomies.length > TOP_ROWS) {
				var more = node(
					'button',
					showAll ? 'Show top ' + TOP_ROWS : 'Show all ' + grid.anatomies.length + ' anatomy terms',
					'agr-btn agr-btn-sm alliance-expression-more'
				);
				more.type = 'button';
				more.addEventListener('click', function () {
					showAll = !showAll;
					clear(details);
					drawGrid();
				});
				gridBox.appendChild(more);
			}
		}

		drawGrid();
		wrap.appendChild(gridBox);
		wrap.appendChild(details);
		wrap.appendChild(node('p', 'Expression annotations as stored in this mine. Cell colour scales with the annotation count; select a cell for details.', 'agr-note'));
		el.appendChild(wrap);
	}

	function fetchRows(serviceRoot, ids) {
		return mineFetch(resultsUrl(serviceRoot), {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: requestBody(ids)
		})
			.then(function (res) {
				if (!res.ok) throw httpError(res);
				return res.json();
			})
			.then(function (json) {
				return ((json && json.results) || []).map(toRow);
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

	function rowHeader(text) {
		var th = node('th', text);
		th.setAttribute('scope', 'row');
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

	function main(el, service, imEntity) {
		if (!el || !service || !imEntity) {
			throw new Error('Call main with correct signature');
		}
		// main runs again on every entity change; a response for an older entity must not overwrite the newer one.
		var token = (el.__agrExprReq = (el.__agrExprReq || 0) + 1);
		var gene = imEntity.Gene;
		var ids = gene && gene.value;
		var list = (Array.isArray(ids) ? ids : [ids]).filter(function (v) {
			return v !== undefined && v !== null && v !== '';
		});
		if (!list.length) {
			message(el, 'No expression annotations for this gene', 'agr-empty');
			return;
		}
		message(el, 'Loading expression', 'agr-loading');
		fetchRows(serviceRoot(service.root), list)
			.then(function (rows) {
				if (el.__agrExprReq !== token) return;
				render(el, toAnnotations(rows), list.length > 1, rows.length >= MAX_ROWS);
			})
			.catch(function (err) {
				console.error('bluegenes-alliance-expression: request failed', err);
				if (el.__agrExprReq !== token) return;
				message(el, errorText(err, 'Could not load expression annotations from the mine'), 'agr-error');
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
		toAnnotations: toAnnotations,
		buildGrid: buildGrid,
		level: level,
		render: render
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceExpression = api;
})(typeof window !== 'undefined' ? window : globalThis);
