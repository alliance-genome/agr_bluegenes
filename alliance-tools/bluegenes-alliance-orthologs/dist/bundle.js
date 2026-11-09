/*
 * Orthologs across Alliance species, a BlueGenes tool (tool API version 2).
 * Plain JavaScript without dependencies, so this file is both the source and
 * the bundle. BlueGenes loads it as a script and calls
 * bluegenesAllianceOrthologs.main(el, service, entity, state, config, navigate).
 */
(function (root) {
	'use strict';

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
			' sortOrder="Gene.homologues.homologue.organism.shortName asc Gene.homologues.homologue.symbol asc">' +
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
			source: r[0],
			id: r[1],
			identifier: r[2],
			symbol: r[3],
			species: r[4],
			match: r[5],
			attempted: r[6],
			best: r[7] === true,
			bestReverse: r[8] === true
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

	// Alliance CURIE for a primaryIdentifier, or null (mirrors bluegenes-alliance-gene-link).
	function toCurie(id, species) {
		if (typeof id !== 'string') return null;
		id = id.trim();
		if (!id) return null;
		if (id.indexOf(':') !== -1) return id;
		if (/^FBgn\d+$/.test(id)) return 'FB:' + id;
		if (/^WBGene\d+$/.test(id)) return 'WB:' + id;
		if (/^S000\d+$/.test(id)) return 'SGD:' + id;
		if (/^ZDB-GENE-/.test(id)) return 'ZFIN:' + id;
		if (/^\d+$/.test(id) && typeof species === 'string' && /^(R\.|Rattus)\s*norvegicus/i.test(species.trim())) {
			return 'RGD:' + id;
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

	function render(el, rows, navigate, multi, truncated) {
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
		var heads = ['Species', 'Symbol', 'Identifier', 'Algorithms', 'Best'];
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

				tr.appendChild(node('td', support(row)));
				tr.appendChild(node('td', row.best ? 'best' : row.bestReverse ? 'best reverse' : ''));
				tbody.appendChild(tr);
			});
		});
		table.appendChild(tbody);
		wrap.appendChild(table);
		el.appendChild(wrap);
	}

	function fetchRows(serviceRoot, ids) {
		return fetch(resultsUrl(serviceRoot), {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: requestBody(ids)
		})
			.then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status);
				return res.json();
			})
			.then(function (json) {
				return ((json && json.results) || []).map(toRow);
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
		fetchRows(service.root, list)
			.then(function (rows) {
				if (el.__agrOrthReq !== token) return;
				render(el, rows, navigate, list.length > 1, rows.length >= MAX_ROWS);
			})
			.catch(function () {
				if (el.__agrOrthReq !== token) return;
				message(el, 'Could not load orthologs from the mine');
			});
	}

	var api = {
		main: main,
		buildQuery: buildQuery,
		resultsUrl: resultsUrl,
		requestBody: requestBody,
		escapeXml: escapeXml,
		toRow: toRow,
		groupRows: groupRows,
		toCurie: toCurie,
		render: render
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceOrthologs = api;
})(typeof window !== 'undefined' ? window : globalThis);
