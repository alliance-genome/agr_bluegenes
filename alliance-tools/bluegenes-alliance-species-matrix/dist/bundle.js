/*
 * Phenotypes and diseases across species, a BlueGenes tool (tool API version 2).
 * Plain JavaScript without dependencies, so this file is both the source and
 * the bundle. BlueGenes loads it as a script and calls
 * bluegenesAllianceSpeciesMatrix.main(el, service, entity, state, config, navigate).
 */
(function (root) {
	'use strict';

	// BlueGenes passes the mine root (for example https://host/mine); the web
	// services live under /service. Accept either form.
	function serviceRoot(root) {
		var r = String(root || '').replace(/\/+$/, '');
		return /\/service$/.test(r) ? r : r + '/service';
	}

	var MAX_GENES = 200;
	var CHUNK = 300;
	var MAX_DETAIL_ROWS = 500;
	var PAGE_SIZE = 100000;

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

	function query(view, extra) {
		return '<query model="genomic" view="' + view.join(' ') + '">' + extra + '</query>';
	}

	function organismsQuery() {
		return query(['Organism.shortName'], '');
	}

	function genesQuery(ids) {
		return query(
			['Gene.id', 'Gene.primaryIdentifier', 'Gene.symbol', 'Gene.organism.shortName'],
			oneOf('Gene.id', ids)
		);
	}

	function orthologsQuery(ids) {
		return query(
			['Homologue.gene.id', 'Homologue.homologue.id', 'Homologue.homologue.symbol',
				'Homologue.homologue.primaryIdentifier', 'Homologue.homologue.organism.shortName'],
			oneOf('Homologue.gene.id', ids)
		);
	}

	function phenotypesQuery(ids) {
		return query(
			['PhenotypeAnnotation.subject.id', 'PhenotypeAnnotation.phenotypeStatement'],
			oneOf('PhenotypeAnnotation.subject.id', ids)
		);
	}

	function diseasesQuery(ids) {
		return query(
			['DiseaseAnnotation.subject.id', 'DiseaseAnnotation.qualifier', 'DiseaseAnnotation.ontologyTerm.name'],
			oneOf('DiseaseAnnotation.subject.id', ids)
		);
	}

	function resultsUrl(serviceRoot) {
		return serviceRoot.replace(/\/+$/, '') + '/query/results';
	}

	// Queries go in a POST body: a GET query string fails above about 250 ids.
	function requestBody(q) {
		return 'format=json&size=' + PAGE_SIZE + '&query=' + encodeURIComponent(q);
	}

	function run(svc, q) {
		return fetch(resultsUrl(svc), {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: requestBody(q)
		})
			.then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status);
				return res.json();
			})
			.then(function (json) {
				return (json && json.results) || [];
			});
	}

	// Runs one query per chunk of ids and concatenates the rows.
	function runChunked(svc, build, ids) {
		var parts = [];
		for (var i = 0; i < ids.length; i += CHUNK) parts.push(ids.slice(i, i + CHUNK));
		return Promise.all(parts.map(function (p) { return run(svc, build(p)); })).then(function (all) {
			return [].concat.apply([], all);
		});
	}

	function isDirectDisease(qualifier) {
		var q = qualifier == null ? '' : String(qualifier);
		return !/_via_orthology$/.test(q) && q !== 'is_not_implicated_in';
	}

	function cmp(a, b) {
		a = a == null ? '' : String(a);
		b = b == null ? '' : String(b);
		return a < b ? -1 : a > b ? 1 : 0;
	}

	function label(g) {
		return g.symbol || g.identifier || String(g.id);
	}

	// genes: [{id, identifier, symbol, species}]; orthRows: [geneId, id, symbol, identifier, species];
	// phenoRows: [id, statement]; diseaseRows: [id, qualifier, term].
	// Returns {cells: {geneId: {species: {genes, phenotypes, diseases}}}, annotations: {id: {phenotypes, diseases}}}.
	function buildMatrix(genes, orthRows, phenoRows, diseaseRows) {
		var annotations = {};
		function ann(id) {
			return (annotations[id] = annotations[id] || { phenotypes: [], diseases: [] });
		}
		phenoRows.forEach(function (r) {
			ann(r[0]).phenotypes.push(r[1]);
		});
		diseaseRows.forEach(function (r) {
			if (isDirectDisease(r[1])) ann(r[0]).diseases.push({ term: r[2], qualifier: r[1] });
		});

		var cells = {};
		function addTo(geneId, species, target) {
			if (!species) return;
			var byGene = (cells[geneId] = cells[geneId] || {});
			var cell = (byGene[species] = byGene[species] || { genes: [], seen: {}, phenotypes: 0, diseases: 0 });
			if (cell.seen[target.id]) return;
			cell.seen[target.id] = true;
			cell.genes.push(target);
			var a = annotations[target.id];
			if (a) {
				cell.phenotypes += a.phenotypes.length;
				cell.diseases += a.diseases.length;
			}
		}
		genes.forEach(function (g) {
			addTo(g.id, g.species, { id: g.id, symbol: label(g) });
		});
		orthRows.forEach(function (r) {
			addTo(r[0], r[4], { id: r[1], symbol: r[2] || r[3] || String(r[1]) });
		});
		Object.keys(cells).forEach(function (gid) {
			Object.keys(cells[gid]).forEach(function (sp) {
				var c = cells[gid][sp];
				delete c.seen;
				c.genes.sort(function (a, b) { return cmp(a.symbol, b.symbol); });
			});
		});
		return { cells: cells, annotations: annotations };
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
		var wrap = node('div', null, 'alliance-species-matrix');
		wrap.appendChild(node('span', text));
		el.appendChild(wrap);
	}

	function shade(total, max) {
		if (!total || !max) return '';
		var alpha = 0.12 + 0.55 * (Math.log(1 + total) / Math.log(1 + max));
		return 'rgba(31, 119, 180, ' + alpha.toFixed(2) + ')';
	}

	function symbols(cell) {
		return cell.genes.map(function (g) { return g.symbol; }).join(', ');
	}

	function cellLabel(gene, species, cell) {
		if (!cell) return 'No ortholog of ' + gene + ' in ' + species;
		return (
			gene + ' in ' + species + ': ' + cell.phenotypes + ' phenotype annotations, ' +
			cell.diseases + ' direct disease annotations. Genes: ' + symbols(cell)
		);
	}

	function detailRows(cell, annotations) {
		var rows = [];
		cell.genes.forEach(function (g) {
			var a = annotations[g.id];
			if (!a) return;
			a.phenotypes.forEach(function (p) {
				rows.push({ symbol: g.symbol, kind: 'Phenotype', text: p, qualifier: '' });
			});
			a.diseases.forEach(function (d) {
				rows.push({ symbol: g.symbol, kind: 'Disease', text: d.term, qualifier: d.qualifier || '' });
			});
		});
		return rows;
	}

	function showDetail(box, gene, species, cell, annotations) {
		clear(box);
		box.appendChild(node('h4', gene + ' in ' + species));
		var rows = detailRows(cell, annotations);
		if (!rows.length) {
			box.appendChild(node('p', 'No annotations for ' + symbols(cell)));
			return;
		}
		if (rows.length > MAX_DETAIL_ROWS) {
			box.appendChild(node('p', 'Showing the first ' + MAX_DETAIL_ROWS + ' of ' + rows.length + ' annotations.'));
			rows = rows.slice(0, MAX_DETAIL_ROWS);
		}
		var table = node('table', null, 'table table-condensed table-striped');
		var tr = node('tr');
		['Gene', 'Type', 'Phenotype or disease', 'Qualifier'].forEach(function (h) { tr.appendChild(node('th', h)); });
		var thead = node('thead');
		thead.appendChild(tr);
		table.appendChild(thead);
		var tbody = node('tbody');
		rows.forEach(function (r) {
			var row = node('tr');
			[r.symbol, r.kind, r.text, r.qualifier].forEach(function (v) { row.appendChild(node('td', v)); });
			tbody.appendChild(row);
		});
		table.appendChild(tbody);
		box.appendChild(table);
	}

	function render(el, genes, species, model, totalGenes) {
		clear(el);
		var wrap = node('div', null, 'alliance-species-matrix');
		if (totalGenes > MAX_GENES) {
			wrap.appendChild(node('p', 'Showing the first ' + MAX_GENES + ' of ' + totalGenes + ' genes.'));
		}
		wrap.appendChild(
			node('p', 'Each cell: phenotype annotations / direct disease annotations, for the gene or its orthologs in that species. Click a cell to list them.')
		);

		var max = 0;
		genes.forEach(function (g) {
			species.forEach(function (sp) {
				var c = (model.cells[g.id] || {})[sp];
				if (c) max = Math.max(max, c.phenotypes + c.diseases);
			});
		});

		var detail = node('div', null, 'alliance-species-matrix-detail');
		var table = node('table', null, 'table table-condensed');
		var hr = node('tr');
		hr.appendChild(node('th', 'Gene'));
		species.forEach(function (sp) { hr.appendChild(node('th', sp)); });
		var thead = node('thead');
		thead.appendChild(hr);
		table.appendChild(thead);

		var tbody = node('tbody');
		genes.forEach(function (g) {
			var tr = node('tr');
			var name = label(g);
			tr.appendChild(node('td', name));
			species.forEach(function (sp) {
				var cell = (model.cells[g.id] || {})[sp];
				var td = node('td');
				var text = cellLabel(name, sp, cell);
				td.title = text;
				if (!cell) {
					td.textContent = '-';
					td.setAttribute('aria-label', text);
				} else {
					var btn = node('button', cell.phenotypes + ' / ' + cell.diseases, 'btn btn-link btn-xs');
					btn.type = 'button';
					btn.title = text;
					btn.setAttribute('aria-label', text);
					var bg = shade(cell.phenotypes + cell.diseases, max);
					if (bg) td.style.backgroundColor = bg;
					btn.addEventListener('click', function () {
						showDetail(detail, name, sp, cell, model.annotations);
					});
					td.appendChild(btn);
				}
				tr.appendChild(td);
			});
			tbody.appendChild(tr);
		});
		table.appendChild(tbody);
		wrap.appendChild(table);
		wrap.appendChild(detail);
		wrap.appendChild(
			node('p', 'Phenotype ontologies differ per species (MP, WBPhenotype, FBcv, ZP, HP), so phenotype counts are not directly comparable across columns. Disease counts exclude annotations via orthology and is_not_implicated_in.', 'alliance-species-matrix-note')
		);
		el.appendChild(wrap);
	}

	function load(svc, ids) {
		return Promise.all([
			run(svc, organismsQuery()),
			run(svc, genesQuery(ids)),
			runChunked(svc, orthologsQuery, ids)
		]).then(function (res) {
			var species = res[0].map(function (r) { return r[0]; }).filter(Boolean).sort(cmp);
			var genes = res[1]
				.map(function (r) { return { id: r[0], identifier: r[1], symbol: r[2], species: r[3] }; })
				.sort(function (a, b) { return cmp(label(a), label(b)); });
			var orthRows = res[2];
			var seen = {};
			var targets = [];
			genes.map(function (g) { return g.id; }).concat(orthRows.map(function (r) { return r[1]; })).forEach(function (id) {
				if (!seen[id]) {
					seen[id] = true;
					targets.push(id);
				}
			});
			return Promise.all([
				runChunked(svc, phenotypesQuery, targets),
				runChunked(svc, diseasesQuery, targets)
			]).then(function (ann) {
				return { species: species, genes: genes, model: buildMatrix(genes, orthRows, ann[0], ann[1]) };
			});
		});
	}

	function main(el, service, imEntity, state, config, navigate) {
		if (!el || !service || !imEntity) {
			throw new Error('Call main with correct signature');
		}
		// main runs again on every entity change; a response for an older entity must not overwrite the newer one.
		var token = (el.__agrMatrixReq = (el.__agrMatrixReq || 0) + 1);
		var gene = imEntity.Gene;
		var ids = gene && gene.value;
		var list = (Array.isArray(ids) ? ids : [ids]).filter(function (v) {
			return v !== undefined && v !== null && v !== '';
		});
		if (!list.length) {
			message(el, 'No genes to show');
			return;
		}
		var total = list.length;
		list = list.slice(0, MAX_GENES);
		message(el, 'Loading...');
		load(serviceRoot(service.root), list)
			.then(function (r) {
				if (el.__agrMatrixReq !== token) return;
				if (!r.genes.length) {
					message(el, 'No genes to show');
					return;
				}
				render(el, r.genes, r.species, r.model, total);
			})
			.catch(function (err) {
				console.error('Species matrix failed', err);
				if (el.__agrMatrixReq !== token) return;
				message(el, 'Could not load the species matrix from the mine');
			});
	}

	var api = {
		main: main,
		serviceRoot: serviceRoot,
		escapeXml: escapeXml,
		organismsQuery: organismsQuery,
		genesQuery: genesQuery,
		orthologsQuery: orthologsQuery,
		phenotypesQuery: phenotypesQuery,
		diseasesQuery: diseasesQuery,
		resultsUrl: resultsUrl,
		requestBody: requestBody,
		isDirectDisease: isDirectDisease,
		buildMatrix: buildMatrix,
		shade: shade,
		render: render
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceSpeciesMatrix = api;
})(typeof window !== 'undefined' ? window : globalThis);
