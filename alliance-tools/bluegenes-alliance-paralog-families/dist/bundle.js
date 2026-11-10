/*
 * Paralog families in this list, a BlueGenes tool (tool API version 2).
 * Plain JavaScript without dependencies, so this file is both the source and
 * the bundle. BlueGenes loads it as a script and calls
 * bluegenesAllianceParalogFamilies.main(el, service, entity, state, config, navigate).
 *
 * Two list genes are linked when Gene.paralogues holds a row between them with
 * identity >= the threshold (and rank <= the rank limit, when set). Families are the
 * connected components of those links (union-find). "Keep one per family" keeps the
 * member with the most disease plus phenotype annotation rows, ties broken by the
 * first symbol in alphabetical order.
 */
(function (root) {
	'use strict';

	// BlueGenes passes the mine root (for example https://host/mine); the web
	// services live under /service. Accept either form.
	function serviceRoot(root) {
		var r = String(root || '').replace(/\/+$/, '');
		return /\/service$/.test(r) ? r : r + '/service';
	}

	var MAX_ROWS = 200000;
	var DEFAULT_IDENTITY = 40;
	var DOMINANT_SHARE = 0.2;

	// ---- pure logic ----

	// Union-find over string or number keys, with path compression and union by size.
	function createUnionFind(keys) {
		var parent = {};
		var size = {};
		(keys || []).forEach(function (k) {
			parent[k] = k;
			size[k] = 1;
		});
		function find(k) {
			if (!(k in parent)) {
				parent[k] = k;
				size[k] = 1;
			}
			var r = k;
			while (parent[r] !== r) r = parent[r];
			while (parent[k] !== r) {
				var next = parent[k];
				parent[k] = r;
				k = next;
			}
			return r;
		}
		function union(a, b) {
			var ra = find(a);
			var rb = find(b);
			if (ra === rb) return false;
			if (size[ra] < size[rb]) {
				var t = ra;
				ra = rb;
				rb = t;
			}
			parent[rb] = ra;
			size[ra] += size[rb];
			return true;
		}
		return { find: find, union: union };
	}

	function bySymbol(a, b) {
		var x = String(a.symbol || a.primaryIdentifier || a.id);
		var y = String(b.symbol || b.primaryIdentifier || b.id);
		return x < y ? -1 : x > y ? 1 : 0;
	}

	/*
	 * genes: [{ id, primaryIdentifier, symbol, organism }]
	 * links: [{ a, b, identity, similarity, rank }] between gene ids, any direction
	 * opts: { minIdentity, maxRank }; maxRank null or undefined means no limit
	 * Returns clusters with 2 or more genes, largest first:
	 *   { members: [gene], links: [{ a, b, identity, rank }] }
	 * A pair seen in both directions keeps its highest identity and lowest rank.
	 */
	function buildClusters(genes, links, opts) {
		var minIdentity = opts && isFinite(opts.minIdentity) ? Number(opts.minIdentity) : DEFAULT_IDENTITY;
		var maxRank = opts && opts.maxRank != null && isFinite(opts.maxRank) ? Number(opts.maxRank) : Infinity;
		var byId = {};
		genes.forEach(function (g) { byId[g.id] = g; });
		var uf = createUnionFind(genes.map(function (g) { return g.id; }));
		var pairs = {};
		links.forEach(function (l) {
			if (l.a === l.b || !byId[l.a] || !byId[l.b]) return;
			if (!(Number(l.identity) >= minIdentity)) return;
			if (l.rank != null && Number(l.rank) > maxRank) return;
			var key = l.a < l.b ? l.a + '|' + l.b : l.b + '|' + l.a;
			var p = pairs[key];
			var rank = l.rank == null ? null : Number(l.rank);
			if (!p) {
				pairs[key] = { a: l.a, b: l.b, identity: Number(l.identity), rank: rank };
				return;
			}
			p.identity = Math.max(p.identity, Number(l.identity));
			if (rank != null) p.rank = p.rank == null ? rank : Math.min(p.rank, rank);
		});
		var pairList = Object.keys(pairs).map(function (k) { return pairs[k]; });
		pairList.forEach(function (p) { uf.union(p.a, p.b); });
		var groups = {};
		genes.forEach(function (g) {
			var r = uf.find(g.id);
			(groups[r] = groups[r] || { members: [], links: [] }).members.push(g);
		});
		pairList.forEach(function (p) {
			groups[uf.find(p.a)].links.push(p);
		});
		return Object.keys(groups)
			.map(function (k) { return groups[k]; })
			.filter(function (c) { return c.members.length >= 2; })
			.map(function (c) {
				c.members.sort(bySymbol);
				c.links.sort(function (x, y) { return y.identity - x.identity; });
				return c;
			})
			.sort(function (x, y) { return y.members.length - x.members.length || bySymbol(x.members[0], y.members[0]); });
	}

	// The member kept for a family: most annotations, then first by symbol. counts maps gene id to a number.
	function pickRepresentative(cluster, counts) {
		var best = null;
		cluster.members.forEach(function (g) {
			var c = (counts && counts[g.id]) || 0;
			if (!best || c > best.c) best = { g: g, c: c };
		});
		return best.g;
	}

	// The list genes with one gene kept per cluster. Input order is kept.
	function reduceList(genes, clusters, counts) {
		var drop = {};
		clusters.forEach(function (c) {
			var keep = pickRepresentative(c, counts);
			c.members.forEach(function (g) { if (g.id !== keep.id) drop[g.id] = true; });
		});
		return genes.filter(function (g) { return !drop[g.id]; });
	}

	// Largest cluster as a share of the list, or 0.
	function dominantShare(clusters, n) {
		if (!clusters.length || !n) return 0;
		return clusters[0].members.length / n;
	}

	// ---- queries ----

	function escapeXml(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function oneOf(path, values) {
		return (
			'<constraint path="' + path + '" op="ONE OF">' +
			values.map(function (v) { return '<value>' + escapeXml(v) + '</value>'; }).join('') +
			'</constraint>'
		);
	}

	function query(view, constraints) {
		return '<query model="genomic" view="' + view.join(' ') + '">' + constraints.join('') + '</query>';
	}

	var P = 'Gene.paralogues';

	function genesQuery(ids) {
		return query(['Gene.id', 'Gene.primaryIdentifier', 'Gene.symbol', 'Gene.organism.shortName'], [oneOf('Gene.id', ids)]);
	}

	// Paralogue rows between two list genes, all identities; the threshold is applied in the browser.
	function linksQuery(ids) {
		return query(
			['Gene.id', P + '.paralogue.id', P + '.identity', P + '.similarity', P + '.rank'],
			[oneOf('Gene.id', ids), oneOf(P + '.paralogue.id', ids)]
		);
	}

	// List genes with at least one paralogue row, to report which organisms carry paralogue data.
	function coverageQuery(ids) {
		return query(
			['Gene.id', 'Gene.organism.shortName'],
			[oneOf('Gene.id', ids), '<constraint path="' + P + '.id" op="IS NOT NULL"/>']
		);
	}

	function annotationQuery(ids, collection) {
		return query(['Gene.id', 'Gene.' + collection + '.id'], [oneOf('Gene.id', ids)]);
	}

	// The id lists go in a POST body: a GET query string fails above about 250 ids.
	function post(sr, params) {
		var body = Object.keys(params)
			.map(function (k) { return k + '=' + encodeURIComponent(params[k]); })
			.join('&');
		return fetch(sr.replace(/\/+$/, '') + '/query/results', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: body
		}).then(function (res) {
			if (!res.ok) throw new Error('HTTP ' + res.status);
			return res.json();
		});
	}

	function rows(sr, q) {
		return post(sr, { format: 'json', size: MAX_ROWS, query: q }).then(function (j) {
			return (j && j.results) || [];
		});
	}

	function load(sr, ids) {
		return Promise.all([rows(sr, genesQuery(ids)), rows(sr, linksQuery(ids)), rows(sr, coverageQuery(ids))]).then(function (res) {
			var genes = res[0].map(function (r) {
				return { id: r[0], primaryIdentifier: r[1], symbol: r[2], organism: r[3] };
			});
			var links = res[1].map(function (r) {
				return { a: r[0], b: r[1], identity: r[2], similarity: r[3], rank: r[4] };
			});
			var orgSet = {};
			genes.forEach(function (g) { if (g.organism) orgSet[g.organism] = true; });
			var covSet = {};
			res[2].forEach(function (r) { if (r[1]) covSet[r[1]] = true; });
			return {
				genes: genes,
				links: links,
				organisms: Object.keys(orgSet).sort(),
				paralogueOrganisms: Object.keys(covSet).sort(),
				capped: res[0].length >= MAX_ROWS || res[1].length >= MAX_ROWS || res[2].length >= MAX_ROWS
			};
		});
	}

	// Disease plus phenotype annotation rows per gene id, for the given genes only.
	function loadAnnotationCounts(sr, ids) {
		if (!ids.length) return Promise.resolve({});
		return Promise.all([
			rows(sr, annotationQuery(ids, 'diseaseAnnotation')),
			rows(sr, annotationQuery(ids, 'phenotypeAnnotations'))
		]).then(function (res) {
			var counts = {};
			res[0].concat(res[1]).forEach(function (r) { counts[r[0]] = (counts[r[0]] || 0) + 1; });
			return counts;
		});
	}

	// ---- rendering ----

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
		var wrap = node('div', null, 'alliance-paralog-families');
		wrap.appendChild(node('span', text));
		el.appendChild(wrap);
	}

	function label(g) {
		return g.symbol || g.primaryIdentifier || String(g.id);
	}

	function copyText(text, onDone) {
		var nav = typeof navigator !== 'undefined' ? navigator : null;
		if (nav && nav.clipboard && nav.clipboard.writeText) {
			nav.clipboard.writeText(text).then(function () { onDone(true); }, function () { onDone(false); });
		} else {
			onDone(false);
		}
	}

	function renderClusters(wrap, clusters, navigate) {
		clusters.forEach(function (c, i) {
			var box = node('div', null, 'alliance-paralog-families-cluster');
			box.appendChild(node('h5', 'Family ' + (i + 1) + ': ' + c.members.length + ' genes'));
			var ul = node('ul');
			c.members.forEach(function (g) {
				var li = node('li');
				var a = node('a', label(g));
				a.href = '#';
				a.title = g.primaryIdentifier || '';
				a.addEventListener('click', function (ev) {
					if (ev && ev.preventDefault) ev.preventDefault();
					if (typeof navigate === 'function') navigate('report', { type: 'Gene', id: g.id });
				});
				li.appendChild(a);
				li.appendChild(document.createTextNode(g.organism ? ' (' + g.organism + ')' : ''));
				ul.appendChild(li);
			});
			box.appendChild(ul);
			var byId = {};
			c.members.forEach(function (g) { byId[g.id] = g; });
			var lul = node('ul', null, 'alliance-paralog-families-links');
			c.links.forEach(function (l) {
				lul.appendChild(
					node('li', label(byId[l.a]) + ' - ' + label(byId[l.b]) + ': identity ' + l.identity + (l.rank != null ? ', rank ' + l.rank : ''))
				);
			});
			box.appendChild(lul);
			wrap.appendChild(box);
		});
	}

	function showReduced(out, ctx, reduced, withAnnotations) {
		clear(out);
		var text = reduced.map(function (g) { return g.primaryIdentifier || g.id; }).join('\n');
		out.appendChild(
			node(
				'p',
				'Reduced list: ' + reduced.length + ' of ' + ctx.data.genes.length + ' genes. Kept per family: ' +
					(withAnnotations
						? 'the member with the most disease plus phenotype annotation rows, first by symbol on ties.'
						: 'the first member by symbol (annotation counts unavailable).')
			)
		);
		var area = node('textarea');
		area.readOnly = true;
		area.rows = Math.min(10, Math.max(2, reduced.length));
		area.value = text;
		out.appendChild(area);
		var status = node('span');
		var copy = node('button', 'Copy');
		copy.type = 'button';
		copy.addEventListener('click', function () {
			copyText(text, function (ok) { status.textContent = ok ? ' Copied' : ' Copy failed, select the text above'; });
		});
		out.appendChild(copy);
		out.appendChild(status);
		if (typeof ctx.navigate === 'function') {
			var open = node('button', 'Open reduced list as query');
			open.type = 'button';
			open.addEventListener('click', function () {
				ctx.navigate('query', {
					from: 'Gene',
					select: ['Gene.primaryIdentifier', 'Gene.symbol', 'Gene.organism.shortName'],
					where: [{ path: 'Gene.id', op: 'ONE OF', values: reduced.map(function (g) { return String(g.id); }) }]
				});
			});
			out.appendChild(open);
		}
	}

	function render(el, ctx, state) {
		clear(el);
		var data = ctx.data;
		var wrap = node('div', null, 'alliance-paralog-families');

		var controls = node('div', null, 'alliance-paralog-families-options');
		var idLabel = node('label', 'Minimum identity (%) ');
		var slider = node('input');
		slider.type = 'range';
		slider.min = '0';
		slider.max = '100';
		slider.step = '1';
		slider.value = String(state.minIdentity);
		idLabel.appendChild(slider);
		idLabel.appendChild(node('span', ' ' + state.minIdentity));
		controls.appendChild(idLabel);
		var rankLabel = node('label', ' Max rank (empty for no limit) ');
		var rankInput = node('input');
		rankInput.type = 'number';
		rankInput.min = '1';
		rankInput.step = '1';
		rankInput.value = state.maxRank == null ? '' : String(state.maxRank);
		rankLabel.appendChild(rankInput);
		controls.appendChild(rankLabel);
		wrap.appendChild(controls);

		function update() {
			var v = parseInt(slider.value, 10);
			state.minIdentity = isFinite(v) && v >= 0 && v <= 100 ? v : DEFAULT_IDENTITY;
			var r = parseInt(rankInput.value, 10);
			state.maxRank = isFinite(r) && r >= 1 ? r : null;
			render(el, ctx, state);
		}
		slider.addEventListener('change', update);
		rankInput.addEventListener('change', update);

		var clusters = buildClusters(data.genes, data.links, state);
		var share = dominantShare(clusters, data.genes.length);

		wrap.appendChild(
			node(
				'p',
				clusters.length + ' paralog families with 2 or more list genes (identity >= ' + state.minIdentity +
					(state.maxRank ? ', rank <= ' + state.maxRank : '') + '). List: ' + data.genes.length + ' genes.',
				'alliance-paralog-families-summary'
			)
		);
		wrap.appendChild(
			node(
				'p',
				'Paralogue data found for: ' + (data.paralogueOrganisms.length ? data.paralogueOrganisms.join(', ') : 'no organism') +
					'. List organisms: ' + data.organisms.join(', ') +
					'. Paralogue data covers only some organisms in this mine, so genes of the others stay single.',
				'alliance-paralog-families-coverage'
			)
		);
		if (data.capped) wrap.appendChild(node('p', 'Result limit reached, families may be incomplete.'));
		if (share > DOMINANT_SHARE) {
			wrap.appendChild(
				node(
					'p',
					'Warning: the largest family holds ' + clusters[0].members.length + ' of ' + data.genes.length +
						' list genes (' + Math.round(share * 100) + '%, over ' + Math.round(DOMINANT_SHARE * 100) +
						'%). One gene family may dominate this list.',
					'alliance-paralog-families-warning'
				)
			);
		}

		if (!clusters.length) {
			wrap.appendChild(node('p', 'No paralog families at this threshold'));
			el.appendChild(wrap);
			return;
		}

		renderClusters(wrap, clusters, ctx.navigate);

		var keepBtn = node('button', 'Keep one per family');
		keepBtn.type = 'button';
		wrap.appendChild(keepBtn);
		var out = node('div', null, 'alliance-paralog-families-reduced');
		wrap.appendChild(out);
		var runToken = 0;
		keepBtn.addEventListener('click', function () {
			var mine = ++runToken;
			clear(out);
			out.appendChild(node('span', 'Counting annotations...'));
			var ids = [];
			clusters.forEach(function (c) { c.members.forEach(function (g) { ids.push(g.id); }); });
			ctx.loadCounts(ids)
				.then(function (counts) {
					if (mine === runToken) showReduced(out, ctx, reduceList(data.genes, clusters, counts), true);
				})
				.catch(function (err) {
					console.error('Annotation counts failed', err);
					if (mine === runToken) showReduced(out, ctx, reduceList(data.genes, clusters, null), false);
				});
		});

		el.appendChild(wrap);
	}

	function main(el, service, imEntity, state, config, navigate) {
		if (!el || !service || !imEntity) {
			throw new Error('Call main with correct signature');
		}
		// main runs again on every entity change; a response for an older entity must not overwrite the newer one.
		var token = (el.__agrParalogReq = (el.__agrParalogReq || 0) + 1);
		var gene = imEntity.Gene;
		var ids = gene && gene.value;
		var list = (Array.isArray(ids) ? ids : [ids]).filter(function (v) {
			return v !== undefined && v !== null && v !== '';
		});
		if (!list.length) {
			message(el, 'No genes to analyse');
			return;
		}
		var sr = serviceRoot(service.root);
		message(el, 'Loading...');
		load(sr, list)
			.then(function (data) {
				if (el.__agrParalogReq !== token) return;
				if (!data.genes.length) {
					message(el, 'No genes found for this list');
					return;
				}
				render(
					el,
					{
						data: data,
						navigate: navigate,
						loadCounts: function (cids) { return loadAnnotationCounts(sr, cids); }
					},
					{ minIdentity: DEFAULT_IDENTITY, maxRank: null }
				);
			})
			.catch(function (err) {
				console.error('Paralog families failed', err);
				if (el.__agrParalogReq !== token) return;
				message(el, 'Could not load paralogue data from the mine');
			});
	}

	var api = {
		main: main,
		serviceRoot: serviceRoot,
		createUnionFind: createUnionFind,
		buildClusters: buildClusters,
		pickRepresentative: pickRepresentative,
		reduceList: reduceList,
		dominantShare: dominantShare,
		escapeXml: escapeXml,
		genesQuery: genesQuery,
		linksQuery: linksQuery,
		coverageQuery: coverageQuery,
		annotationQuery: annotationQuery,
		render: render
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceParalogFamilies = api;
})(typeof window !== 'undefined' ? window : globalThis);
