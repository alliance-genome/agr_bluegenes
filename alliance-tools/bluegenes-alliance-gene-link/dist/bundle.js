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
		return mineFetch(url)
			.then(function (res) {
				if (!res.ok) throw httpError(res);
				return res.json();
			})
			.then(function (json) {
				var row = json && json.results && json.results[0];
				return row ? { primaryIdentifier: row[0], organism: row[1] } : null;
			});
	}

	function show(el, text, curie, cls) {
		while (el.firstChild) el.removeChild(el.firstChild);
		var wrap = document.createElement('div');
		wrap.className = 'alliance-gene-link';
		if (curie) {
			var a = document.createElement('a');
			a.href = geneUrl(curie);
			a.className = 'agr-external';
			a.target = '_blank';
			a.rel = 'noopener noreferrer';
			a.textContent = text;
			wrap.appendChild(a);
		} else {
			var p = document.createElement('p');
			p.className = cls || '';
			p.textContent = text;
			p.setAttribute('role', cls === 'agr-error' ? 'alert' : 'status');
			wrap.appendChild(p);
		}
		el.appendChild(wrap);
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
		// main runs again on every entity change; a response for an older gene must not overwrite the newer one.
		var token = (el.__agrReq = (el.__agrReq || 0) + 1);
		var gene = imEntity.Gene;
		var id = gene && gene.value;
		if (Array.isArray(id)) id = id[0];
		if (id === undefined || id === null || id === '') {
			show(el, 'No Alliance page for this gene', null, 'agr-empty');
			return;
		}
		show(el, 'Loading', null, 'agr-loading');
		fetchGene(serviceRoot(service.root), id)
			.then(function (row) {
				if (el.__agrReq !== token) return;
				var curie = row && toCurie(row.primaryIdentifier, row.organism);
				if (curie) {
					show(el, 'View ' + row.primaryIdentifier + ' on the Alliance of Genome Resources', curie);
				} else {
					show(el, 'No Alliance page for this gene', null, 'agr-empty');
				}
			})
			.catch(function (err) {
				if (el.__agrReq !== token) return;
				show(el, errorText(err, 'Could not load the gene from the mine'), null, 'agr-error');
			});
	}

	var api = { main: main, mineFetch: mineFetch, errorText: errorText, serviceRoot: serviceRoot, toCurie: toCurie, geneUrl: geneUrl };
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceGeneLink = api;
})(typeof window !== 'undefined' ? window : globalThis);
