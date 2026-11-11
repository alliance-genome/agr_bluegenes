/*
 * RGD rat gene, a BlueGenes tool (tool API version 2).
 * Plain JavaScript without dependencies, so this file is both the source and
 * the bundle. BlueGenes loads it as a script and calls
 * bluegenesAllianceRgd.main(el, service, entity, state, config, navigate).
 *
 * Reads the gene's identifier and organism from the mine. For rat genes it
 * fetches the gene record, its annotations and its orthologs from the Rat
 * Genome Database (RGD) REST API.
 */
(function (root) {
	'use strict';

	// BlueGenes passes the mine root (for example https://host/mine); the web
	// services live under /service. Accept either form.
	function serviceRoot(root) {
		var r = String(root || '').replace(/\/+$/, '');
		return /\/service$/.test(r) ? r : r + '/service';
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

	var DEFAULT_API_BASE = 'https://rest.rgd.mcw.edu/rgdws';
	var RGD_GENE_URL = 'https://rgd.mcw.edu/rgdweb/report/gene/main.html?id=';
	var RGD_REFERENCE_URL = 'https://rgd.mcw.edu/rgdweb/report/reference/main.html?id=';
	var PAGE_SIZE = 50;
	var TIMEOUT_MS = 20000;
	var RAT_TAXON = '10116';
	var NOT_RAT = 'RGD data is for rat genes.';

	// Aspect codes seen in /annotations/rgdId responses for RGD:2218 and RGD:2219.
	// Codes not listed here are shown as they come.
	var ASPECTS = [
		{ code: 'D', label: 'Disease' },
		{ code: 'E', label: 'Chemical and drug interactions (CTD)' },
		{ code: 'W', label: 'Pathway' },
		{ code: 'N', label: 'Phenotype' },
		{ code: 'P', label: 'GO biological process' },
		{ code: 'F', label: 'GO molecular function' },
		{ code: 'C', label: 'GO cellular component' }
	];

	// RGD speciesTypeKey values confirmed against ortholog symbols (BRCA1 upper case = human).
	var SPECIES = { 1: 'Human', 2: 'Mouse', 3: 'Rat' };

	function apiBaseOf(config) {
		var b = config && typeof config.apiBase === 'string' && config.apiBase.trim() ? config.apiBase.trim() : DEFAULT_API_BASE;
		return b.replace(/\/+$/, '');
	}

	function escapeXml(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function buildQuery(view, path, value) {
		return '<query model="genomic" view="' + view.join(' ') + '"><constraint path="' + path + '" op="=" value="' + escapeXml(value) + '"/></query>';
	}

	function resultsUrl(root) {
		return root.replace(/\/+$/, '') + '/query/results';
	}

	function requestBody(query) {
		return 'format=json&query=' + encodeURIComponent(query);
	}

	function postRows(root, query) {
		return fetch(resultsUrl(root), {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: requestBody(query)
		})
			.then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status);
				return res.json();
			})
			.then(function (json) {
				return (json && json.results) || [];
			});
	}

	// GET with a 20 s timeout.
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
			function (err) {
				clearTimeout(timer);
				throw err;
			}
		);
	}

	function isRat(organism, taxonId) {
		if (taxonId !== undefined && taxonId !== null && String(taxonId).trim() === RAT_TAXON) return true;
		return typeof organism === 'string' && /^(R\.|Rattus)\s*norvegicus/i.test(organism.trim());
	}

	// RGD numeric id from a mine identifier: RGD:2218, or bare 2218 (only called for a rat gene). Else null.
	function rgdIdOf(primaryIdentifier) {
		if (primaryIdentifier === undefined || primaryIdentifier === null) return null;
		var m = /^(?:RGD:)?(\d+)$/i.exec(String(primaryIdentifier).trim());
		return m ? m[1] : null;
	}

	function geneUrl(base, id) {
		return base + '/genes/' + encodeURIComponent(id);
	}

	function orthologsUrl(base, id) {
		return base + '/genes/orthologs/' + encodeURIComponent(id);
	}

	function annotationsUrl(base, id) {
		return base + '/annotations/rgdId/' + encodeURIComponent(id);
	}

	function rgdGeneLink(id) {
		return RGD_GENE_URL + encodeURIComponent(id);
	}

	function aspectLabel(code) {
		for (var i = 0; i < ASPECTS.length; i++) if (ASPECTS[i].code === code) return ASPECTS[i].label;
		return String(code);
	}

	// Groups annotations by aspect, known aspects first in ASPECTS order, then unknown codes by name.
	function groupAnnotations(list) {
		var by = {};
		(Array.isArray(list) ? list : []).forEach(function (a) {
			if (!a) return;
			var code = a.aspect == null || a.aspect === '' ? '?' : String(a.aspect);
			(by[code] = by[code] || []).push(a);
		});
		var known = ASPECTS.map(function (a) { return a.code; });
		var unknown = Object.keys(by).filter(function (c) { return known.indexOf(c) === -1; }).sort();
		return known.concat(unknown)
			.filter(function (c) { return by[c]; })
			.map(function (c) { return { code: c, label: aspectLabel(c), rows: by[c] }; });
	}

	function speciesName(key) {
		return SPECIES[key] || 'species key ' + key;
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

	function externalLink(label, href, title) {
		var a = node('a', label);
		a.href = href;
		a.target = '_blank';
		a.rel = 'noopener';
		if (title) a.title = title;
		return a;
	}

	function geneCard(gene, id) {
		var card = node('div', null, 'alliance-rgd-gene');
		var head = node('h4');
		head.appendChild(externalLink(gene.symbol || 'RGD:' + id, rgdGeneLink(id), 'View RGD:' + id + ' at RGD'));
		card.appendChild(head);
		[['Name', gene.name], ['Type', gene.type], ['RefSeq status', gene.refSeqStatus], ['Description', gene.description]].forEach(function (f) {
			if (f[1] === undefined || f[1] === null || f[1] === '') return;
			var p = node('p');
			p.appendChild(node('strong', f[0] + ': '));
			p.appendChild(document.createTextNode(String(f[1])));
			card.appendChild(p);
		});
		return card;
	}

	function annotationTable(rows) {
		var t = node('table', null, 'table table-condensed table-striped');
		var headRow = node('tr');
		['Term', 'Evidence', 'Source', 'Reference'].forEach(function (h) { headRow.appendChild(node('th', h)); });
		var thead = node('thead');
		thead.appendChild(headRow);
		t.appendChild(thead);
		var tbody = node('tbody');
		rows.forEach(function (a) {
			var tr = node('tr');
			var ref = a.refRgdId == null || a.refRgdId === '' ? '' : externalLink('RGD:' + a.refRgdId, RGD_REFERENCE_URL + encodeURIComponent(a.refRgdId), 'Reference RGD:' + a.refRgdId);
			[a.term, a.evidence, a.dataSrc, ref].forEach(function (c) {
				var td = node('td');
				if (c && typeof c === 'object') td.appendChild(c);
				else td.textContent = c == null ? '' : String(c);
				tr.appendChild(td);
			});
			tbody.appendChild(tr);
		});
		t.appendChild(tbody);
		return t;
	}

	function orthologList(list) {
		var d = node('details', null, 'alliance-rgd-orthologs');
		d.appendChild(node('summary', 'Orthologs (' + list.length + ')'));
		var ul = node('ul');
		list.forEach(function (o) {
			var li = node('li');
			li.appendChild(externalLink(o.symbol || 'RGD:' + o.rgdId, rgdGeneLink(o.rgdId), 'RGD:' + o.rgdId));
			li.appendChild(document.createTextNode(' ' + speciesName(o.speciesTypeKey) + (o.name ? ', ' + o.name : '')));
			ul.appendChild(li);
		});
		d.appendChild(ul);
		return d;
	}

	// Annotation tabs with per-aspect counts and 50-row paging.
	function annotationView(groups) {
		var box = node('div', null, 'alliance-rgd-annotations');
		var bar = node('div', null, 'alliance-rgd-tabs');
		bar.setAttribute('role', 'tablist');
		var panel = node('div', null, 'alliance-rgd-panel');
		box.appendChild(bar);
		box.appendChild(panel);
		var shown = {};
		var buttons = {};

		function show(code) {
			var g = groups.filter(function (x) { return x.code === code; })[0];
			groups.forEach(function (x) { buttons[x.code].setAttribute('aria-selected', x.code === code ? 'true' : 'false'); });
			clear(panel);
			var n = Math.min(shown[code] || PAGE_SIZE, g.rows.length);
			panel.appendChild(node('p', 'Showing ' + n + ' of ' + g.rows.length, 'alliance-rgd-summary'));
			panel.appendChild(annotationTable(g.rows.slice(0, n)));
			if (n < g.rows.length) {
				var more = node('button', 'Show ' + Math.min(PAGE_SIZE, g.rows.length - n) + ' more', 'btn btn-default');
				more.type = 'button';
				more.addEventListener('click', function () {
					shown[code] = n + PAGE_SIZE;
					show(code);
				});
				panel.appendChild(more);
			}
		}

		groups.forEach(function (g) {
			var b = node('button', g.label + ' (' + g.rows.length + ')', 'btn btn-default');
			b.type = 'button';
			b.setAttribute('role', 'tab');
			b.setAttribute('aria-selected', 'false');
			b.addEventListener('click', function () { show(g.code); });
			buttons[g.code] = b;
			bar.appendChild(b);
		});
		show(groups[0].code);
		return box;
	}

	function main(el, service, imEntity, state, config, navigate) {
		if (!el || !service || !imEntity) {
			throw new Error('Call main with correct signature');
		}
		// main runs again on every entity change; a response for an older entity must not overwrite the newer one.
		var token = (el.__agrRgdReq = (el.__agrRgdReq || 0) + 1);
		var stale = function () { return el.__agrRgdReq !== token; };
		var gene = imEntity.Gene;
		var raw = gene && gene.value;
		var geneId = Array.isArray(raw) ? raw[0] : raw;
		clear(el);
		var wrap = node('div', null, 'alliance-rgd');
		el.appendChild(wrap);
		if (geneId === undefined || geneId === null || geneId === '') {
			wrap.appendChild(node('span', 'No gene selected'));
			return;
		}
		wrap.appendChild(node('span', 'Loading...'));

		var mineRoot = serviceRoot(service.root);
		var apiBase = apiBaseOf(config);
		var view = ['Gene.primaryIdentifier', 'Gene.organism.shortName'];
		if (hasPath(service, 'Gene.organism.taxonId')) view.push('Gene.organism.taxonId');

		postRows(mineRoot, buildQuery(view, 'Gene.id', String(geneId)))
			.then(function (rows) {
				if (stale()) return;
				var r = rows[0];
				clear(wrap);
				if (!r) {
					wrap.appendChild(node('span', 'Gene not found in this mine'));
					return;
				}
				var id = isRat(r[1], r[2]) ? rgdIdOf(r[0]) : null;
				if (!id) {
					wrap.appendChild(node('span', NOT_RAT));
					return;
				}
				load(wrap, { apiBase: apiBase, id: id, stale: stale });
			})
			.catch(function (err) {
				if (stale()) return;
				console.error('rgd: gene lookup failed', err);
				clear(wrap);
				wrap.appendChild(node('span', 'Could not load the gene from the mine'));
			});
	}

	function load(wrap, ctx) {
		clear(wrap);
		var cardBox = node('div');
		var annBox = node('div');
		var orthoBox = node('div');
		var foot = node('p', 'Data from the Rat Genome Database (RGD) REST API', 'alliance-rgd-source');
		[cardBox, annBox, orthoBox, foot].forEach(function (b) { wrap.appendChild(b); });
		cardBox.appendChild(node('span', 'Loading gene...'));
		annBox.appendChild(node('span', 'Loading annotations...'));

		getJson(geneUrl(ctx.apiBase, ctx.id))
			.then(function (g) {
				if (ctx.stale()) return;
				clear(cardBox);
				cardBox.appendChild(geneCard(g || {}, ctx.id));
			})
			.catch(function (err) {
				if (ctx.stale()) return;
				console.error('rgd: gene failed', err);
				clear(cardBox);
				cardBox.appendChild(node('span', 'Could not load the gene from RGD'));
			});

		getJson(annotationsUrl(ctx.apiBase, ctx.id))
			.then(function (list) {
				if (ctx.stale()) return;
				clear(annBox);
				var groups = groupAnnotations(list);
				if (!groups.length) annBox.appendChild(node('span', 'No annotations in RGD'));
				else annBox.appendChild(annotationView(groups));
			})
			.catch(function (err) {
				if (ctx.stale()) return;
				console.error('rgd: annotations failed', err);
				clear(annBox);
				annBox.appendChild(node('span', 'Could not load annotations from RGD'));
			});

		getJson(orthologsUrl(ctx.apiBase, ctx.id))
			.then(function (list) {
				if (ctx.stale()) return;
				if (Array.isArray(list) && list.length) orthoBox.appendChild(orthologList(list));
			})
			.catch(function (err) {
				if (ctx.stale()) return;
				console.error('rgd: orthologs failed', err);
				orthoBox.appendChild(node('span', 'Could not load orthologs from RGD'));
			});
	}

	var api = {
		main: main,
		serviceRoot: serviceRoot,
		hasPath: hasPath,
		apiBaseOf: apiBaseOf,
		isRat: isRat,
		rgdIdOf: rgdIdOf,
		geneUrl: geneUrl,
		orthologsUrl: orthologsUrl,
		annotationsUrl: annotationsUrl,
		rgdGeneLink: rgdGeneLink,
		aspectLabel: aspectLabel,
		groupAnnotations: groupAnnotations,
		buildQuery: buildQuery,
		requestBody: requestBody,
		resultsUrl: resultsUrl
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceRgd = api;
})(typeof window !== 'undefined' ? window : globalThis);
