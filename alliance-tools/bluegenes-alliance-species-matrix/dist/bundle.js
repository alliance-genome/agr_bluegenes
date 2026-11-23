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
		return mineFetch(resultsUrl(svc), {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: requestBody(q)
		})
			.then(function (res) {
				if (!res.ok) {
					throw httpError(res);
				}
				return res.json();
			})
			.then(function (json) {
				return (json && json.results) || [];
			});
	}

	// HTTP 400 is the mine rejecting a path: its model lacks that data. Resolves to
	// null then; any other failure still rejects.
	function optional(promise) {
		return promise.catch(function (err) {
			if (err && err.status === 400) return null;
			throw err;
		});
	}

	// Runs one query per chunk of ids, one after another, and concatenates the rows.
	function runChunked(svc, build, ids) {
		var all = [];
		var chain = Promise.resolve();
		for (var i = 0; i < ids.length; i += CHUNK) {
			chain = chain.then(
				function (part) {
					return function () {
						return run(svc, build(part)).then(function (r) { all = all.concat(r); });
					};
				}(ids.slice(i, i + CHUNK))
			);
		}
		return chain.then(function () { return all; });
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
		var cls = text === 'Loading...' ? 'agr-loading' : /^Could not/.test(text) ? 'agr-error' : 'agr-empty';
		wrap.appendChild(statusNode(text, cls));
		el.appendChild(wrap);
	}

	// Heat class (agr-heat-1 to agr-heat-6) for a cell total on a log scale, '' for no annotations.
	function shade(total, max) {
		if (!total || !max) return '';
		var step = Math.ceil(6 * (Math.log(1 + total) / Math.log(1 + max)));
		return 'agr-heat-' + Math.min(6, Math.max(1, step));
	}

	function symbols(cell) {
		return cell.genes.map(function (g) { return g.symbol; }).join(', ');
	}

	function cellLabel(gene, species, cell, noPhenotypes) {
		if (!cell) return 'No ortholog of ' + gene + ' in ' + species;
		if (noPhenotypes) {
			return gene + ' in ' + species + ': ' + cell.diseases + ' direct disease annotations. Genes: ' + symbols(cell);
		}
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
		var title = node('h4', gene + ' in ');
		title.appendChild(node('em', species));
		box.appendChild(title);
		var rows = detailRows(cell, annotations);
		if (!rows.length) {
			box.appendChild(statusNode('No annotations for ' + symbols(cell), 'agr-empty'));
			return;
		}
		if (rows.length > MAX_DETAIL_ROWS) {
			box.appendChild(node('p', 'Showing the first ' + MAX_DETAIL_ROWS + ' of ' + rows.length + ' annotations.', 'agr-note'));
			rows = rows.slice(0, MAX_DETAIL_ROWS);
		}
		var tableWrap = node('div', null, 'agr-table-wrap');
		var table = node('table', null, 'agr-table agr-table-sm');
		tableWrap.appendChild(table);
		var tr = node('tr');
		['Gene', 'Type', 'Phenotype or disease', 'Qualifier'].forEach(function (h) { tr.appendChild(colHeader(h)); });
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
		box.appendChild(tableWrap);
	}

	var CSV_HEADER = ['Gene', 'Species', 'Phenotype annotations', 'Direct disease annotations', 'Genes in species'];

	// One row per gene and species with a cell. The phenotype column is empty when the mine has none.
	function matrixCsvRows(genes, species, model, noPhenotypes) {
		var out = [];
		genes.forEach(function (g) {
			species.forEach(function (sp) {
				var cell = (model.cells[g.id] || {})[sp];
				if (!cell) return;
				out.push([label(g), sp, noPhenotypes ? '' : cell.phenotypes, cell.diseases, symbols(cell)]);
			});
		});
		return out;
	}

	// noPhenotypes: the mine has no phenotype annotations, so cells show disease counts only.
	function render(el, genes, species, model, totalGenes, noPhenotypes) {
		clear(el);
		var wrap = node('div', null, 'alliance-species-matrix');
		if (totalGenes > MAX_GENES) {
			wrap.appendChild(node('p', 'Showing the first ' + MAX_GENES + ' of ' + totalGenes + ' genes.', 'agr-note'));
		}
		wrap.appendChild(
			node(
				'p',
				noPhenotypes
					? 'Each cell: direct disease annotations, for the gene or its orthologs in that species. This mine has no phenotype annotations. Click a cell to list them.'
					: 'Each cell: phenotype annotations / direct disease annotations, for the gene or its orthologs in that species. Click a cell to list them.'
			)
		);

		var max = 0;
		genes.forEach(function (g) {
			species.forEach(function (sp) {
				var c = (model.cells[g.id] || {})[sp];
				if (c) max = Math.max(max, c.phenotypes + c.diseases);
			});
		});

		var detail = node('div', null, 'alliance-species-matrix-detail');
		var toolbar = node('div', null, 'agr-filter-bar');
		toolbar.appendChild(csvButton('species-matrix.csv', CSV_HEADER, matrixCsvRows(genes, species, model, noPhenotypes)));
		wrap.appendChild(toolbar);
		var tableWrap = node('div', null, 'agr-table-wrap');
		var table = node('table', null, 'agr-table agr-table-sm');
		tableWrap.appendChild(table);
		var hr = node('tr');
		hr.appendChild(colHeader('Gene'));
		species.forEach(function (sp) {
			var th = colHeader(null, 'num');
			th.appendChild(node('em', sp));
			hr.appendChild(th);
		});
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
				var td = node('td', null, 'num');
				var text = cellLabel(name, sp, cell, noPhenotypes);
				td.title = text;
				if (!cell) {
					td.textContent = '-';
					td.setAttribute('aria-label', text);
				} else {
					var btn = node('button', noPhenotypes ? String(cell.diseases) : cell.phenotypes + ' / ' + cell.diseases, 'agr-btn agr-btn-sm');
					btn.type = 'button';
					btn.title = text;
					btn.setAttribute('aria-label', text);
					var heat = shade(cell.phenotypes + cell.diseases, max);
					if (heat) td.className = 'num ' + heat;
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
		wrap.appendChild(tableWrap);
		wrap.appendChild(detail);
		wrap.appendChild(
			node(
				'p',
				(noPhenotypes
					? ''
					: 'Phenotype ontologies differ per species (MP, WBPhenotype, FBcv, ZP, HP), so phenotype counts are not directly comparable across columns. ') +
					'Disease counts exclude annotations via orthology and is_not_implicated_in.',
				'agr-note alliance-species-matrix-note'
			)
		);
		el.appendChild(wrap);
	}

	function load(svc, ids) {
		var res = [];
		return run(svc, organismsQuery())
			.then(function (r) {
				res.push(r);
				return run(svc, genesQuery(ids));
			})
			.then(function (r) {
				res.push(r);
				return runChunked(svc, orthologsQuery, ids);
			})
			.then(function (r) {
				res.push(r);
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
				var ann = [];
				return optional(runChunked(svc, phenotypesQuery, targets))
					.then(function (r) {
						ann.push(r);
						return runChunked(svc, diseasesQuery, targets);
					})
					.then(function (r) {
						ann.push(r);
						var model = buildMatrix(genes, orthRows, ann[0] || [], ann[1]);
						// A mine can list many organisms (MOD mines carry dozens of genomes): keep the ones with a gene or ortholog in the matrix.
						var used = species.filter(function (sp) {
							return genes.some(function (g) { return model.cells[g.id] && model.cells[g.id][sp]; });
						});
						return { species: used, genes: genes, model: model, noPhenotypes: ann[0] === null };
					});
			});
	}

	function csvCell(v) {
		var s = String(v === null || v === undefined ? '' : v);
		if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
		return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
	}

	function toCsv(header, rows) {
		return [header].concat(rows).map(function (l) { return l.map(csvCell).join(','); }).join('\r\n') + '\r\n';
	}

	function download(text, filename) {
		var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
		var url = URL.createObjectURL(blob);
		var a = document.createElement('a');
		a.href = url;
		a.download = filename;
		a.click();
		URL.revokeObjectURL(url);
	}

	function csvButton(filename, header, rows) {
		var b = node('button', 'Download CSV', 'agr-btn agr-btn-sm');
		b.type = 'button';
		b.addEventListener('click', function () { download(toCsv(header, rows), filename); });
		return b;
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
				render(el, r.genes, r.species, r.model, total, r.noPhenotypes);
			})
			.catch(function (err) {
				console.error('Species matrix failed', err);
				if (el.__agrMatrixReq !== token) return;
				message(el, errorText(err, 'Could not load the species matrix from the mine'));
			});
	}

	var api = {
		mineFetch: mineFetch,
		toCsv: toCsv,
		matrixCsvRows: matrixCsvRows,
		CSV_HEADER: CSV_HEADER,
		errorText: errorText,
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
