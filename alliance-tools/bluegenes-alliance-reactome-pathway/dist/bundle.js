/*
 * Reactome pathway diagram, a BlueGenes tool (tool API version 2).
 * Plain JavaScript without dependencies, so this file is both the source and
 * the bundle. BlueGenes loads it as a script and calls
 * bluegenesAllianceReactomePathway.main(el, service, entity, state, config, navigate).
 */
(function (root) {
	'use strict';

	var VIEWER_URL = 'https://www.reactome.org/DiagramJs/diagram/diagram.js';
	var IMAGE_URL = 'https://reactome.org/ContentService/exporter/diagram/';
	var BROWSER_URL = 'https://reactome.org/PathwayBrowser/#/';
	var REACTOME_ID = /^R-(HSA|MMU|RNO|DRE|DME|CEL|SCE)-\d+$/;
	var MAX_GENES = 2000;
	var VIEW = [
		'Pathway.identifier',
		'Pathway.name',
		'Pathway.genes.id',
		'Pathway.genes.primaryIdentifier',
		'Pathway.genes.symbol'
	];

	// BlueGenes passes the mine root (for example https://host/mine); the web
	// services live under /service. Accept either form.
	function serviceRoot(rootUrl) {
		var r = String(rootUrl || '').replace(/\/+$/, '');
		return /\/service$/.test(r) ? r : r + '/service';
	}

	function isReactomeId(id) {
		return typeof id === 'string' && REACTOME_ID.test(id);
	}

	function diagramImageUrl(id) {
		return IMAGE_URL + id + '.png';
	}

	function browserUrl(id) {
		return BROWSER_URL + id;
	}

	function escapeXml(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function buildQuery(id) {
		return (
			'<query model="genomic" view="' + VIEW.join(' ') + '" sortOrder="Pathway.genes.symbol asc">' +
			'<constraint path="Pathway.id" op="=" value="' + escapeXml(id) + '"/>' +
			'</query>'
		);
	}

	function requestBody(id) {
		return 'format=json&size=' + MAX_GENES + '&query=' + encodeURIComponent(buildQuery(id));
	}

	function cmp(a, b) {
		a = a == null ? '' : String(a);
		b = b == null ? '' : String(b);
		return a < b ? -1 : a > b ? 1 : 0;
	}

	function toGenes(rows) {
		return rows
			.filter(function (r) { return r[2] != null; })
			.map(function (r) { return { id: r[2], identifier: r[3], symbol: r[4] }; })
			.sort(function (a, b) {
				return cmp(a.symbol || a.identifier, b.symbol || b.identifier) || cmp(a.identifier, b.identifier);
			});
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
		var wrap = node('div', null, 'alliance-reactome');
		wrap.appendChild(node('span', text));
		el.appendChild(wrap);
	}

	function externalLink(text, href) {
		var a = node('a', text);
		a.href = href;
		a.target = '_blank';
		a.rel = 'noopener';
		return a;
	}

	function geneTable(genes, navigate) {
		var table = node('table', null, 'table table-condensed table-striped');
		var headRow = node('tr');
		['Symbol', 'Identifier'].forEach(function (h) { headRow.appendChild(node('th', h)); });
		var thead = node('thead');
		thead.appendChild(headRow);
		table.appendChild(thead);
		var tbody = node('tbody');
		genes.forEach(function (g) {
			var tr = node('tr');
			var a = node('a', g.symbol || g.identifier);
			a.href = '#';
			a.addEventListener('click', function (ev) {
				if (ev && ev.preventDefault) ev.preventDefault();
				if (typeof navigate === 'function') navigate('report', { type: 'Gene', id: g.id });
			});
			var symbolCell = node('td');
			symbolCell.appendChild(a);
			tr.appendChild(symbolCell);
			tr.appendChild(node('td', g.identifier || ''));
			tbody.appendChild(tr);
		});
		table.appendChild(tbody);
		return table;
	}

	function symbolsOf(genes) {
		return genes
			.map(function (g) { return g.symbol; })
			.filter(Boolean)
			.join(',');
	}

	var pendingViewer = null;

	// Calls done(true) when the Reactome diagram viewer is available, done(false) when it cannot load.
	function loadViewer(done) {
		if (root.Reactome && root.Reactome.Diagram) {
			done(true);
			return;
		}
		if (pendingViewer) {
			pendingViewer.push(done);
			return;
		}
		pendingViewer = [done];
		var finish = function (available) {
			var waiting = pendingViewer;
			pendingViewer = null;
			waiting.forEach(function (cb) { cb(available); });
		};
		var script = node('script');
		script.src = VIEWER_URL;
		script.onload = function () { finish(!!(root.Reactome && root.Reactome.Diagram)); };
		script.onerror = function () { finish(false); };
		document.head.appendChild(script);
	}

	function showViewer(holder, id, genes) {
		var diagram = root.Reactome.Diagram.create({
			placeHolder: holder.id,
			width: holder.clientWidth || 900,
			height: 600
		});
		var flag = function () { diagram.flagItems(symbolsOf(genes)); };
		if (typeof diagram.onDiagramLoaded === 'function') diagram.onDiagramLoaded(flag);
		diagram.loadDiagram(id);
		if (typeof diagram.onDiagramLoaded !== 'function') flag();
	}

	function showImage(holder, id) {
		var img = node('img', null, 'alliance-reactome-image');
		img.src = diagramImageUrl(id);
		img.alt = 'Reactome diagram of ' + id;
		holder.appendChild(img);
	}

	function diagramHolder(token) {
		var holder = node('div', null, 'alliance-reactome-diagram');
		holder.id = 'alliance-reactome-diagram-' + token;
		return holder;
	}

	function render(el, token, pathway, genes, navigate) {
		clear(el);
		var wrap = node('div', null, 'alliance-reactome');
		var summary = pathway.name + ' (' + pathway.identifier + '), ' + genes.length + ' genes in this mine.';
		wrap.appendChild(node('p', summary, 'alliance-reactome-summary'));
		wrap.appendChild(externalLink('Open in the Reactome pathway browser', browserUrl(pathway.identifier)));
		var holder = diagramHolder(token);
		wrap.appendChild(holder);
		if (genes.length) wrap.appendChild(geneTable(genes, navigate));
		el.appendChild(wrap);
		loadViewer(function (available) {
			if (el.__agrReactomeReq !== token) return;
			if (available) showViewer(holder, pathway.identifier, genes);
			else showImage(holder, pathway.identifier);
		});
	}

	function fetchRows(rootUrl, id) {
		return fetch(serviceRoot(rootUrl) + '/query/results', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: requestBody(id)
		})
			.then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status);
				return res.json();
			})
			.then(function (json) {
				return (json && json.results) || [];
			});
	}

	function show(el, token, rows, navigate) {
		if (el.__agrReactomeReq !== token) return;
		if (!rows.length) {
			message(el, 'Pathway not found in this mine');
			return;
		}
		var pathway = { identifier: rows[0][0], name: rows[0][1] };
		if (!isReactomeId(pathway.identifier)) {
			message(el, 'Not a Reactome pathway: no diagram to show for ' + pathway.identifier);
			return;
		}
		render(el, token, pathway, toGenes(rows), navigate);
	}

	function main(el, service, imEntity, state, config, navigate) {
		if (!el || !service || !imEntity) {
			throw new Error('Call main with correct signature');
		}
		var token = (el.__agrReactomeReq = (el.__agrReactomeReq || 0) + 1);
		var id = imEntity.Pathway && imEntity.Pathway.value;
		if (id === undefined || id === null || id === '') {
			message(el, 'No pathway selected');
			return;
		}
		message(el, 'Loading...');
		fetchRows(service.root, id)
			.then(function (rows) { show(el, token, rows, navigate); })
			.catch(function () {
				if (el.__agrReactomeReq !== token) return;
				message(el, 'Could not load the pathway from the mine');
			});
	}

	var api = {
		main: main,
		serviceRoot: serviceRoot,
		isReactomeId: isReactomeId,
		diagramImageUrl: diagramImageUrl,
		browserUrl: browserUrl,
		buildQuery: buildQuery,
		requestBody: requestBody,
		toGenes: toGenes,
		escapeXml: escapeXml
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceReactomePathway = api;
})(typeof window !== 'undefined' ? window : globalThis);
