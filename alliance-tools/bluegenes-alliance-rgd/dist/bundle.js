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

	// RGD speciesTypeKey names, from GET https://rest.rgd.mcw.edu/rgdws/lookup/speciesTypeKeys (fetched 2026-11-11).
	// Keys not listed are labelled generically.
	var SPECIES = {
		1: 'Human',
		2: 'Mouse',
		3: 'Rat',
		4: 'Chinchilla',
		5: 'Bonobo',
		6: 'Dog',
		7: 'Squirrel',
		9: 'Pig',
		13: 'Green Monkey',
		14: 'Naked Mole-Rat',
		17: 'Black Rat'
	};

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
		return mineFetch(resultsUrl(root), {
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
					throw httpError(res);
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
		return SPECIES[key] || 'Other species (RGD key ' + key + ')';
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
		a.rel = 'noopener noreferrer';
		a.className = 'agr-external';
		if (title) a.title = title;
		return a;
	}

	function geneCard(gene, id) {
		var card = node('div', null, 'alliance-rgd-gene');
		var head = node('h4');
		head.appendChild(externalLink(gene.symbol || 'RGD:' + id, rgdGeneLink(id), 'View RGD:' + id + ' at RGD'));
		card.appendChild(head);
		var attrs = node('dl', null, 'agr-attrs');
		[['Name', gene.name], ['Type', gene.type], ['RefSeq status', gene.refSeqStatus], ['Description', gene.description]].forEach(function (f) {
			if (f[1] === undefined || f[1] === null || f[1] === '') return;
			attrs.appendChild(node('dt', f[0]));
			attrs.appendChild(node('dd', f[1]));
		});
		card.appendChild(attrs);
		return card;
	}

	function annotationTable(rows) {
		var wrap = node('div', null, 'agr-table-wrap');
		var t = node('table', null, 'agr-table agr-table-sm');
		wrap.appendChild(t);
		var headRow = node('tr');
		['Term', 'Evidence', 'Source', 'Reference'].forEach(function (h) { headRow.appendChild(colHeader(h)); });
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
		return wrap;
	}

	function orthologList(list) {
		var d = node('details', null, 'alliance-rgd-orthologs');
		d.appendChild(node('summary', 'Orthologs (' + list.length + ')'));
		var wrap = node('div', null, 'agr-table-wrap');
		var t = node('table', null, 'agr-table agr-table-sm');
		var headRow = node('tr');
		['Gene', 'Species', 'Name'].forEach(function (h) { headRow.appendChild(colHeader(h)); });
		var thead = node('thead');
		thead.appendChild(headRow);
		t.appendChild(thead);
		var tbody = node('tbody');
		list.forEach(function (o) {
			var tr = node('tr');
			var gene = node('td');
			gene.appendChild(externalLink(o.symbol || 'RGD:' + o.rgdId, rgdGeneLink(o.rgdId), 'RGD:' + o.rgdId));
			var sp = node('td');
			sp.appendChild(node('em', speciesName(o.speciesTypeKey)));
			tr.appendChild(gene);
			tr.appendChild(sp);
			tr.appendChild(node('td', o.name || ''));
			tbody.appendChild(tr);
		});
		t.appendChild(tbody);
		wrap.appendChild(t);
		d.appendChild(wrap);
		return d;
	}

	// Annotation tabs with per-aspect counts and 50-row paging.
	function annotationView(groups) {
		var box = node('div', null, 'alliance-rgd-annotations');
		var bar = node('ul', null, 'agr-tabs alliance-rgd-tabs');
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
			panel.appendChild(node('p', 'Showing ' + n + ' of ' + g.rows.length, 'agr-note alliance-rgd-summary'));
			panel.appendChild(annotationTable(g.rows.slice(0, n)));
			if (n < g.rows.length) {
				var more = node('button', 'Show ' + Math.min(PAGE_SIZE, g.rows.length - n) + ' more', 'agr-btn agr-btn-sm');
				more.type = 'button';
				more.addEventListener('click', function () {
					shown[code] = n + PAGE_SIZE;
					show(code);
				});
				panel.appendChild(more);
			}
		}

		groups.forEach(function (g) {
			var li = node('li');
			var b = node('button', g.label + ' ');
			b.appendChild(node('span', '(' + g.rows.length + ')', 'agr-count'));
			b.type = 'button';
			b.setAttribute('role', 'tab');
			b.setAttribute('aria-selected', 'false');
			b.addEventListener('click', function () { show(g.code); });
			buttons[g.code] = b;
			li.appendChild(b);
			bar.appendChild(li);
		});
		show(groups[0].code);
		return box;
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
		var token = (el.__agrRgdReq = (el.__agrRgdReq || 0) + 1);
		var stale = function () { return el.__agrRgdReq !== token; };
		var gene = imEntity.Gene;
		var raw = gene && gene.value;
		var geneId = Array.isArray(raw) ? raw[0] : raw;
		clear(el);
		var wrap = node('div', null, 'alliance-rgd');
		el.appendChild(wrap);
		if (geneId === undefined || geneId === null || geneId === '') {
			wrap.appendChild(statusNode('No gene selected', 'agr-empty'));
			return;
		}
		wrap.appendChild(statusNode('Loading...', 'agr-loading'));

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
					wrap.appendChild(statusNode('Gene not found in this mine', 'agr-empty'));
					return;
				}
				var id = isRat(r[1], r[2]) ? rgdIdOf(r[0]) : null;
				if (!id) {
					wrap.appendChild(statusNode(NOT_RAT, 'agr-empty'));
					return;
				}
				load(wrap, { apiBase: apiBase, id: id, stale: stale });
			})
			.catch(function (err) {
				if (stale()) return;
				console.error('rgd: gene lookup failed', err);
				clear(wrap);
				wrap.appendChild(statusNode(errorText(err, 'Could not load the gene from the mine'), 'agr-error'));
			});
	}

	function load(wrap, ctx) {
		clear(wrap);
		var cardBox = node('div');
		var annBox = node('div');
		var orthoBox = node('div');
		var foot = node('p', 'Data from the Rat Genome Database (RGD) REST API', 'agr-note alliance-rgd-source');
		[cardBox, annBox, orthoBox, foot].forEach(function (b) { wrap.appendChild(b); });
		cardBox.appendChild(statusNode('Loading gene...', 'agr-loading'));
		annBox.appendChild(statusNode('Loading annotations...', 'agr-loading'));

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
				cardBox.appendChild(statusNode('Could not load the gene from RGD', 'agr-error'));
			});

		getJson(annotationsUrl(ctx.apiBase, ctx.id))
			.then(function (list) {
				if (ctx.stale()) return;
				clear(annBox);
				var groups = groupAnnotations(list);
				if (!groups.length) annBox.appendChild(statusNode('No annotations for this gene', 'agr-empty'));
				else annBox.appendChild(annotationView(groups));
			})
			.catch(function (err) {
				if (ctx.stale()) return;
				console.error('rgd: annotations failed', err);
				clear(annBox);
				annBox.appendChild(statusNode('Could not load annotations from RGD', 'agr-error'));
			});

		getJson(orthologsUrl(ctx.apiBase, ctx.id))
			.then(function (list) {
				if (ctx.stale()) return;
				if (Array.isArray(list) && list.length) orthoBox.appendChild(orthologList(list));
			})
			.catch(function (err) {
				if (ctx.stale()) return;
				console.error('rgd: orthologs failed', err);
				orthoBox.appendChild(statusNode('Could not load orthologs from RGD', 'agr-error'));
			});
	}

	var api = {
		mineFetch: mineFetch,
		errorText: errorText,
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
		speciesName: speciesName,
		groupAnnotations: groupAnnotations,
		buildQuery: buildQuery,
		requestBody: requestBody,
		resultsUrl: resultsUrl
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceRgd = api;
})(typeof window !== 'undefined' ? window : globalThis);
