/*
 * Orthologs across Alliance species, a BlueGenes tool (tool API version 2).
 * Plain JavaScript without dependencies, so this file is both the source and
 * the bundle. BlueGenes loads it as a script and calls
 * bluegenesAllianceOrthologs.main(el, service, entity, state, config, navigate).
 */
(function (root) {
	'use strict';

	// BlueGenes passes the mine root (for example https://host/mine); the web
	// services live under /service. Accept either form.
	function serviceRoot(root) {
		var r = String(root || '').replace(/\/+$/, '');
		return /\/service$/.test(r) ? r : r + '/service';
	}

	var ALLIANCE_GENE_URL = 'https://www.alliancegenome.org/gene/';
	var MAX_ROWS = 2000;
	var ID_CHUNK = 200;
	var VIEW = [
		'Gene.primaryIdentifier',
		'Gene.homologues.homologue.id',
		'Gene.homologues.homologue.primaryIdentifier',
		'Gene.homologues.homologue.symbol',
		'Gene.homologues.homologue.organism.shortName',
		'Gene.homologues.algorithmsMatch',
		'Gene.homologues.algorithmsAttempted',
		'Gene.homologues.isBestScore',
		'Gene.homologues.isBestReverseScore'
	];
	// The first five columns of VIEW are required (config.json depends). The rest
	// come from the prediction methods, which WormMine's Homologue lacks, so each
	// is left out of the query when the mine's model does not have it.
	var REQUIRED_COLUMNS = 5;

	function viewFor(service) {
		return VIEW.filter(function (path, i) {
			return i < REQUIRED_COLUMNS || hasPath(service, path);
		});
	}

	// BlueGenes passes the mine's model as service.model.classes. Resolves a dotted
	// path in it, following references and collections and taking fields from the
	// class and its superclasses. True when no model is passed.
	function fieldOf(classes, cls, name, seen) {
		var c = classes[cls];
		if (!c || seen[cls]) return null;
		seen[cls] = true;
		var f = (c.attributes && c.attributes[name]) || (c.references && c.references[name]) || (c.collections && c.collections[name]);
		if (f) return f;
		var ext = c.extends || [];
		for (var i = 0; i < ext.length; i++) {
			var r = fieldOf(classes, ext[i], name, seen);
			if (r) return r;
		}
		return null;
	}

	function hasPath(service, path) {
		var classes = service && service.model && service.model.classes;
		if (!classes) return true;
		var parts = String(path).split('.');
		var cls = parts[0];
		if (!classes[cls]) return false;
		for (var i = 1; i < parts.length; i++) {
			var f = fieldOf(classes, cls, parts[i], {});
			if (!f) return false;
			if (i < parts.length - 1) {
				if (!f.referencedType) return false;
				cls = f.referencedType;
			}
		}
		return true;
	}

	function escapeXml(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	// ids is one internal Gene.id or an array of them.
	function buildQuery(ids, view) {
		var list = (Array.isArray(ids) ? ids : [ids]).map(String);
		var constraint =
			list.length === 1
				? '<constraint path="Gene.id" op="=" value="' + escapeXml(list[0]) + '"/>'
				: '<constraint path="Gene.id" op="ONE OF">' +
					list.map(function (v) { return '<value>' + escapeXml(v) + '</value>'; }).join('') +
					'</constraint>';
		return (
			'<query model="genomic" view="' + (view || VIEW).join(' ') + '"' +
			' sortOrder="Gene.homologues.homologue.organism.shortName asc Gene.homologues.homologue.symbol asc">' +
			constraint +
			'</query>'
		);
	}

	function resultsUrl(serviceRoot) {
		return serviceRoot.replace(/\/+$/, '') + '/query/results';
	}

	// The id list goes in a POST body: a GET query string fails above about 250 ids.
	function requestBody(ids, view) {
		return 'format=json&size=' + MAX_ROWS + '&query=' + encodeURIComponent(buildQuery(ids, view));
	}

	// A row is read by column name, so a view without the prediction columns still maps.
	function toRow(r, view) {
		var at = {};
		(Array.isArray(view) ? view : VIEW).forEach(function (path, i) { at[path] = r[i]; });
		return {
			source: at['Gene.primaryIdentifier'],
			id: at['Gene.homologues.homologue.id'],
			identifier: at['Gene.homologues.homologue.primaryIdentifier'],
			symbol: at['Gene.homologues.homologue.symbol'],
			species: at['Gene.homologues.homologue.organism.shortName'],
			match: at['Gene.homologues.algorithmsMatch'],
			attempted: at['Gene.homologues.algorithmsAttempted'],
			best: at['Gene.homologues.isBestScore'] === true,
			bestReverse: at['Gene.homologues.isBestReverseScore'] === true
		};
	}

	// AllianceMine can hold several Homologue rows for one gene pair. Keeps one row
	// per query gene and homologue gene: the highest algorithm counts, and a best
	// flag when any row has it. Order of first appearance is kept.
	function dedupeRows(rows) {
		var seen = {};
		var out = [];
		rows.forEach(function (row) {
			var key = row.source + '|' + (row.id != null ? row.id : row.identifier);
			var kept = seen[key];
			if (!kept) {
				seen[key] = row;
				out.push(row);
				return;
			}
			if (row.match != null && (kept.match == null || row.match > kept.match)) kept.match = row.match;
			if (row.attempted != null && (kept.attempted == null || row.attempted > kept.attempted)) kept.attempted = row.attempted;
			kept.best = kept.best || row.best;
			kept.bestReverse = kept.bestReverse || row.bestReverse;
		});
		return out;
	}

	function cmp(a, b) {
		a = a == null ? '' : String(a);
		b = b == null ? '' : String(b);
		return a < b ? -1 : a > b ? 1 : 0;
	}

	// Returns [{species, rows}] sorted by species; rows sorted by symbol, then identifier.
	function groupRows(rows) {
		var by = {};
		rows.forEach(function (row) {
			var key = row.species || 'Unknown species';
			(by[key] = by[key] || []).push(row);
		});
		return Object.keys(by)
			.sort(cmp)
			.map(function (species) {
				return {
					species: species,
					rows: by[species].slice().sort(function (a, b) {
						return (
							cmp(a.symbol || a.identifier, b.symbol || b.identifier) ||
							cmp(a.identifier, b.identifier) ||
							cmp(a.source, b.source)
						);
					})
				};
			});
	}

	// Alliance CURIE prefixes. AllianceMine stores these in primaryIdentifier, and
	// WormMine and FlyMine keep them for genes of other species (HGNC:, MGI:, RGD:, ZFIN:, FB:).
	var CURIE_PREFIX = /^(HGNC|MGI|RGD|ZFIN|FB|WB|SGD|Xenbase):\S+$/;

	// WormMine, FlyMine and YeastMine store bare identifiers for their own species,
	// so a bare id maps to a CURIE only when the organism is that species. Other
	// bare ids are not Alliance ids: WormMine and FlyMine hold numeric NCBI ids for
	// zebrafish and other Drosophila species, and YeastMine holds locus tags for
	// other fungi. A numeric id is never mapped.
	var BARE_ID = [
		{ re: /^FBgn\d+$/, prefix: 'FB:', species: /^(D\.|Drosophila)\s*melanogaster/i },
		{ re: /^WBGene\d+$/, prefix: 'WB:', species: /^(C\.|Caenorhabditis)\s*elegans/i },
		{ re: /^S000\d+$/, prefix: 'SGD:', species: /^(S\.|Saccharomyces)\s*cerevisiae/i },
		{ re: /^ZDB-GENE-/, prefix: 'ZFIN:', species: /^(D\.|Danio)\s*rerio/i }
	];

	// Returns an Alliance CURIE for a primaryIdentifier, or null. Without an
	// organism name the identifier shape alone decides.
	function toCurie(primaryIdentifier, organismShortName) {
		if (typeof primaryIdentifier !== 'string') return null;
		var id = primaryIdentifier.trim();
		if (!id) return null;
		if (id.indexOf(':') !== -1) return CURIE_PREFIX.test(id) ? id : null;
		var known = typeof organismShortName === 'string';
		for (var i = 0; i < BARE_ID.length; i++) {
			var b = BARE_ID[i];
			if (b.re.test(id)) return !known || b.species.test(organismShortName.trim()) ? b.prefix + id : null;
		}
		return null;
	}

	function alliance(curie) {
		return ALLIANCE_GENE_URL + encodeURIComponent(curie).replace(/%3A/gi, ':');
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
		var wrap = node('div', null, 'alliance-orthologs');
		wrap.appendChild(statusNode(text, cls));
		el.appendChild(wrap);
	}

	function support(row) {
		if (row.match == null || row.attempted == null) return '';
		return row.match + '/' + row.attempted;
	}

	var CSV_HEADER = ['Query gene', 'Species', 'Symbol', 'Identifier', 'Algorithms matched', 'Algorithms attempted', 'Best', 'Best reverse'];

	function csvRow(r) {
		return [r.source, r.species || '', r.symbol || '', r.identifier || '', r.match == null ? '' : r.match, r.attempted == null ? '' : r.attempted, r.best ? 'yes' : 'no', r.bestReverse ? 'yes' : 'no'];
	}

	// view is the columns that were queried; the Algorithms and Best columns are shown only when queried.
	function render(el, rows, navigate, multi, truncated, view) {
		var cols = view || VIEW;
		var showAlgorithms = cols.indexOf('Gene.homologues.algorithmsMatch') !== -1 && cols.indexOf('Gene.homologues.algorithmsAttempted') !== -1;
		var showBest = cols.indexOf('Gene.homologues.isBestScore') !== -1 || cols.indexOf('Gene.homologues.isBestReverseScore') !== -1;
		clear(el);
		var wrap = node('div', null, 'alliance-orthologs');
		if (!rows.length) {
			wrap.appendChild(statusNode(multi ? 'No orthologs for these genes' : 'No orthologs for this gene', 'agr-empty'));
			el.appendChild(wrap);
			return;
		}
		var groups = groupRows(rows);
		var summary = groups
			.map(function (g) { return g.species + ' ' + g.rows.length; })
			.join(', ');
		wrap.appendChild(
			node('p', count(rows.length, 'ortholog') + ' in ' + count(groups.length, 'species', 'species') + ': ' + summary, 'alliance-orthologs-summary')
		);
		if (truncated) wrap.appendChild(node('p', 'The mine returned ' + MAX_ROWS + ' rows, the limit for one request, so the list is incomplete.', 'agr-note'));

		var toolbar = node('div', null, 'agr-filter-bar');
		toolbar.appendChild(csvButton('orthologs.csv', CSV_HEADER, groups.reduce(function (acc, g) { return acc.concat(g.rows.map(csvRow)); }, [])));
		wrap.appendChild(toolbar);
		var tableWrap = node('div', null, 'agr-table-wrap');
		var table = node('table', null, 'agr-table agr-table-sm');
		var headRow = node('tr');
		var heads = ['Species', 'Symbol', 'Identifier'];
		if (showAlgorithms) heads.push('Algorithms');
		if (showBest) heads.push('Best');
		if (multi) heads.unshift('Query gene');
		heads.forEach(function (h) { headRow.appendChild(colHeader(h)); });
		var thead = node('thead');
		thead.appendChild(headRow);
		table.appendChild(thead);

		var tbody = node('tbody');
		groups.forEach(function (g) {
			g.rows.forEach(function (row, i) {
				var tr = node('tr');
				if (multi) tr.appendChild(node('td', row.source));
				var speciesCell = node('td');
				if (i === 0) speciesCell.appendChild(node('em', g.species));
				tr.appendChild(speciesCell);
				tr.appendChild(node('td', row.symbol || ''));

				var idCell = node('td');
				var a = node('a', row.identifier);
				a.href = '#';
				a.addEventListener('click', function (ev) {
					if (ev && ev.preventDefault) ev.preventDefault();
					if (typeof navigate === 'function') navigate('report', { type: 'Gene', id: row.id });
				});
				idCell.appendChild(a);
				var curie = toCurie(row.identifier, row.species);
				if (curie) {
					idCell.appendChild(document.createTextNode(' '));
					var ext = node('a', 'Alliance', 'agr-external');
					ext.href = alliance(curie);
					ext.target = '_blank';
					ext.rel = 'noopener noreferrer';
					ext.title = 'View ' + curie + ' on the Alliance of Genome Resources';
					idCell.appendChild(ext);
				}
				tr.appendChild(idCell);

				if (showAlgorithms) tr.appendChild(node('td', support(row), 'num'));
				if (showBest) {
					var bestCell = node('td');
					var bestLabel = row.best ? 'best' : row.bestReverse ? 'best reverse' : '';
					if (bestLabel) bestCell.appendChild(node('span', bestLabel, 'agr-badge'));
					tr.appendChild(bestCell);
				}
				tbody.appendChild(tr);
			});
		});
		table.appendChild(tbody);
		tableWrap.appendChild(table);
		wrap.appendChild(tableWrap);
		wrap.appendChild(node('p', 'Orthologs as stored in this mine. Algorithms shows how many of the orthology methods support the pair.', 'agr-note'));
		el.appendChild(wrap);
	}

	// One request per chunk of ids, run in sequence so the mine is not hit in parallel.
	// truncated is true when any chunk came back at the row limit, judged on the raw rows before de-duplication.
	function fetchRows(serviceRoot, ids, view) {
		var parts = [];
		for (var i = 0; i < ids.length; i += ID_CHUNK) parts.push(ids.slice(i, i + ID_CHUNK));
		var raw = [];
		var truncated = false;
		return parts
			.reduce(function (chain, part) {
				return chain.then(function () {
					return mineFetch(resultsUrl(serviceRoot), {
						method: 'POST',
						headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
						body: requestBody(part, view)
					})
						.then(function (res) {
							if (!res.ok) throw httpError(res);
							return res.json();
						})
						.then(function (json) {
							var results = (json && json.results) || [];
							if (results.length >= MAX_ROWS) truncated = true;
							results.forEach(function (r) { raw.push(toRow(r, view)); });
						});
				});
			}, Promise.resolve())
			.then(function () {
				return { rows: dedupeRows(raw), truncated: truncated };
			});
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
		var token = (el.__agrOrthReq = (el.__agrOrthReq || 0) + 1);
		var gene = imEntity.Gene;
		var ids = gene && gene.value;
		var list = (Array.isArray(ids) ? ids : [ids]).filter(function (v) {
			return v !== undefined && v !== null && v !== '';
		});
		if (!list.length) {
			message(el, 'No orthologs for this gene', 'agr-empty');
			return;
		}
		message(el, 'Loading orthologs', 'agr-loading');
		var view = viewFor(service);
		fetchRows(serviceRoot(service.root), list, view)
			.then(function (result) {
				if (el.__agrOrthReq !== token) return;
				render(el, result.rows, navigate, list.length > 1, result.truncated, view);
			})
			.catch(function (err) {
				if (el.__agrOrthReq !== token) return;
				message(el, errorText(err, 'Could not load orthologs from the mine'), 'agr-error');
			});
	}

	var api = {
		mineFetch: mineFetch,
		count: count,
		toCsv: toCsv,
		csvRow: csvRow,
		CSV_HEADER: CSV_HEADER,
		errorText: errorText,
		main: main, serviceRoot: serviceRoot,
		buildQuery: buildQuery,
		resultsUrl: resultsUrl,
		requestBody: requestBody,
		escapeXml: escapeXml,
		toRow: toRow,
		groupRows: groupRows,
		dedupeRows: dedupeRows,
		toCurie: toCurie,
		hasPath: hasPath,
		viewFor: viewFor,
		render: render
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceOrthologs = api;
})(typeof window !== 'undefined' ? window : globalThis);
