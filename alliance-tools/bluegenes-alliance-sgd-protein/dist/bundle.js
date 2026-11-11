/*
 * SGD protein half-life and neighbourhood, a BlueGenes tool (tool API version 2).
 * Plain JavaScript without dependencies, so this file is both the source and
 * the bundle. BlueGenes loads it as a script and calls
 * bluegenesAllianceSgdProtein.main(el, service, entity, state, config, navigate).
 *
 * SGD sends no CORS headers, so the tool never calls yeastgenome.org. It
 * calls the BlueGenes backend, GET {base}/api/mod-proxy/sgd/locus/{sgdid}/{resource},
 * which forwards to a fixed SGD path. {base} is the BlueGenes deploy path:
 *   1. config.backendBase (config.json), when set;
 *   2. :bluegenes-deploy-path in window.serverVars, the EDN text BlueGenes
 *      writes into every page;
 *   3. "/bluegenes", the default deploy path of this fork.
 */
(function (root) {
	'use strict';

	var SGD_SITE = 'https://www.yeastgenome.org';
	var DEFAULT_DEPLOY_PATH = '/bluegenes';
	var TIMEOUT_MS = 20000;
	var GENE_VIEW = ['Gene.primaryIdentifier', 'Gene.organism.shortName'];
	var SVG_NS = 'http://www.w3.org/2000/svg';

	function serviceRoot(r) {
		var s = String(r || '').replace(/\/+$/, '');
		return /\/service$/.test(s) ? s : s + '/service';
	}

	// YeastMine stores S000001855, AllianceMine and others SGD:S000001855.
	function sgdIdOf(primaryIdentifier, organism) {
		if (typeof primaryIdentifier !== 'string') return null;
		var m = /^(?:SGD:)?(S\d{9})$/i.exec(primaryIdentifier.trim());
		if (!m) return null;
		var s = String(organism === undefined || organism === null ? '' : organism).trim().replace(/^NCBITaxon:/i, '');
		var yeast = s === '' || s === '4932' || s === '559292' || /^(S\.|Saccharomyces)\s*cerevisiae/i.test(s);
		return yeast ? m[1].toUpperCase() : null;
	}

	// The deploy path, e.g. "/bluegenes" or "" when BlueGenes is served from the root.
	function deployPathOf(vars) {
		if (typeof vars !== 'string') return null;
		var m = /:bluegenes-deploy-path\s+"((?:[^"\\]|\\.)*)"/.exec(vars);
		if (m) return m[1].replace(/\\(.)/g, '$1').replace(/\/+$/, '');
		return /^\s*\{/.test(vars) ? '' : null;
	}

	function backendBaseOf(config, vars) {
		if (config && typeof config.backendBase === 'string' && config.backendBase.trim()) {
			return config.backendBase.trim().replace(/\/+$/, '');
		}
		var fromVars = deployPathOf(vars === undefined ? root.serverVars : vars);
		return fromVars === null ? DEFAULT_DEPLOY_PATH : fromVars;
	}

	function proxyUrl(base, sgdid, resource) {
		return base + '/api/mod-proxy/sgd/locus/' + encodeURIComponent(sgdid) + '/' + resource;
	}

	function postRows(mineRoot, query) {
		return fetch(mineRoot.replace(/\/+$/, '') + '/query/results', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: 'format=json&query=' + encodeURIComponent(query)
		})
			.then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status);
				return res.json();
			})
			.then(function (json) { return (json && json.results) || []; });
	}

	function escapeXml(s) {
		return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	function buildQuery(geneId) {
		return '<query model="genomic" view="' + GENE_VIEW.join(' ') + '">' +
			'<constraint path="Gene.id" op="=" value="' + escapeXml(geneId) + '"/></query>';
	}

	function getJson(url) {
		var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
		var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);
		var opts = { headers: { Accept: 'application/json' } };
		if (ctrl) opts.signal = ctrl.signal;
		return fetch(url, opts).then(
			function (res) {
				if (!res.ok) {
					clearTimeout(timer);
					throw new Error('HTTP ' + res.status);
				}
				return res.json().then(
					function (j) { clearTimeout(timer); return j; },
					function (err) { clearTimeout(timer); throw err; }
				);
			},
			function (err) { clearTimeout(timer); throw err; }
		);
	}

	function node(tag, text, cls) {
		var n = document.createElement(tag);
		if (text !== undefined && text !== null) n.appendChild(document.createTextNode(String(text)));
		if (cls) n.className = cls;
		return n;
	}

	function clear(n) {
		while (n.firstChild) n.removeChild(n.firstChild);
	}

	function externalLink(text, href) {
		var a = node('a', text);
		a.href = href;
		a.target = '_blank';
		a.rel = 'noopener noreferrer';
		return a;
	}

	// SGD gives site-relative links such as /reference/S000178561 and /locus/S000001855.
	function sgdLink(link) {
		return typeof link === 'string' && /^\/(reference|locus)\/S\d{9}$/.test(link) ? SGD_SITE + link : null;
	}

	function toHalfLifeRows(json) {
		return (Array.isArray(json) ? json : []).map(function (r) {
			return {
				experiment: (r && r.experiment && r.experiment.display_name) || '',
				value: r && r.data_value !== undefined && r.data_value !== null ? String(r.data_value) : '',
				unit: (r && r.data_unit) || '',
				reference: (r && r.reference && r.reference.display_name) || '',
				referenceUrl: sgdLink(r && r.reference && r.reference.link)
			};
		});
	}

	// Genes of the S288C reference strain around the locus, sorted by start.
	function toNeighbors(json, sgdid) {
		var s = json && json.S288C;
		if (!s || !Array.isArray(s.neighbors)) return null;
		var genes = s.neighbors
			.filter(function (n) { return n && typeof n.start === 'number' && typeof n.end === 'number'; })
			.map(function (n) {
				var l = n.locus || {};
				return {
					name: l.display_name || l.format_name || '',
					systematic: l.format_name || '',
					link: sgdLink(l.link),
					start: Math.min(n.start, n.end),
					end: Math.max(n.start, n.end),
					strand: n.strand === '-' ? '-' : '+',
					current: typeof l.link === 'string' && l.link === '/locus/' + sgdid
				};
			})
			.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
		return { chromosome: chromosomeOf(s.neighbors), genes: genes };
	}

	function chromosomeOf(neighbors) {
		for (var i = 0; i < neighbors.length; i++) {
			var c = neighbors[i] && neighbors[i].contig;
			if (c && c.display_name) return c.display_name;
		}
		return '';
	}

	// Rows of non-overlapping genes (with a gap of pad bp), so labels do not collide.
	function assignLanes(genes, pad) {
		var ends = [];
		return genes.map(function (g) {
			var lane = 0;
			while (lane < ends.length && ends[lane] + pad > g.start) lane++;
			ends[lane] = g.end;
			return lane;
		});
	}

	function svgNode(tag, attrs) {
		var n = document.createElementNS(SVG_NS, tag);
		Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
		return n;
	}

	function svgText(text, attrs) {
		var t = svgNode('text', attrs);
		t.appendChild(document.createTextNode(text));
		return t;
	}

	var TRACK = { width: 720, left: 10, right: 10, laneH: 34, top: 22, boxH: 14 };

	function trackSvg(genes) {
		var min = Math.min.apply(null, genes.map(function (g) { return g.start; }));
		var max = Math.max.apply(null, genes.map(function (g) { return g.end; }));
		var span = Math.max(max - min, 1);
		var inner = TRACK.width - TRACK.left - TRACK.right;
		var x = function (bp) { return TRACK.left + ((bp - min) / span) * inner; };
		var lanes = assignLanes(genes, span * 0.08);
		var laneCount = Math.max.apply(null, lanes) + 1;
		var height = TRACK.top + laneCount * TRACK.laneH + 6;

		var svg = svgNode('svg', {
			width: String(TRACK.width), height: String(height),
			viewBox: '0 0 ' + TRACK.width + ' ' + height,
			role: 'img', 'aria-label': 'Genes around the locus on S288C'
		});
		svg.setAttribute('class', 'alliance-sgd-track');
		svg.appendChild(svgText(min + ' bp', { x: String(TRACK.left), y: '12', 'font-size': '10', fill: '#666' }));
		svg.appendChild(svgText(max + ' bp', { x: String(TRACK.width - TRACK.right), y: '12', 'font-size': '10', fill: '#666', 'text-anchor': 'end' }));
		genes.forEach(function (g, i) {
			var y = TRACK.top + lanes[i] * TRACK.laneH;
			var w = Math.max(x(g.end) - x(g.start), 2);
			var color = g.current ? '#d9534f' : '#5b8db8';
			var gEl = svgNode('g', { 'class': g.current ? 'alliance-sgd-gene alliance-sgd-current' : 'alliance-sgd-gene' });
			var title = svgNode('title');
			title.appendChild(document.createTextNode(g.name + ' ' + g.start + '-' + g.end + ' (' + g.strand + ')'));
			gEl.appendChild(title);
			gEl.appendChild(svgNode('rect', {
				x: x(g.start).toFixed(1), y: String(y), width: w.toFixed(1), height: String(TRACK.boxH),
				fill: color, stroke: g.current ? '#8a1f1c' : '#2f5f8a'
			}));
			gEl.appendChild(svgText((g.strand === '-' ? '← ' : '') + g.name + (g.strand === '+' ? ' →' : ''), {
				x: (x(g.start) + w / 2).toFixed(1), y: String(y + TRACK.boxH + 12),
				'font-size': '11', 'text-anchor': 'middle', 'font-weight': g.current ? 'bold' : 'normal'
			}));
			svg.appendChild(gEl);
		});
		return svg;
	}

	function table(headers, rows) {
		var t = node('table', null, 'table table-condensed table-striped');
		var thead = node('thead');
		var hr = node('tr');
		headers.forEach(function (h) { hr.appendChild(node('th', h)); });
		thead.appendChild(hr);
		t.appendChild(thead);
		var tbody = node('tbody');
		rows.forEach(function (cells) {
			var tr = node('tr');
			cells.forEach(function (c) {
				var td = node('td');
				if (c && typeof c === 'object') td.appendChild(c);
				else td.appendChild(document.createTextNode(c == null ? '' : String(c)));
				tr.appendChild(td);
			});
			tbody.appendChild(tr);
		});
		t.appendChild(tbody);
		return t;
	}

	function halfLifeSection(rows) {
		var sec = node('div', null, 'alliance-sgd-halflife');
		sec.appendChild(node('h4', 'Protein half-life'));
		if (!rows.length) {
			sec.appendChild(node('span', 'No protein half-life data in SGD for this gene.'));
			return sec;
		}
		sec.appendChild(table(['Experiment', 'Value', 'Unit', 'Reference'], rows.map(function (r) {
			return [r.experiment, r.value, r.unit, r.referenceUrl ? externalLink(r.reference, r.referenceUrl) : r.reference];
		})));
		return sec;
	}

	function neighbourhoodSection(nb) {
		var sec = node('div', null, 'alliance-sgd-neighbourhood');
		sec.appendChild(node('h4', 'Neighbourhood on S288C' + (nb && nb.chromosome ? ' (' + nb.chromosome + ')' : '')));
		if (!nb || !nb.genes.length) {
			sec.appendChild(node('span', 'No neighbouring genes in SGD for this gene.'));
			return sec;
		}
		sec.appendChild(trackSvg(nb.genes));
		sec.appendChild(table(['Gene', 'Systematic name', 'Start', 'End', 'Strand'], nb.genes.map(function (g) {
			return [g.link ? externalLink(g.name, g.link) : g.name, g.systematic, g.start, g.end, g.strand];
		})));
		return sec;
	}

	function main(el, service, imEntity, state, config, navigate) { // eslint-disable-line no-unused-vars
		if (!el || !service || !imEntity) {
			throw new Error('Call main with correct signature');
		}
		// main runs again on every entity change; a response for an older entity must not overwrite the newer one.
		var token = (el.__agrSgdReq = (el.__agrSgdReq || 0) + 1);
		var stale = function () { return el.__agrSgdReq !== token; };
		var gene = imEntity.Gene;
		var raw = gene && gene.value;
		var geneId = Array.isArray(raw) ? raw[0] : raw;
		clear(el);
		var wrap = node('div', null, 'alliance-sgd-protein');
		el.appendChild(wrap);
		if (geneId === undefined || geneId === null || geneId === '') {
			wrap.appendChild(node('span', 'No gene selected'));
			return;
		}
		wrap.appendChild(node('span', 'Loading...'));
		var base = backendBaseOf(config);

		postRows(serviceRoot(service.root), buildQuery(geneId))
			.then(function (rows) {
				if (stale()) return;
				var r = rows[0];
				clear(wrap);
				if (!r) {
					wrap.appendChild(node('span', 'Gene not found in this mine'));
					return;
				}
				var sgdid = sgdIdOf(r[0], r[1]);
				if (!sgdid) {
					wrap.appendChild(node('span', 'SGD data is for budding yeast genes.'));
					return;
				}
				show(wrap, base, sgdid, stale);
			})
			.catch(function (err) {
				if (stale()) return;
				console.error('sgd-protein: gene lookup failed', err);
				clear(wrap);
				wrap.appendChild(node('span', 'Could not load the gene from the mine'));
			});
	}

	function section(wrap, title, promise, build, stale) {
		var holder = node('div');
		holder.appendChild(node('h4', title));
		holder.appendChild(node('span', 'Loading...'));
		wrap.appendChild(holder);
		promise.then(
			function (json) {
				if (stale()) return;
				clear(holder);
				holder.appendChild(build(json));
			},
			function (err) {
				if (stale()) return;
				console.error('sgd-protein: ' + title + ' failed', err);
				clear(holder);
				holder.appendChild(node('h4', title));
				holder.appendChild(node('span', 'Could not load ' + title.toLowerCase() + ' from SGD'));
			}
		);
	}

	function show(wrap, base, sgdid, stale) {
		section(wrap, 'Protein half-life', getJson(proxyUrl(base, sgdid, 'protein_experiment_details')),
			function (json) { return halfLifeSection(toHalfLifeRows(json)); }, stale);
		section(wrap, 'Neighbourhood on S288C', getJson(proxyUrl(base, sgdid, 'neighbor_sequence_details')),
			function (json) { return neighbourhoodSection(toNeighbors(json, sgdid)); }, stale);
		var foot = node('p', 'Data from SGD (yeastgenome.org). ', 'alliance-sgd-source');
		foot.appendChild(externalLink('View ' + sgdid + ' at SGD', SGD_SITE + '/locus/' + sgdid));
		wrap.appendChild(foot);
	}

	var api = {
		main: main,
		serviceRoot: serviceRoot,
		sgdIdOf: sgdIdOf,
		deployPathOf: deployPathOf,
		backendBaseOf: backendBaseOf,
		proxyUrl: proxyUrl,
		buildQuery: buildQuery,
		toHalfLifeRows: toHalfLifeRows,
		toNeighbors: toNeighbors,
		assignLanes: assignLanes,
		trackSvg: trackSvg
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceSgdProtein = api;
})(typeof window !== 'undefined' ? window : globalThis);
