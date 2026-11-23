/*
 * Interaction network of a gene set (Alliance), a BlueGenes tool (tool API version 2).
 * Plain JavaScript without dependencies, so this file is both the source and
 * the bundle. BlueGenes loads it as a script and calls
 * bluegenesAllianceSetInteractions.main(el, service, entity, state, config, navigate, context).
 *
 * For the genes of a list or results set it POSTs one query for Gene.interactions
 * whose participant2 is in the same set, then builds the edge table, degree
 * ranking, SIF/TSV exports and a circular SVG layout in the browser. The query is
 * paged and capped at MAX_ROWS rows, with a warning when the cap is hit.
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
	var PAGE_SIZE = 5000;
	var MAX_TRIES = 4;
	var MIN_HUBS = 3;
	var LABEL_NODES = 20;
	var PMID_SHOWN = 10;
	var settings = { timeoutMs: 60000, backoffMs: 1000 };
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

	var OUTER_JOINS = [
		'Gene.interactions.detectionMethod',
		'Gene.interactions.details',
		'Gene.interactions.details.experiment',
		'Gene.interactions.details.experiment.publication'
	].map(function (path) { return '<join path="' + path + '" style="OUTER"/>'; }).join('');

	function buildSetQuery(ids) {
		return '<query model="genomic" view="' + VIEW.join(' ') + '">' +
			OUTER_JOINS +
			oneOf('Gene.id', ids) +
			oneOf('Gene.interactions.participant2.id', ids) +
			'</query>';
	}

	function sleep(ms) {
		return new Promise(function (resolve) { setTimeout(resolve, ms); });
	}

	function httpError(status) {
		var err = new Error('HTTP ' + status);
		err.status = status;
		return err;
	}

	// POST with a timeout and up to MAX_TRIES attempts, backing off on HTTP 429.
	function post(rootUrl, body, parse, attempt) {
		var tries = attempt || 0;
		var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
		var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, settings.timeoutMs);
		var opts = {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: body
		};
		if (ctrl) opts.signal = ctrl.signal;
		return fetch(serviceRoot(rootUrl) + '/query/results', opts).then(
			function (res) {
				if (res.status === 429 && tries + 1 < MAX_TRIES) {
					clearTimeout(timer);
					return sleep(settings.backoffMs * Math.pow(2, tries)).then(function () {
						return post(rootUrl, body, parse, tries + 1);
					});
				}
				if (!res.ok) {
					clearTimeout(timer);
					throw httpError(res.status);
				}
				return parse(res).then(
					function (v) { clearTimeout(timer); return v; },
					function (err) { clearTimeout(timer); throw err; }
				);
			},
			function (err) {
				clearTimeout(timer);
				throw err;
			}
		);
	}

	// Pages through the result and stops one row past MAX_ROWS, so a result of exactly MAX_ROWS is not flagged.
	function fetchRows(rootUrl, query) {
		var rows = [];
		function page(start) {
			var size = Math.min(PAGE_SIZE, MAX_ROWS + 1 - rows.length);
			var body = 'format=json&start=' + start + '&size=' + size + '&query=' + encodeURIComponent(query);
			return post(rootUrl, body, function (res) {
				return res.json().then(function (json) { return (json && json.results) || []; });
			}).then(function (batch) {
				rows = rows.concat(batch);
				if (batch.length < size) return { rows: rows, truncated: false };
				if (rows.length > MAX_ROWS) return { rows: rows.slice(0, MAX_ROWS), truncated: true };
				return page(start + size);
			});
		}
		return page(0);
	}

	function buildCountQuery(ids) {
		return '<query model="genomic" view="Gene.id">' +
			oneOf('Gene.id', ids) +
			'<constraint path="Gene.interactions.id" op="IS NOT NULL"/>' +
			'</query>';
	}

	function fetchInteractingCount(rootUrl, ids) {
		var body = 'format=count&query=' + encodeURIComponent(buildCountQuery(ids));
		return post(rootUrl, body, function (res) {
			return res.text().then(function (t) {
				var n = parseInt(t, 10);
				if (isNaN(n)) throw new Error('bad count');
				return n;
			});
		});
	}

	function nodeOf(id, pid, symbol) {
		return { id: id, pid: pid, symbol: symbol || pid };
	}

	function edgeKey(a, b, relation, method) {
		return [a.pid, b.pid, relation, method].join('\u0001');
	}

	// One edge per unordered gene pair, relation and detection method; publications are merged.
	// A gene paired with itself is kept and flagged as a self edge.
	function buildEdges(rows) {
		var byKey = {};
		var edges = [];
		rows.forEach(function (r) {
			if (!r[1] || !r[4]) return;
			var n1 = nodeOf(r[0], r[1], r[2]);
			var n2 = nodeOf(r[3], r[4], r[5]);
			var pair = n1.pid < n2.pid ? [n1, n2] : [n2, n1];
			var relation = r[6] || '';
			var method = r[7] || '';
			var key = edgeKey(pair[0], pair[1], relation, method);
			if (!byKey[key]) {
				byKey[key] = { a: pair[0], b: pair[1], relation: relation, method: method, pmids: [], self: n1.pid === n2.pid };
				edges.push(byKey[key]);
			}
			var pmid = r[8] == null ? '' : String(r[8]);
			if (pmid && byKey[key].pmids.indexOf(pmid) === -1) byKey[key].pmids.push(pmid);
		});
		return edges;
	}

	function pushNew(list, v) {
		if (v && list.indexOf(v) === -1) list.push(v);
	}

	// One group per gene pair and relation, best supported first.
	function groupEdges(edges) {
		var byKey = {};
		var groups = [];
		edges.forEach(function (e) {
			var key = [e.a.pid, e.b.pid, e.relation].join('\u0001');
			var g = byKey[key];
			if (!g) {
				g = byKey[key] = { a: e.a, b: e.b, relation: e.relation, self: e.self, methods: [], pmids: [] };
				groups.push(g);
			}
			pushNew(g.methods, e.method);
			e.pmids.forEach(function (p) { pushNew(g.pmids, p); });
		});
		return groups.sort(function (x, y) {
			return y.pmids.length - x.pmids.length || y.methods.length - x.methods.length ||
				(x.a.symbol < y.a.symbol ? -1 : x.a.symbol > y.a.symbol ? 1 : 0) ||
				(x.b.symbol < y.b.symbol ? -1 : x.b.symbol > y.b.symbol ? 1 : 0);
		});
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
			if (e.self) return;
			addNeighbour(map, e.a, e.b);
			addNeighbour(map, e.b, e.a);
		});
		return Object.keys(map)
			.map(function (k) { return { node: map[k].node, degree: Object.keys(map[k].neighbours).length }; })
			.sort(function (x, y) {
				return y.degree - x.degree || (x.node.symbol < y.node.symbol ? -1 : x.node.symbol > y.node.symbol ? 1 : 0);
			});
	}

	// Genes with at least 2 partners and a degree in the top decile, at most count of them.
	function hubIds(ranking, count) {
		if (!ranking.length) return [];
		var min = Math.max(2, ranking[Math.ceil(ranking.length / 10) - 1].degree);
		return ranking
			.filter(function (r) { return r.degree >= min; })
			.slice(0, count)
			.map(function (r) { return r.node.id; });
	}

	function symbolPids(edges) {
		var map = {};
		edges.forEach(function (e) {
			[e.a, e.b].forEach(function (n) {
				var list = map[n.symbol] || (map[n.symbol] = []);
				pushNew(list, n.pid);
			});
		});
		return map;
	}

	function sifName(node, shared) {
		var name = String(node.symbol || node.pid).replace(/\s+/g, '_');
		return shared[node.symbol] && shared[node.symbol].length > 1 ? name + '_' + node.pid : name;
	}

	function toSif(edges) {
		var shared = symbolPids(edges);
		var seen = {};
		var lines = [];
		edges.forEach(function (e) {
			var line = [sifName(e.a, shared), e.relation || 'interacts_with', sifName(e.b, shared)].join('\t');
			if (seen[line]) return;
			seen[line] = true;
			lines.push(line);
		});
		return lines.join('\n');
	}

	function toTsv(edges) {
		var lines = [['gene_a', 'gene_a_id', 'gene_b', 'gene_b_id', 'relation', 'detection_method', 'pubmed_ids'].join('\t')];
		edges.forEach(function (e) {
			lines.push([e.a.symbol, e.a.pid, e.b.symbol, e.b.pid, e.relation, e.method, e.pmids.join(',')].join('\t'));
		});
		return lines.join('\n');
	}

	function pairCount(edges) {
		var seen = {};
		edges.forEach(function (e) { if (!e.self) seen[e.a.pid + '|' + e.b.pid] = true; });
		return Object.keys(seen).length;
	}

	// Top nodes by degree on a circle, with one link per gene pair among them.
	function circularLayout(edges, cap) {
		var top = degreeRanking(edges).slice(0, cap);
		var half = SVG_SIZE / 2;
		var radius = half - 40;
		var byPid = {};
		var selfPids = {};
		edges.forEach(function (e) { if (e.self) selfPids[e.a.pid] = true; });
		var nodes = top.map(function (r, i) {
			var angle = (2 * Math.PI * i) / top.length - Math.PI / 2;
			var n = { node: r.node, degree: r.degree, self: !!selfPids[r.node.pid], x: half + radius * Math.cos(angle), y: half + radius * Math.sin(angle) };
			byPid[r.node.pid] = n;
			return n;
		});
		var seen = {};
		var links = [];
		edges.forEach(function (e) {
			var key = e.a.pid + '|' + e.b.pid;
			if (e.self || seen[key] || !byPid[e.a.pid] || !byPid[e.b.pid]) return;
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

	function openGene(n, navigate) {
		if (typeof navigate === 'function') navigate('report', { type: 'Gene', id: n.id });
	}

	function geneLink(n, navigate) {
		var b = node('button', n.symbol, 'agr-link');
		b.type = 'button';
		b.addEventListener('click', function () { openGene(n, navigate); });
		return b;
	}

	function pmidCell(pmids) {
		var span = node('span');
		pmids.slice(0, PMID_SHOWN).forEach(function (p, i) {
			if (i) span.appendChild(document.createTextNode(', '));
			var a = node('a', p);
			a.href = PUBMED_URL + p;
			a.target = '_blank';
			a.rel = 'noopener';
			span.appendChild(a);
		});
		if (pmids.length > PMID_SHOWN) span.appendChild(document.createTextNode(' +' + (pmids.length - PMID_SHOWN) + ' more in the TSV'));
		return span;
	}

	function appendCell(tr, content) {
		var td = node('td');
		if (content && typeof content === 'object') td.appendChild(content);
		else td.textContent = content == null ? '' : String(content);
		tr.appendChild(td);
	}

	// The row at index focusRow, when given, is focusable so "Show more" can move focus to it.
	function buildTable(caption, heads, rows, focusRow) {
		var wrap = node('div', null, 'agr-table-wrap');
		var t = node('table', null, 'agr-table agr-table-sm');
		t.appendChild(node('caption', caption, 'agr-sr-only'));
		var headRow = node('tr');
		heads.forEach(function (h) {
			var th = node('th', h);
			th.setAttribute('scope', 'col');
			headRow.appendChild(th);
		});
		var thead = node('thead');
		thead.appendChild(headRow);
		var tbody = node('tbody');
		rows.forEach(function (cells, i) {
			var tr = node('tr');
			cells.forEach(function (c) { appendCell(tr, c); });
			if (i === focusRow) {
				tr.setAttribute('tabindex', '-1');
				wrap.focusTarget = tr;
			}
			tbody.appendChild(tr);
		});
		t.appendChild(thead);
		t.appendChild(tbody);
		wrap.appendChild(t);
		return wrap;
	}

	function edgeTable(groups, navigate, focusRow) {
		var rows = groups.map(function (g) {
			return [
				geneLink(g.a, navigate),
				g.self ? 'self' : geneLink(g.b, navigate),
				g.relation,
				g.pmids.length,
				g.methods.length ? g.methods.length + ': ' + g.methods.join('; ') : '',
				pmidCell(g.pmids)
			];
		});
		return buildTable('Interactions by gene pair and relation, most publications first',
			['Gene A', 'Gene B', 'Relation', 'Publications', 'Detection methods', 'PMID'], rows, focusRow);
	}

	function rankingTable(ranking, navigate) {
		var rows = ranking.slice(0, HUB_COUNT).map(function (r) {
			return [geneLink(r.node, navigate), r.degree];
		});
		return buildTable('Genes with the most interaction partners in the set', ['Gene', 'Interaction partners in set'], rows);
	}

	function svgNode(tag, attrs) {
		var e = document.createElementNS(SVG_NS, tag);
		Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
		return e;
	}

	function networkSvg(layout, navigate) {
		var half = SVG_SIZE / 2;
		var svg = svgNode('svg', {
			viewBox: '0 0 ' + SVG_SIZE + ' ' + SVG_SIZE,
			role: 'group',
			'aria-label': 'Interaction network of ' + layout.nodes.length + ' genes. The table of genes by number of partners lists the same genes.'
		});
		layout.links.forEach(function (l) {
			svg.appendChild(svgNode('line', { x1: l.from.x.toFixed(1), y1: l.from.y.toFixed(1), x2: l.to.x.toFixed(1), y2: l.to.y.toFixed(1), class: 'agr-edge' }));
		});
		layout.nodes.forEach(function (n, i) {
			var r = Math.min(3 + n.degree, 12);
			var open = function () { openGene(n.node, navigate); };
			if (n.self) svg.appendChild(svgNode('circle', { cx: n.x.toFixed(1), cy: n.y.toFixed(1), r: r + 3, class: 'agr-self' }));
			var c = svgNode('circle', {
				cx: n.x.toFixed(1), cy: n.y.toFixed(1), r: r, class: 'agr-node',
				tabindex: '0', role: 'link',
				'aria-label': n.node.symbol + ', ' + n.degree + ' partners' + (n.self ? ', interacts with itself' : '')
			});
			c.addEventListener('click', open);
			c.addEventListener('keydown', function (ev) {
				if (ev && (ev.key === 'Enter' || ev.key === ' ')) {
					if (ev.preventDefault) ev.preventDefault();
					open();
				}
			});
			var title = svgNode('title', {});
			title.textContent = n.node.symbol + ' (' + n.degree + ')';
			c.appendChild(title);
			svg.appendChild(c);
			if (i < LABEL_NODES) {
				var left = n.x < half;
				var label = svgNode('text', {
					x: (n.x + (left ? -(r + 4) : r + 4)).toFixed(1), y: (n.y + 3).toFixed(1),
					'text-anchor': left ? 'end' : 'start', class: 'agr-label', 'aria-hidden': 'true'
				});
				label.textContent = n.node.symbol;
				svg.appendChild(label);
			}
		});
		return svg;
	}

	function download(name, text, type) {
		var a = node('a');
		var blobUrl = null;
		if (typeof Blob === 'function' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
			blobUrl = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
			a.href = blobUrl;
		} else {
			a.href = 'data:' + type + ';charset=utf-8,' + encodeURIComponent(text);
		}
		a.download = name;
		document.body.appendChild(a);
		if (a.click) a.click();
		document.body.removeChild(a);
		if (blobUrl) setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 1000);
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

	function saveHubs(ctx, ids, status) {
		var title = (ctx.context.list && (ctx.context.list.title || ctx.context.list.name)) || 'gene set';
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
			var hubs = hubIds(ranking, HUB_COUNT);
			var status = node('span', null, 'agr-note');
			if (hubs.length >= MIN_HUBS) {
				bar.appendChild(button('Save hubs as list (' + hubs.length + ' genes)', function () { saveHubs(ctx, hubs, status); }));
			} else {
				status.textContent = 'Fewer than ' + MIN_HUBS + ' genes have 2 or more partners, so there are no hubs to save';
			}
			bar.appendChild(status);
		}
		return bar;
	}

	function selfCount(edges) {
		var seen = {};
		edges.forEach(function (e) { if (e.self) seen[e.a.pid] = true; });
		return Object.keys(seen).length;
	}

	function summaryText(edges, ranking) {
		var selfs = selfCount(edges);
		return pairCount(edges) + ' gene pairs, ' + edges.length + ' pair-method records, ' + ranking.length + ' genes with partners' +
			(selfs ? ', ' + selfs + ' with self-interactions' : '');
	}

	function renderNetwork(wrap, ctx, all) {
		var filter = { relation: '', method: '' };
		var shown = PAGE_ROWS;
		var view = node('div');
		var summary = node('p', null, 'agr-note alliance-set-interactions-summary');
		summary.setAttribute('aria-live', 'polite');
		var filters = node('div', null, 'agr-filters');
		filters.appendChild(select('Relation', distinctValues(all, 'relation'), function (v) { filter.relation = v; shown = PAGE_ROWS; draw(); }));
		filters.appendChild(select('Detection method', distinctValues(all, 'method'), function (v) { filter.method = v; shown = PAGE_ROWS; draw(); }));
		wrap.appendChild(filters);
		wrap.appendChild(summary);
		wrap.appendChild(view);

		function draw(focusFrom) {
			var edges = filterEdges(all, filter);
			var ranking = degreeRanking(edges);
			clear(view);
			summary.textContent = summaryText(edges, ranking);
			if (!edges.length) {
				view.appendChild(node('p', 'No edges match the filters', 'agr-empty'));
				return;
			}
			var groups = groupEdges(edges);
			view.appendChild(actions(ctx, edges, ranking));
			if (ranking.length) {
				view.appendChild(node('h4', 'Genes by number of partners'));
				view.appendChild(rankingTable(ranking, ctx.navigate));
				view.appendChild(node('h4', 'Network (top ' + Math.min(MAX_NODES, ranking.length) + ' genes by degree)'));
				view.appendChild(networkSvg(circularLayout(edges, MAX_NODES), ctx.navigate));
			}
			view.appendChild(node('h4', 'Interactions'));
			var table = edgeTable(groups.slice(0, shown), ctx.navigate, focusFrom);
			view.appendChild(table);
			if (focusFrom !== undefined && table.focusTarget && table.focusTarget.focus) table.focusTarget.focus();
			if (groups.length > shown) {
				view.appendChild(button('Show more (' + (groups.length - shown) + ' left)', function () {
					var from = shown;
					shown += PAGE_ROWS;
					draw(from);
				}));
			}
		}
		draw();
	}

	function idsOf(entity) {
		var raw = entity && entity.Gene && entity.Gene.value;
		if (raw === undefined || raw === null || raw === '') return [];
		return Array.isArray(raw) ? raw : [raw];
	}

	function errorText(err) {
		if (err && err.status === 429) return 'The mine is busy (HTTP 429) and did not answer after ' + MAX_TRIES + ' attempts.';
		if (err && err.status) return 'The mine returned HTTP ' + err.status + '.';
		if (err && err.name === 'AbortError') return 'The mine did not answer within ' + Math.round(settings.timeoutMs / 1000) + ' s.';
		return 'Could not reach the mine.';
	}

	function showError(wrap, err, retry) {
		var box = node('p', 'Could not load interactions. ' + errorText(err) + ' ', 'agr-error');
		box.setAttribute('role', 'alert');
		box.appendChild(button('Retry', retry));
		wrap.appendChild(box);
	}

	function explainEmpty(wrap, rootUrl, ids, stale) {
		var plain = 'No interactions among these genes';
		return fetchInteractingCount(rootUrl, ids).then(
			function (n) {
				if (stale()) return;
				wrap.appendChild(node('p', n === 0
					? plain + '. None of the ' + ids.length + ' genes has interaction data in AllianceMine. Move to a human or mouse list with the orthologs tool for better coverage.'
					: plain + '. ' + n + ' of ' + ids.length + ' genes have interaction data in AllianceMine, none of them with another gene in this set.', 'agr-empty'));
			},
			function () {
				if (stale()) return;
				wrap.appendChild(node('p', plain, 'agr-empty'));
			}
		);
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
		fetchRows(service.root, buildSetQuery(ids))
			.then(function (result) {
				if (stale()) return;
				clear(wrap);
				if (result.truncated) {
					var warn = node('p', 'Only the first ' + MAX_ROWS + ' interaction rows were loaded, so the network is incomplete. Use a smaller list.', 'agr-warning');
					warn.setAttribute('role', 'alert');
					wrap.appendChild(warn);
				}
				var edges = buildEdges(result.rows);
				if (!edges.length) return explainEmpty(wrap, service.root, ids, stale);
				renderNetwork(wrap, { navigate: navigate, context: context }, edges);
			})
			.catch(function (err) {
				if (stale()) return;
				console.error('set-interactions: query failed', err);
				clear(wrap);
				showError(wrap, err, function () { main(el, service, imEntity, state, config, navigate, context); });
			});
	}

	var api = {
		main: main,
		buildSetQuery: buildSetQuery,
		buildEdges: buildEdges,
		filterEdges: filterEdges,
		degreeRanking: degreeRanking,
		groupEdges: groupEdges,
		hubIds: hubIds,
		settings: settings,
		toSif: toSif,
		toTsv: toTsv,
		circularLayout: circularLayout
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceSetInteractions = api;
})(typeof window !== 'undefined' ? window : globalThis);
