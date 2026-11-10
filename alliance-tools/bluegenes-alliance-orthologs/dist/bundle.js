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

	function message(el, text) {
		clear(el);
		var wrap = node('div', null, 'alliance-orthologs');
		wrap.appendChild(node('span', text));
		el.appendChild(wrap);
	}

	function support(row) {
		if (row.match == null || row.attempted == null) return '';
		return row.match + '/' + row.attempted;
	}

	// view is the columns that were queried; the Algorithms and Best columns are shown only when queried.
	function render(el, rows, navigate, multi, truncated, view) {
		var cols = view || VIEW;
		var showAlgorithms = cols.indexOf('Gene.homologues.algorithmsMatch') !== -1 && cols.indexOf('Gene.homologues.algorithmsAttempted') !== -1;
		var showBest = cols.indexOf('Gene.homologues.isBestScore') !== -1 || cols.indexOf('Gene.homologues.isBestReverseScore') !== -1;
		clear(el);
		var wrap = node('div', null, 'alliance-orthologs');
		if (!rows.length) {
			wrap.appendChild(node('span', 'No orthologs in this mine'));
			el.appendChild(wrap);
			return;
		}
		var groups = groupRows(rows);
		var summary = groups
			.map(function (g) { return g.species + ' ' + g.rows.length; })
			.join(', ');
		wrap.appendChild(
			node('p', rows.length + ' orthologs in ' + groups.length + ' species: ' + summary, 'alliance-orthologs-summary')
		);
		if (truncated) wrap.appendChild(node('p', 'Showing the first ' + MAX_ROWS + ' orthologs.'));

		var table = node('table', null, 'table table-condensed table-striped');
		var headRow = node('tr');
		var heads = ['Species', 'Symbol', 'Identifier'];
		if (showAlgorithms) heads.push('Algorithms');
		if (showBest) heads.push('Best');
		if (multi) heads.unshift('Query gene');
		heads.forEach(function (h) { headRow.appendChild(node('th', h)); });
		var thead = node('thead');
		thead.appendChild(headRow);
		table.appendChild(thead);

		var tbody = node('tbody');
		groups.forEach(function (g) {
			g.rows.forEach(function (row, i) {
				var tr = node('tr');
				if (multi) tr.appendChild(node('td', row.source));
				tr.appendChild(node('td', i === 0 ? g.species : ''));
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
					var ext = node('a', '↗', 'alliance-orthologs-external');
					ext.href = alliance(curie);
					ext.target = '_blank';
					ext.rel = 'noopener';
					ext.title = 'View ' + curie + ' on the Alliance of Genome Resources';
					idCell.appendChild(ext);
				}
				tr.appendChild(idCell);

				if (showAlgorithms) tr.appendChild(node('td', support(row)));
				if (showBest) tr.appendChild(node('td', row.best ? 'best' : row.bestReverse ? 'best reverse' : ''));
				tbody.appendChild(tr);
			});
		});
		table.appendChild(tbody);
		wrap.appendChild(table);
		el.appendChild(wrap);
	}

	function fetchRows(serviceRoot, ids, view) {
		return fetch(resultsUrl(serviceRoot), {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: requestBody(ids, view)
		})
			.then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status);
				return res.json();
			})
			.then(function (json) {
				return ((json && json.results) || []).map(function (r) { return toRow(r, view); });
			});
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
			message(el, 'No orthologs in this mine');
			return;
		}
		message(el, 'Loading...');
		var view = viewFor(service);
		fetchRows(serviceRoot(service.root), list, view)
			.then(function (rows) {
				if (el.__agrOrthReq !== token) return;
				render(el, rows, navigate, list.length > 1, rows.length >= MAX_ROWS, view);
			})
			.catch(function () {
				if (el.__agrOrthReq !== token) return;
				message(el, 'Could not load orthologs from the mine');
			});
	}

	var api = {
		main: main, serviceRoot: serviceRoot,
		buildQuery: buildQuery,
		resultsUrl: resultsUrl,
		requestBody: requestBody,
		escapeXml: escapeXml,
		toRow: toRow,
		groupRows: groupRows,
		toCurie: toCurie,
		hasPath: hasPath,
		viewFor: viewFor,
		render: render
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceOrthologs = api;
})(typeof window !== 'undefined' ? window : globalThis);
