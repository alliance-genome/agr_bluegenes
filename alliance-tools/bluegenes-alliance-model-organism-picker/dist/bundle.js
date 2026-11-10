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

	function message(el, text) {
		clear(el);
		var wrap = node('div', null, 'alliance-model-organism-picker');
		wrap.appendChild(node('span', text));
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

	function formatScore(n) {
		return (Math.round(n * 100) / 100).toFixed(2);
	}

	function howRanked() {
		var details = node('details', null, 'alliance-model-organism-picker-formula');
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

	function render(el, orthologs, navigate, truncated) {
		clear(el);
		var wrap = node('div', null, 'alliance-model-organism-picker');
		if (!orthologs.length) {
			wrap.appendChild(node('span', 'No orthologs'));
			el.appendChild(wrap);
			return;
		}
		var ranked = rank(orthologs);
		var species = {};
		ranked.forEach(function (o) { species[o.species || 'Unknown species'] = true; });
		var top = ranked[0];
		wrap.appendChild(
			node(
				'p',
				ranked.length + ' orthologs in ' + Object.keys(species).length + ' species. Top: ' +
					(top.symbol || top.identifier) + ' (' + (top.species || 'Unknown species') + '), score ' +
					formatScore(top.score) + '.',
				'alliance-model-organism-picker-summary'
			)
		);
		if (truncated) {
			wrap.appendChild(node('p', 'A result set was cut at ' + MAX_ROWS + ' rows, so some counts are lower bounds.'));
		}
		wrap.appendChild(howRanked());

		var table = node('table', null, 'table table-condensed table-striped');
		var headRow = node('tr');
		['Species', 'Symbol', 'Confidence', 'Alleles', 'Phenotypes', 'Disease', 'Disease models', 'Expression', 'Score']
			.forEach(function (h) { headRow.appendChild(node('th', h)); });
		var thead = node('thead');
		thead.appendChild(headRow);
		table.appendChild(thead);

		var tbody = node('tbody');
		ranked.forEach(function (o) {
			var tr = node('tr');
			tr.appendChild(node('td', o.species || ''));
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
			RESOURCE_KEYS.forEach(function (k) { tr.appendChild(node('td', o[k] || 0)); });
			tr.appendChild(node('td', formatScore(o.score)));
			tbody.appendChild(tr);
		});
		table.appendChild(tbody);
		wrap.appendChild(table);
		el.appendChild(wrap);
	}

	function fetchRows(serviceRoot, view, ids) {
		return fetch(resultsUrl(serviceRoot), {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: requestBody(view, ids)
		})
			.then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status);
				return res.json();
			})
			.then(function (json) {
				return (json && json.results) || [];
			});
	}

	// Orthologs of one gene, then five count queries over all ortholog ids at once.
	function load(sRoot, geneId) {
		return fetchRows(sRoot, HOMOLOGUE_VIEW, geneId).then(function (rows) {
			var orthologs = toOrthologs(rows);
			if (!orthologs.length) return { orthologs: [], truncated: false };
			var ids = orthologs.map(function (o) { return o.id; });
			var truncated = rows.length >= MAX_ROWS;
			return Promise.all(
				RESOURCE_KEYS.map(function (k) {
					return fetchRows(sRoot, COUNT_QUERIES[k], ids).then(function (r) {
						if (r.length >= MAX_ROWS) truncated = true;
						return countByGene(r, k === 'diseases' ? function (row) { return isDirectQualifier(row[2]); } : null);
					});
				})
			).then(function (counts) {
				orthologs.forEach(function (o) {
					RESOURCE_KEYS.forEach(function (k, i) { o[k] = counts[i][String(o.id)] || 0; });
				});
				return { orthologs: orthologs, truncated: truncated };
			});
		});
	}

	function main(el, service, imEntity, state, config, navigate) {
		if (!el || !service || !imEntity) {
			throw new Error('Call main with correct signature');
		}
		// main runs again on every entity change; a response for an older entity must not overwrite the newer one.
		var token = (el.__agrPickerReq = (el.__agrPickerReq || 0) + 1);
		var gene = imEntity.Gene;
		var value = gene && gene.value;
		if (Array.isArray(value)) value = value[0];
		if (value === undefined || value === null || value === '') {
			message(el, 'No orthologs');
			return;
		}
		message(el, 'Loading...');
		load(serviceRoot(service.root), String(value))
			.then(function (result) {
				if (el.__agrPickerReq !== token) return;
				render(el, result.orthologs, navigate, result.truncated);
			})
			.catch(function (err) {
				console.error('Model organism picker failed', err);
				if (el.__agrPickerReq !== token) return;
				message(el, 'Could not load orthologs from the mine');
			});
	}

	var api = {
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
		render: render
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceModelOrganismPicker = api;
})(typeof window !== 'undefined' ? window : globalThis);
