/*
 * Alliance gene page link, a BlueGenes tool (tool API version 2).
 * Plain JavaScript without dependencies, so this file is both the source and
 * the bundle. BlueGenes loads it as a script and calls
 * bluegenesAllianceGeneLink.main(el, service, entity, state, config, navigate).
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

	// Returns an Alliance CURIE for a primaryIdentifier, or null.
	function toCurie(primaryIdentifier, organismShortName) {
		if (typeof primaryIdentifier !== 'string') return null;
		var id = primaryIdentifier.trim();
		if (!id) return null;
		if (id.indexOf(':') !== -1) return id;
		if (/^FBgn\d+$/.test(id)) return 'FB:' + id;
		if (/^WBGene\d+$/.test(id)) return 'WB:' + id;
		if (/^S000\d+$/.test(id)) return 'SGD:' + id;
		if (/^ZDB-GENE-/.test(id)) return 'ZFIN:' + id;
		if (
			/^\d+$/.test(id) &&
			typeof organismShortName === 'string' &&
			/^(R\.|Rattus)\s*norvegicus/i.test(organismShortName.trim())
		) {
			return 'RGD:' + id;
		}
		return null;
	}

	function geneUrl(curie) {
		return ALLIANCE_GENE_URL + encodeURIComponent(curie).replace(/%3A/gi, ':');
	}

	function escapeXml(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function fetchGene(serviceRoot, internalId) {
		var query =
			'<query model="genomic" view="Gene.primaryIdentifier Gene.organism.shortName">' +
			'<constraint path="Gene.id" op="=" value="' +
			escapeXml(internalId) +
			'"/></query>';
		var url =
			serviceRoot.replace(/\/+$/, '') +
			'/query/results?format=json&size=1&query=' +
			encodeURIComponent(query);
		return fetch(url)
			.then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status);
				return res.json();
			})
			.then(function (json) {
				var row = json && json.results && json.results[0];
				return row ? { primaryIdentifier: row[0], organism: row[1] } : null;
			});
	}

	function show(el, text, curie) {
		while (el.firstChild) el.removeChild(el.firstChild);
		var wrap = document.createElement('div');
		wrap.className = 'alliance-gene-link';
		if (curie) {
			var a = document.createElement('a');
			a.href = geneUrl(curie);
			a.target = '_blank';
			a.rel = 'noopener';
			a.textContent = text;
			wrap.appendChild(a);
		} else {
			var span = document.createElement('span');
			span.textContent = text;
			wrap.appendChild(span);
		}
		el.appendChild(wrap);
	}

	function main(el, service, imEntity) {
		if (!el || !service || !imEntity) {
			throw new Error('Call main with correct signature');
		}
		// main runs again on every entity change; a response for an older gene must not overwrite the newer one.
		var token = (el.__agrReq = (el.__agrReq || 0) + 1);
		var gene = imEntity.Gene;
		var id = gene && gene.value;
		if (Array.isArray(id)) id = id[0];
		if (id === undefined || id === null || id === '') {
			show(el, 'No Alliance page for this gene');
			return;
		}
		show(el, 'Loading...');
		fetchGene(serviceRoot(service.root), id)
			.then(function (row) {
				if (el.__agrReq !== token) return;
				var curie = row && toCurie(row.primaryIdentifier, row.organism);
				if (curie) {
					show(el, 'View ' + row.primaryIdentifier + ' on the Alliance of Genome Resources', curie);
				} else {
					show(el, 'No Alliance page for this gene');
				}
			})
			.catch(function () {
				if (el.__agrReq !== token) return;
				show(el, 'Could not load the gene from the mine');
			});
	}

	var api = { main: main, serviceRoot: serviceRoot, toCurie: toCurie, geneUrl: geneUrl };
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceGeneLink = api;
})(typeof window !== 'undefined' ? window : globalThis);
