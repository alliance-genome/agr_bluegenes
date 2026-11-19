/*
 * Interaction network of a gene set (Alliance), a BlueGenes tool (tool API version 2).
 * Plain JavaScript without dependencies, so this file is both the source and
 * the bundle. BlueGenes loads it as a script and calls
 * bluegenesAllianceSetInteractions.main(el, service, entity, state, config, navigate, context).
 *
 * For the genes of a list or results set it POSTs one query for Gene.interactions
 * whose participant2 is in the same set, then builds the edge table, degree
 * ranking, SIF/TSV exports and a circular SVG layout in the browser.
 */
(function (root) {
	'use strict';

	var VIEW = [
		'Gene.id',
		'Gene.primaryIdentifier',
		'Gene.symbol',
		'Gene.interactions.participant2.id',
		'Gene.interactions.participant2.primaryIdentifier',
		'Gene.interactions.participant2.symbol',
		'Gene.interactions.relation',
		'Gene.interactions.detectionMethod.name',
		'Gene.interactions.details.experiment.publication.pubMedId'
	];
	var MAX_ROWS = 50000;
	var MAX_NODES = 150;
	var HUB_COUNT = 20;
	var PAGE_ROWS = 100;
	var PUBMED_URL = 'https://pubmed.ncbi.nlm.nih.gov/';
	var SVG_NS = 'http://www.w3.org/2000/svg';
	var SVG_SIZE = 420;

	function serviceRoot(r) {
		var s = String(r || '').replace(/\/+$/, '');
		return /\/service$/.test(s) ? s : s + '/service';
	}

	function escapeXml(s) {
		return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	function oneOf(path, values) {
		return '<constraint path="' + path + '" op="ONE OF">' +
			values.map(function (v) { return '<value>' + escapeXml(v) + '</value>'; }).join('') +
			'</constraint>';
	}

	function buildSetQuery(ids) {
		return '<query model="genomic" view="' + VIEW.join(' ') + '">' +
			oneOf('Gene.id', ids) +
			oneOf('Gene.interactions.participant2.id', ids) +
			'</query>';
	}

	function postRows(rootUrl, query) {
		var body = 'format=json&size=' + MAX_ROWS + '&query=' + encodeURIComponent(query);
		return fetch(serviceRoot(rootUrl) + '/query/results', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: body
		})
			.then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status);
				return res.json();
			})
			.then(function (json) { return (json && json.results) || []; });
	}

	function nodeOf(id, pid, symbol) {
		return { id: id, pid: pid, symbol: symbol || pid };
	}

	function edgeKey(a, b, relation, method) {
		return [a.pid, b.pid, relation, method].join('\u0001');
	}

	// One edge per unordered gene pair, relation and detection method; publications are merged.
	function buildEdges(rows) {
		var byKey = {};
		var edges = [];
		rows.forEach(function (r) {
			if (!r[1] || !r[4] || r[1] === r[4]) return;
			var n1 = nodeOf(r[0], r[1], r[2]);
			var n2 = nodeOf(r[3], r[4], r[5]);
			var pair = n1.pid < n2.pid ? [n1, n2] : [n2, n1];
			var relation = r[6] || '';
			var method = r[7] || '';
			var key = edgeKey(pair[0], pair[1], relation, method);
			if (!byKey[key]) {
				byKey[key] = { a: pair[0], b: pair[1], relation: relation, method: method, pmids: [] };
				edges.push(byKey[key]);
			}
			var pmid = r[8] == null ? '' : String(r[8]);
			if (pmid && byKey[key].pmids.indexOf(pmid) === -1) byKey[key].pmids.push(pmid);
		});
		return edges;
	}

	function filterEdges(edges, f) {
		return edges.filter(function (e) {
			return (!f.relation || e.relation === f.relation) && (!f.method || e.method === f.method);
		});
	}

	function distinctValues(edges, field) {
		var seen = {};
		edges.forEach(function (e) { if (e[field]) seen[e[field]] = true; });
		return Object.keys(seen).sort();
	}

	function addNeighbour(map, from, to) {
		var entry = map[from.pid] || (map[from.pid] = { node: from, neighbours: {} });
		entry.neighbours[to.pid] = true;
	}

	function degreeRanking(edges) {
		var map = {};
		edges.forEach(function (e) {
			addNeighbour(map, e.a, e.b);
			addNeighbour(map, e.b, e.a);
		});
		return Object.keys(map)
			.map(function (k) { return { node: map[k].node, degree: Object.keys(map[k].neighbours).length }; })
			.sort(function (x, y) {
				return y.degree - x.degree || (x.node.symbol < y.node.symbol ? -1 : x.node.symbol > y.node.symbol ? 1 : 0);
			});
	}

	function hubIds(ranking, count) {
		return ranking.slice(0, count).map(function (r) { return r.node.id; });
	}

	function sifName(node) {
		return String(node.symbol || node.pid).replace(/\s+/g, '_');
	}

	function toSif(edges) {
		var seen = {};
		var lines = [];
		edges.forEach(function (e) {
			var line = [sifName(e.a), e.relation || 'interacts_with', sifName(e.b)].join('\t');
			if (seen[line]) return;
			seen[line] = true;
			lines.push(line);
		});
		return lines.join('\n');
	}

	function toTsv(edges) {
		var lines = [['gene_a', 'gene_b', 'relation', 'detection_method', 'pubmed_ids'].join('\t')];
		edges.forEach(function (e) {
			lines.push([e.a.symbol, e.b.symbol, e.relation, e.method, e.pmids.join(',')].join('\t'));
		});
		return lines.join('\n');
	}

	function pairCount(edges) {
		var seen = {};
		edges.forEach(function (e) { seen[e.a.pid + '|' + e.b.pid] = true; });
		return Object.keys(seen).length;
	}

	// Top nodes by degree on a circle, with one link per gene pair among them.
	function circularLayout(edges, cap) {
		var top = degreeRanking(edges).slice(0, cap);
		var half = SVG_SIZE / 2;
		var radius = half - 40;
		var byPid = {};
		var nodes = top.map(function (r, i) {
			var angle = (2 * Math.PI * i) / top.length - Math.PI / 2;
			var n = { node: r.node, degree: r.degree, x: half + radius * Math.cos(angle), y: half + radius * Math.sin(angle) };
			byPid[r.node.pid] = n;
			return n;
		});
		var seen = {};
		var links = [];
		edges.forEach(function (e) {
			var key = e.a.pid + '|' + e.b.pid;
			if (seen[key] || !byPid[e.a.pid] || !byPid[e.b.pid]) return;
			seen[key] = true;
			links.push({ from: byPid[e.a.pid], to: byPid[e.b.pid] });
		});
		return { nodes: nodes, links: links };
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

	function button(label, onClick) {
		var b = node('button', label, 'agr-btn agr-btn-sm');
		b.type = 'button';
		b.addEventListener('click', onClick);
		return b;
	}

	function geneLink(n, navigate) {
		var a = node('a', n.symbol);
		a.href = '#';
		a.addEventListener('click', function (ev) {
			if (ev && ev.preventDefault) ev.preventDefault();
			if (typeof navigate === 'function') navigate('report', { type: 'Gene', id: n.id });
		});
		return a;
	}

	function pmidCell(pmids) {
		var span = node('span');
		pmids.forEach(function (p, i) {
			if (i) span.appendChild(document.createTextNode(', '));
			var a = node('a', p);
			a.href = PUBMED_URL + p;
			a.target = '_blank';
			a.rel = 'noopener';
			span.appendChild(a);
		});
		return span;
	}

	function appendCell(tr, content) {
		var td = node('td');
		if (content && typeof content === 'object') td.appendChild(content);
		else td.textContent = content == null ? '' : String(content);
		tr.appendChild(td);
	}

	function buildTable(heads, rows) {
		var wrap = node('div', null, 'agr-table-wrap');
		var t = node('table', null, 'agr-table agr-table-sm');
		var headRow = node('tr');
		heads.forEach(function (h) { headRow.appendChild(node('th', h)); });
		var thead = node('thead');
		thead.appendChild(headRow);
		var tbody = node('tbody');
		rows.forEach(function (cells) {
			var tr = node('tr');
			cells.forEach(function (c) { appendCell(tr, c); });
			tbody.appendChild(tr);
		});
		t.appendChild(thead);
		t.appendChild(tbody);
		wrap.appendChild(t);
		return wrap;
	}

	function edgeTable(edges, navigate) {
		var rows = edges.map(function (e) {
			return [geneLink(e.a, navigate), geneLink(e.b, navigate), e.relation, e.method, pmidCell(e.pmids)];
		});
		return buildTable(['Gene A', 'Gene B', 'Relation', 'Detection method', 'PMID'], rows);
	}

	function rankingTable(ranking, navigate) {
		var rows = ranking.slice(0, HUB_COUNT).map(function (r) {
			return [geneLink(r.node, navigate), r.degree];
		});
		return buildTable(['Gene', 'Interaction partners in set'], rows);
	}

	function svgNode(tag, attrs) {
		var e = document.createElementNS(SVG_NS, tag);
		Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
		return e;
	}

	function networkSvg(layout) {
		var svg = svgNode('svg', { viewBox: '0 0 ' + SVG_SIZE + ' ' + SVG_SIZE, role: 'img', 'aria-label': 'Interaction network' });
		layout.links.forEach(function (l) {
			svg.appendChild(svgNode('line', { x1: l.from.x.toFixed(1), y1: l.from.y.toFixed(1), x2: l.to.x.toFixed(1), y2: l.to.y.toFixed(1), class: 'agr-edge' }));
		});
		layout.nodes.forEach(function (n) {
			var c = svgNode('circle', { cx: n.x.toFixed(1), cy: n.y.toFixed(1), r: Math.min(3 + n.degree, 12), class: 'agr-node' });
			var title = svgNode('title', {});
			title.textContent = n.node.symbol + ' (' + n.degree + ')';
			c.appendChild(title);
			svg.appendChild(c);
		});
		return svg;
	}

	function download(name, text, type) {
		var a = node('a');
		a.href = 'data:' + type + ';charset=utf-8,' + encodeURIComponent(text);
		a.download = name;
		document.body.appendChild(a);
		if (a.click) a.click();
		document.body.removeChild(a);
	}

	function select(label, values, onChange) {
		var s = node('select', null, 'form-control input-sm');
		s.setAttribute('aria-label', label);
		var all = node('option', 'All ' + label.toLowerCase() + 's');
		all.value = '';
		s.appendChild(all);
		values.forEach(function (v) {
			var o = node('option', v);
			o.value = v;
			s.appendChild(o);
		});
		s.addEventListener('change', function () { onChange(s.value); });
		return s;
	}

	function saveHubs(ctx, ranking, status) {
		var title = (ctx.context.list && (ctx.context.list.title || ctx.context.list.name)) || 'gene set';
		var ids = hubIds(ranking, HUB_COUNT);
		status.textContent = 'Saving...';
		ctx.context.saveList({ name: title + ' interaction hubs', class: 'Gene', ids: ids, tags: ['alliance-interactions'] })
			.then(function (name) { status.textContent = 'Saved list ' + name; })
			.catch(function (err) {
				status.textContent = err && err.message === 'login required' ? 'Log in to save lists' : 'Could not save the list';
			});
	}

	function canSave(context) {
		return !!context && typeof context.saveList === 'function';
	}

	function actions(ctx, edges, ranking) {
		var bar = node('div', null, 'agr-actions');
		bar.appendChild(button('Download SIF', function () { download('interactions.sif', toSif(edges), 'text/plain'); }));
		bar.appendChild(button('Download TSV', function () { download('interactions.tsv', toTsv(edges), 'text/tab-separated-values'); }));
		if (canSave(ctx.context) && ranking.length) {
			var status = node('span', null, 'agr-note');
			bar.appendChild(button('Save hubs as list', function () { saveHubs(ctx, ranking, status); }));
			bar.appendChild(status);
		}
		return bar;
	}

	function summaryText(edges, ranking) {
		return edges.length + ' edges between ' + pairCount(edges) + ' gene pairs, ' + ranking.length + ' genes';
	}

	function renderNetwork(wrap, ctx, all) {
		var filter = { relation: '', method: '' };
		var shown = PAGE_ROWS;
		var view = node('div');
		var filters = node('div', null, 'agr-filters');
		filters.appendChild(select('Relation', distinctValues(all, 'relation'), function (v) { filter.relation = v; shown = PAGE_ROWS; draw(); }));
		filters.appendChild(select('Detection method', distinctValues(all, 'method'), function (v) { filter.method = v; shown = PAGE_ROWS; draw(); }));
		wrap.appendChild(filters);
		wrap.appendChild(view);

		function draw() {
			var edges = filterEdges(all, filter);
			var ranking = degreeRanking(edges);
			clear(view);
			view.appendChild(node('p', summaryText(edges, ranking), 'agr-note alliance-set-interactions-summary'));
			if (!edges.length) {
				view.appendChild(node('p', 'No edges match the filters', 'agr-empty'));
				return;
			}
			view.appendChild(actions(ctx, edges, ranking));
			view.appendChild(node('h4', 'Genes by number of partners'));
			view.appendChild(rankingTable(ranking, ctx.navigate));
			view.appendChild(node('h4', 'Network (top ' + Math.min(MAX_NODES, ranking.length) + ' genes by degree)'));
			view.appendChild(networkSvg(circularLayout(edges, MAX_NODES)));
			view.appendChild(node('h4', 'Edges'));
			view.appendChild(edgeTable(edges.slice(0, shown), ctx.navigate));
			if (edges.length > shown) {
				view.appendChild(button('Show more (' + (edges.length - shown) + ' left)', function () { shown += PAGE_ROWS; draw(); }));
			}
		}
		draw();
	}

	function idsOf(entity) {
		var raw = entity && entity.Gene && entity.Gene.value;
		if (raw === undefined || raw === null || raw === '') return [];
		return Array.isArray(raw) ? raw : [raw];
	}

	function main(el, service, imEntity, state, config, navigate, context) {
		if (!el || !service || !imEntity) {
			throw new Error('Call main with correct signature');
		}
		var token = (el.__agrSetReq = (el.__agrSetReq || 0) + 1);
		var stale = function () { return el.__agrSetReq !== token; };
		var ids = idsOf(imEntity);
		clear(el);
		var wrap = node('div', null, 'alliance-set-interactions');
		el.appendChild(wrap);
		if (ids.length < 2) {
			wrap.appendChild(node('p', 'Select a list or results with at least 2 genes', 'agr-empty'));
			return;
		}
		wrap.appendChild(node('p', 'Loading interactions among ' + ids.length + ' genes...', 'agr-loading'));
		postRows(service.root, buildSetQuery(ids))
			.then(function (rows) {
				if (stale()) return;
				clear(wrap);
				var edges = buildEdges(rows);
				if (!edges.length) {
					wrap.appendChild(node('p', 'No interactions among these genes', 'agr-empty'));
					return;
				}
				renderNetwork(wrap, { navigate: navigate, context: context }, edges);
			})
			.catch(function (err) {
				if (stale()) return;
				console.error('set-interactions: query failed', err);
				clear(wrap);
				wrap.appendChild(node('p', 'Could not load interactions from the mine', 'agr-error'));
			});
	}

	var api = {
		main: main,
		buildSetQuery: buildSetQuery,
		buildEdges: buildEdges,
		filterEdges: filterEdges,
		degreeRanking: degreeRanking,
		hubIds: hubIds,
		toSif: toSif,
		toTsv: toTsv,
		circularLayout: circularLayout
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceSetInteractions = api;
})(typeof window !== 'undefined' ? window : globalThis);
