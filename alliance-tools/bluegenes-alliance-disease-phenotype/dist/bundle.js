/*
 * Alliance disease and phenotype, a BlueGenes tool (tool API version 2).
 * Plain JavaScript without dependencies, so this file is both the source and
 * the bundle. BlueGenes loads it as a script and calls
 * bluegenesAllianceDiseasePhenotype.main(el, service, entity, state, config, navigate).
 */
(function (root) {
	'use strict';

	// BlueGenes passes the mine root (for example https://host/mine); the web
	// services live under /service. Accept either form.
	function serviceRoot(root) {
		var r = String(root || '').replace(/\/+$/, '');
		return /\/service$/.test(r) ? r : r + '/service';
	}

	var COLLAPSE_AFTER = 25;
	var MAX_ROWS = 20000;
	var MAX_PUBS_SHOWN = 5;
	var DOID_URL = 'https://disease-ontology.org/?id=';
	var PUBMED_URL = 'https://pubmed.ncbi.nlm.nih.gov/';

	// ---- queries -------------------------------------------------------

	function escapeXml(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function idConstraint(ids) {
		if (ids.length === 1) {
			return '<constraint path="Gene.id" op="=" value="' + escapeXml(ids[0]) + '"/>';
		}
		return (
			'<constraint path="Gene.id" op="ONE OF">' +
			ids
				.map(function (id) {
					return '<value>' + escapeXml(id) + '</value>';
				})
				.join('') +
			'</constraint>'
		);
	}

	// No sortOrder: InterMine rejects ordering by a path inside an outer join group; rows are sorted client-side.
	function buildQuery(view, outerJoins, ids) {
		return (
			'<query model="genomic" view="' +
			view.join(' ') +
			'">' +
			outerJoins
				.map(function (p) {
					return '<join path="' + p + '" style="OUTER"/>';
				})
				.join('') +
			idConstraint(ids) +
			'</query>'
		);
	}

	var DISEASE_VIEW = [
		'Gene.id',
		'Gene.primaryIdentifier',
		'Gene.symbol',
		'Gene.diseaseAnnotation.id',
		'Gene.diseaseAnnotation.ontologyTerm.identifier',
		'Gene.diseaseAnnotation.ontologyTerm.name',
		'Gene.diseaseAnnotation.qualifier',
		'Gene.diseaseAnnotation.evidence.code.code',
		'Gene.diseaseAnnotation.dataSets.name'
	];
	var PHENOTYPE_VIEW = [
		'Gene.id',
		'Gene.primaryIdentifier',
		'Gene.symbol',
		'Gene.phenotypeAnnotations.id',
		'Gene.phenotypeAnnotations.phenotypeStatement',
		'Gene.phenotypeAnnotations.publications.pubMedId'
	];

	function buildDiseaseQuery(ids) {
		return buildQuery(
			DISEASE_VIEW,
			[
				'Gene.diseaseAnnotation',
				'Gene.diseaseAnnotation.ontologyTerm',
				'Gene.diseaseAnnotation.evidence',
				'Gene.diseaseAnnotation.evidence.code',
				'Gene.diseaseAnnotation.dataSets'
			],
			ids
		);
	}

	function buildPhenotypeQuery(ids) {
		return buildQuery(
			PHENOTYPE_VIEW,
			['Gene.phenotypeAnnotations', 'Gene.phenotypeAnnotations.publications'],
			ids
		);
	}

	// Entity value is one internal id on a report page and an array on a list page.
	function entityIds(imEntity) {
		var gene = imEntity && imEntity.Gene;
		var value = gene && gene.value;
		if (!Array.isArray(value)) value = [value];
		var seen = {};
		return value.filter(function (v) {
			if (v === undefined || v === null || v === '' || seen[v]) return false;
			seen[v] = true;
			return true;
		});
	}

	function fetchRows(serviceRoot, queryXml) {
		var body =
			'format=json&size=' + MAX_ROWS + '&query=' + encodeURIComponent(queryXml);
		return fetch(serviceRoot.replace(/\/+$/, '') + '/query/results', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: body
		})
			.then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status);
				return res.json();
			})
			.then(function (json) {
				return (json && json.results) || [];
			});
	}

	// ---- grouping ------------------------------------------------------

	function addUnique(list, value) {
		if (value !== null && value !== undefined && value !== '' && list.indexOf(value) === -1) {
			list.push(value);
		}
	}

	// Rows are annotation x evidence x dataset. Collapse them to one record per annotation id.
	function annotationsFrom(rows, build, merge) {
		var byId = {};
		var order = [];
		rows.forEach(function (row) {
			var key = row[0] + '|' + row[3];
			if (row[3] === null || row[3] === undefined) return;
			if (!byId[key]) {
				byId[key] = build(row);
				order.push(key);
			}
			merge(byId[key], row);
		});
		return order.map(function (k) {
			return byId[k];
		});
	}

	// One group per gene + term + qualifier + evidence code set; count is the number of annotations.
	function groupDisease(rows) {
		var annotations = annotationsFrom(
			rows,
			function (r) {
				return {
					geneId: r[0],
					primaryIdentifier: r[1],
					symbol: r[2],
					termId: r[4],
					termName: r[5],
					qualifier: r[6],
					codes: [],
					sources: []
				};
			},
			function (a, r) {
				addUnique(a.codes, r[7]);
				addUnique(a.sources, r[8]);
			}
		);
		var groups = {};
		var order = [];
		annotations.forEach(function (a) {
			a.codes.sort();
			var key = [a.geneId, a.termId, a.qualifier, a.codes.join(',')].join('|');
			if (!groups[key]) {
				groups[key] = {
					geneId: a.geneId,
					primaryIdentifier: a.primaryIdentifier,
					symbol: a.symbol,
					termId: a.termId,
					termName: a.termName,
					qualifier: a.qualifier,
					codes: a.codes,
					sources: [],
					count: 0
				};
				order.push(key);
			}
			groups[key].count += 1;
			a.sources.forEach(function (s) {
				addUnique(groups[key].sources, s);
			});
		});
		var list = order.map(function (k) {
			groups[k].sources.sort();
			return groups[k];
		});
		return sortGroups(list, function (g) {
			return g.termName || g.termId || '';
		});
	}

	// One group per gene + phenotype statement; count is the number of annotations.
	function groupPhenotype(rows) {
		var annotations = annotationsFrom(
			rows,
			function (r) {
				return {
					geneId: r[0],
					primaryIdentifier: r[1],
					symbol: r[2],
					statement: r[4],
					pubs: []
				};
			},
			function (a, r) {
				addUnique(a.pubs, r[5]);
			}
		);
		var groups = {};
		var order = [];
		annotations.forEach(function (a) {
			var key = a.geneId + '|' + a.statement;
			if (!groups[key]) {
				groups[key] = {
					geneId: a.geneId,
					primaryIdentifier: a.primaryIdentifier,
					symbol: a.symbol,
					statement: a.statement,
					pubs: [],
					count: 0
				};
				order.push(key);
			}
			groups[key].count += 1;
			a.pubs.forEach(function (p) {
				addUnique(groups[key].pubs, p);
			});
		});
		var list = order.map(function (k) {
			return groups[k];
		});
		return sortGroups(list, function (g) {
			return g.statement || '';
		});
	}

	function sortGroups(list, label) {
		return list.slice().sort(function (a, b) {
			var ga = a.symbol || a.primaryIdentifier || '';
			var gb = b.symbol || b.primaryIdentifier || '';
			if (ga !== gb) return ga < gb ? -1 : 1;
			var la = String(label(a)).toLowerCase();
			var lb = String(label(b)).toLowerCase();
			if (la !== lb) return la < lb ? -1 : 1;
			return 0;
		});
	}

	// ---- DOM -----------------------------------------------------------

	function clear(node) {
		while (node.firstChild) node.removeChild(node.firstChild);
	}

	function make(tag, className, text) {
		var node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined && text !== null) node.textContent = text;
		return node;
	}

	function link(href, text) {
		var a = make('a', null, text);
		a.href = href;
		a.target = '_blank';
		a.rel = 'noopener';
		return a;
	}

	function doidHref(id) {
		return /^DOID:\d+$/.test(id) ? DOID_URL + encodeURIComponent(id).replace(/%3A/gi, ':') : null;
	}

	function pubmedHref(id) {
		return /^\d+$/.test(String(id)) ? PUBMED_URL + String(id) + '/' : null;
	}

	function geneLabel(g) {
		return g.symbol || g.primaryIdentifier || String(g.geneId);
	}

	function appendCell(tr, content) {
		var td = make('td');
		if (typeof content === 'string') {
			td.textContent = content;
		} else if (content) {
			td.appendChild(content);
		}
		tr.appendChild(td);
	}

	function diseaseCells(g, showGene) {
		var cells = [];
		if (showGene) cells.push(geneLabel(g));
		var term = make('span');
		var href = doidHref(g.termId);
		term.appendChild(href ? link(href, g.termName || g.termId) : make('span', null, g.termName || g.termId || ''));
		if (href && g.termName) term.appendChild(make('small', 'text-muted', ' ' + g.termId));
		cells.push(term);
		cells.push(g.qualifier ? g.qualifier.replace(/_/g, ' ') : '');
		cells.push(g.codes.join(', '));
		cells.push(g.sources.join(', '));
		cells.push(String(g.count));
		return cells;
	}

	function phenotypeCells(g, showGene) {
		var cells = [];
		if (showGene) cells.push(geneLabel(g));
		cells.push(g.statement || '');
		var pubs = make('span');
		g.pubs.slice(0, MAX_PUBS_SHOWN).forEach(function (p, i) {
			if (i > 0) pubs.appendChild(make('span', null, ', '));
			var href = pubmedHref(p);
			pubs.appendChild(href ? link(href, 'PMID:' + p) : make('span', null, String(p)));
		});
		if (g.pubs.length > MAX_PUBS_SHOWN) {
			pubs.appendChild(make('span', null, ' +' + (g.pubs.length - MAX_PUBS_SHOWN) + ' more'));
		}
		cells.push(pubs);
		cells.push(String(g.count));
		return cells;
	}

	function renderTable(groups, headers, cellsFor, showGene, limit) {
		var table = make('table', 'table table-condensed table-striped');
		var headRow = make('tr');
		(showGene ? ['Gene'].concat(headers) : headers).forEach(function (h) {
			headRow.appendChild(make('th', null, h));
		});
		var thead = make('thead');
		thead.appendChild(headRow);
		table.appendChild(thead);
		var tbody = make('tbody');
		groups.slice(0, limit).forEach(function (g) {
			var tr = make('tr');
			cellsFor(g, showGene).forEach(function (c) {
				appendCell(tr, c);
			});
			tbody.appendChild(tr);
		});
		table.appendChild(tbody);
		return table;
	}

	function totalCount(groups) {
		return groups.reduce(function (n, g) {
			return n + g.count;
		}, 0);
	}

	// kind: { title, headers, cellsFor, empty }
	function renderSection(box, kind, groups, showGene, truncated) {
		function draw(expanded) {
			clear(box);
			box.appendChild(make('h4', null, kind.title + ' (' + totalCount(groups) + ')'));
			if (truncated) {
				box.appendChild(make('p', 'text-warning', 'Showing first ' + MAX_ROWS + ' rows, results are incomplete'));
			}
			if (groups.length === 0) {
				box.appendChild(make('p', 'text-muted', kind.empty));
				return;
			}
			var limit = expanded ? groups.length : COLLAPSE_AFTER;
			box.appendChild(renderTable(groups, kind.headers, kind.cellsFor, showGene, limit));
			if (!expanded && groups.length > COLLAPSE_AFTER) {
				var btn = make('button', 'btn btn-default btn-sm', 'Show all ' + groups.length + ' rows');
				btn.type = 'button';
				btn.addEventListener('click', function () {
					draw(true);
				});
				box.appendChild(btn);
			}
		}
		draw(false);
	}

	function showMessage(box, title, text) {
		clear(box);
		box.appendChild(make('h4', null, title));
		box.appendChild(make('p', 'text-muted', text));
	}

	var DISEASE_KIND = {
		title: 'Disease',
		headers: ['Disease', 'Association', 'Evidence', 'Source', 'Annotations'],
		cellsFor: diseaseCells,
		empty: 'No disease annotations',
		build: buildDiseaseQuery,
		group: groupDisease
	};
	var PHENOTYPE_KIND = {
		title: 'Phenotype',
		headers: ['Phenotype', 'Publications', 'Annotations'],
		cellsFor: phenotypeCells,
		empty: 'No phenotype annotations',
		build: buildPhenotypeQuery,
		group: groupPhenotype
	};

	function loadSection(el, token, box, kind, serviceRoot, ids) {
		showMessage(box, kind.title, 'Loading...');
		fetchRows(serviceRoot, kind.build(ids))
			.then(function (rows) {
				if (el.__agrReq !== token) return;
				renderSection(box, kind, kind.group(rows), ids.length > 1, rows.length >= MAX_ROWS);
			})
			.catch(function () {
				if (el.__agrReq !== token) return;
				showMessage(box, kind.title, 'Could not load ' + kind.title.toLowerCase() + ' annotations from the mine');
			});
	}

	function main(el, service, imEntity) {
		if (!el || !service || !imEntity) {
			throw new Error('Call main with correct signature');
		}
		// main runs again on every entity change; a response for an older entity must not overwrite the newer one.
		var token = (el.__agrReq = (el.__agrReq || 0) + 1);
		clear(el);
		var wrap = make('div', 'alliance-disease-phenotype');
		var diseaseBox = make('div', 'alliance-disease');
		var phenotypeBox = make('div', 'alliance-phenotype');
		wrap.appendChild(diseaseBox);
		wrap.appendChild(phenotypeBox);
		el.appendChild(wrap);
		var ids = entityIds(imEntity);
		if (ids.length === 0) {
			showMessage(diseaseBox, DISEASE_KIND.title, DISEASE_KIND.empty);
			showMessage(phenotypeBox, PHENOTYPE_KIND.title, PHENOTYPE_KIND.empty);
			return;
		}
		loadSection(el, token, diseaseBox, DISEASE_KIND, serviceRoot(service.root), ids);
		loadSection(el, token, phenotypeBox, PHENOTYPE_KIND, serviceRoot(service.root), ids);
	}

	var api = {
		main: main, serviceRoot: serviceRoot,
		entityIds: entityIds,
		buildDiseaseQuery: buildDiseaseQuery,
		buildPhenotypeQuery: buildPhenotypeQuery,
		groupDisease: groupDisease,
		groupPhenotype: groupPhenotype,
		COLLAPSE_AFTER: COLLAPSE_AFTER
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceDiseasePhenotype = api;
})(typeof window !== 'undefined' ? window : globalThis);
