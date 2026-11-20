/*
 * Literature digest, a BlueGenes tool (tool API version 2).
 * Plain JavaScript without dependencies, so this file is both the source and
 * the bundle. BlueGenes loads it as a script and calls
 * bluegenesAllianceLiteratureDigest.main(el, service, entity, state, config, navigate, context).
 */
(function (root) {
	'use strict';

	var CHUNK_SIZE = 500;
	var PAGE_SIZE = 10000;
	var MAX_PAGES = 20;
	var TOP_N = 100;
	var LARGE_STUDY_GENES = 50;
	var TOPIC_COVERAGE = 0.3;
	var CHIPS_SHOWN = 8;
	var PUBMED_URL = 'https://pubmed.ncbi.nlm.nih.gov/';
	var TOPIC_PATH = 'Gene.publications.literatureTopics.name';
	var VIEW = [
		'Gene.id',
		'Gene.symbol',
		'Gene.publications.pubMedId',
		'Gene.publications.title',
		'Gene.publications.year',
		'Gene.publications.journal',
		'Gene.publications.citation',
		'Gene.publications.firstAuthor'
	];

	// BlueGenes passes the mine root (for example https://host/mine); the web
	// services live under /service. Accept either form.
	function serviceRoot(rootUrl) {
		var r = String(rootUrl || '').replace(/\/+$/, '');
		return /\/service$/.test(r) ? r : r + '/service';
	}

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

	// Resolves a dotted path in service.model.classes. True when no model is passed.
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

	// The topic column is queried only when the mine's model has literatureTopics.
	function viewFor(service) {
		return hasPath(service, TOPIC_PATH) && service && service.model ? VIEW.concat([TOPIC_PATH]) : VIEW;
	}

	function chunk(list, size) {
		var out = [];
		for (var i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
		return out;
	}

	function escapeXml(s) {
		return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	function buildQuery(ids, view) {
		var values = ids.map(function (v) { return '<value>' + escapeXml(v) + '</value>'; }).join('');
		return (
			'<query model="genomic" view="' + view.join(' ') + '" sortOrder="Gene.id asc">' +
			'<constraint path="Gene.id" op="ONE OF">' + values + '</constraint>' +
			'</query>'
		);
	}

	function requestBody(ids, view, start) {
		return 'format=json&start=' + start + '&size=' + PAGE_SIZE + '&query=' + encodeURIComponent(buildQuery(ids, view));
	}

	function toRow(r, view) {
		var at = {};
		view.forEach(function (path, i) { at[path] = r[i]; });
		return {
			gene: at['Gene.id'],
			symbol: at['Gene.symbol'],
			pmid: at['Gene.publications.pubMedId'],
			title: at['Gene.publications.title'],
			year: at['Gene.publications.year'],
			journal: at['Gene.publications.journal'],
			citation: at['Gene.publications.citation'],
			firstAuthor: at['Gene.publications.firstAuthor'],
			topic: at[TOPIC_PATH] == null ? null : at[TOPIC_PATH]
		};
	}

	function newPaper(row) {
		return {
			pmid: String(row.pmid),
			title: row.title || '',
			year: row.year == null ? null : Number(row.year),
			journal: row.journal || '',
			citation: row.citation || '',
			firstAuthor: row.firstAuthor || '',
			genes: [],
			topics: [],
			_seen: {}
		};
	}

	function addRow(paper, row) {
		var gid = String(row.gene);
		if (!paper._seen[gid]) {
			paper._seen[gid] = true;
			paper.genes.push({ id: gid, symbol: row.symbol || gid });
		}
		if (row.topic && paper.topics.indexOf(row.topic) === -1) paper.topics.push(row.topic);
	}

	// One paper per PubMed id, with the distinct list genes that cite it. Rows without a PubMed id are dropped.
	function groupPapers(rows) {
		var by = {};
		var order = [];
		rows.forEach(function (row) {
			if (row.pmid == null || row.pmid === '') return;
			var key = String(row.pmid);
			if (!by[key]) {
				by[key] = newPaper(row);
				order.push(key);
			}
			addRow(by[key], row);
		});
		return order.map(function (k) {
			delete by[k]._seen;
			return by[k];
		});
	}

	function cmpNum(a, b) {
		return (a || 0) - (b || 0);
	}

	// Most genes first, then newest year, then lowest PubMed id for a stable order.
	function rankPapers(papers) {
		return papers.slice().sort(function (a, b) {
			return cmpNum(b.genes.length, a.genes.length) || cmpNum(b.year, a.year) || cmpNum(Number(a.pmid), Number(b.pmid));
		});
	}

	function splitLarge(ranked, limit) {
		var focused = [];
		var large = [];
		ranked.forEach(function (p) { (p.genes.length > limit ? large : focused).push(p); });
		return { focused: focused, large: large };
	}

	function topicCoverage(papers) {
		if (!papers.length) return 0;
		var n = papers.filter(function (p) { return p.topics.length > 0; }).length;
		return n / papers.length;
	}

	function topicsOffered(papers) {
		return papers.length > 0 && topicCoverage(papers) >= TOPIC_COVERAGE;
	}

	function filterPapers(papers, f) {
		return papers.filter(function (p) {
			if (f.yearFrom && !(p.year >= f.yearFrom)) return false;
			if (f.yearTo && !(p.year <= f.yearTo)) return false;
			if (f.journal && p.journal !== f.journal) return false;
			if (f.topic && p.topics.indexOf(f.topic) === -1) return false;
			return true;
		});
	}

	function pmidCsv(papers) {
		return papers.map(function (p) { return p.pmid; }).join(',');
	}

	function cell(v) {
		return String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ');
	}

	var TSV_HEAD = ['PMID', 'Genes', 'Year', 'Journal', 'First author', 'Title', 'Citation', 'Topics', 'Gene symbols'];

	function papersTsv(papers) {
		var lines = [TSV_HEAD.join('\t')];
		papers.forEach(function (p) {
			lines.push([
				p.pmid, p.genes.length, p.year, p.journal, p.firstAuthor, p.title, p.citation,
				p.topics.join('; '), p.genes.map(function (g) { return g.symbol; }).join(',')
			].map(cell).join('\t'));
		});
		return lines.join('\n');
	}

	function fetchPage(url, ids, view, start) {
		return fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: requestBody(ids, view, start)
		}).then(function (res) {
			if (!res.ok) throw new Error('HTTP ' + res.status);
			return res.json();
		});
	}

	// Pages through one chunk's rows; stops after MAX_PAGES and flags truncation.
	function fetchChunk(url, ids, view) {
		var rows = [];
		function next(page) {
			return fetchPage(url, ids, view, page * PAGE_SIZE).then(function (json) {
				var got = (json && json.results) || [];
				got.forEach(function (r) { rows.push(toRow(r, view)); });
				if (got.length < PAGE_SIZE) return { rows: rows, truncated: false };
				if (page + 1 >= MAX_PAGES) return { rows: rows, truncated: true };
				return next(page + 1);
			});
		}
		return next(0);
	}

	// Chunks run one after another so one list never opens many connections.
	function fetchAll(rootUrl, ids, view) {
		var url = serviceRoot(rootUrl) + '/query/results';
		var all = { rows: [], truncated: false };
		return chunk(ids, CHUNK_SIZE)
			.reduce(function (prev, part) {
				return prev.then(function () {
					return fetchChunk(url, part, view).then(function (res) {
						all.rows = all.rows.concat(res.rows);
						all.truncated = all.truncated || res.truncated;
					});
				});
			}, Promise.resolve())
			.then(function () { return all; });
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

	function message(el, text, cls) {
		clear(el);
		var wrap = node('div', null, 'alliance-literature-digest');
		wrap.appendChild(node('p', text, cls));
		el.appendChild(wrap);
	}

	function download(name, text, type) {
		var a = node('a');
		a.href = URL.createObjectURL(new Blob([text], { type: type }));
		a.download = name;
		a.click();
	}

	function button(label, onClick) {
		var b = node('button', label, 'agr-btn');
		b.type = 'button';
		b.addEventListener('click', onClick);
		return b;
	}

	function geneChips(paper, navigate) {
		var box = node('span', null, 'agr-chips');
		paper.genes.slice(0, CHIPS_SHOWN).forEach(function (g) {
			var chip = node('a', g.symbol, 'agr-chip');
			chip.href = '#';
			chip.addEventListener('click', function (ev) {
				if (ev && ev.preventDefault) ev.preventDefault();
				if (typeof navigate === 'function') navigate('report', { type: 'Gene', id: g.id });
			});
			box.appendChild(chip);
			box.appendChild(document.createTextNode(' '));
		});
		if (paper.genes.length > CHIPS_SHOWN) box.appendChild(node('span', '+' + (paper.genes.length - CHIPS_SHOWN) + ' more', 'agr-note'));
		return box;
	}

	function saveButton(paper, ui) {
		var status = node('span', null, 'agr-note');
		var b = button('Save ' + paper.genes.length + ' genes as list', function () {
			var ids = paper.genes.map(function (g) { return g.id; });
			status.textContent = 'Saving';
			ui.saveList({ name: 'PMID ' + paper.pmid + ' genes', class: 'Gene', ids: ids, tags: ['alliance-literature-digest'] })
				.then(function (name) { status.textContent = 'Saved as ' + name; })
				.catch(function (err) { status.textContent = 'Not saved: ' + (err && err.message ? err.message : err); });
		});
		var box = node('span');
		box.appendChild(b);
		box.appendChild(status);
		return box;
	}

	function paperRow(paper, ui) {
		var tr = node('tr');
		tr.appendChild(node('td', paper.genes.length, 'num'));
		var main = node('td');
		main.appendChild(node('div', paper.title || '(no title)', 'agr-strong'));
		main.appendChild(node('div', [paper.firstAuthor, paper.journal, paper.year].filter(Boolean).join(', '), 'agr-note'));
		main.appendChild(geneChips(paper, ui.navigate));
		if (ui.saveList) main.appendChild(saveButton(paper, ui));
		tr.appendChild(main);
		var link = node('a', paper.pmid);
		link.href = PUBMED_URL + encodeURIComponent(paper.pmid) + '/';
		link.target = '_blank';
		link.rel = 'noopener';
		var linkCell = node('td');
		linkCell.appendChild(link);
		tr.appendChild(linkCell);
		return tr;
	}

	function paperTable(papers, ui) {
		var wrap = node('div', null, 'agr-table-wrap');
		var table = node('table', null, 'agr-table agr-table-sm');
		var head = node('tr');
		['Genes', 'Paper', 'PubMed'].forEach(function (h) { head.appendChild(node('th', h)); });
		var thead = node('thead');
		thead.appendChild(head);
		table.appendChild(thead);
		var tbody = node('tbody');
		papers.forEach(function (p) { tbody.appendChild(paperRow(p, ui)); });
		table.appendChild(tbody);
		wrap.appendChild(table);
		return wrap;
	}

	function distinct(papers, key) {
		var seen = {};
		papers.forEach(function (p) {
			(Array.isArray(p[key]) ? p[key] : [p[key]]).forEach(function (v) { if (v) seen[v] = true; });
		});
		return Object.keys(seen).sort();
	}

	function select(label, options, value, onChange) {
		var s = node('select');
		var all = node('option', 'All');
		all.value = '';
		s.appendChild(all);
		options.forEach(function (o) {
			var opt = node('option', o);
			opt.value = String(o);
			s.appendChild(opt);
		});
		s.value = value ? String(value) : '';
		s.addEventListener('change', function () { onChange(s.value); });
		var l = node('label', label + ' ', 'agr-field');
		l.appendChild(s);
		return l;
	}

	function filterBar(papers, filters, offerTopics, update) {
		var bar = node('div', null, 'agr-filters');
		var years = distinct(papers, 'year').map(Number).sort(function (a, b) { return b - a; });
		bar.appendChild(select('From year', years, filters.yearFrom, function (v) { update({ yearFrom: v ? Number(v) : null }); }));
		bar.appendChild(select('To year', years, filters.yearTo, function (v) { update({ yearTo: v ? Number(v) : null }); }));
		bar.appendChild(select('Journal', distinct(papers, 'journal'), filters.journal, function (v) { update({ journal: v }); }));
		if (offerTopics) bar.appendChild(select('Topic', distinct(papers, 'topics'), filters.topic, function (v) { update({ topic: v }); }));
		return bar;
	}

	function exportBar(shown, matching) {
		var bar = node('p');
		bar.appendChild(button('Copy PMIDs as CSV', function () {
			var csv = pmidCsv(shown);
			if (typeof navigator !== 'undefined' && navigator.clipboard) navigator.clipboard.writeText(csv);
			else download('pmids.csv', csv, 'text/csv');
		}));
		bar.appendChild(document.createTextNode(' '));
		bar.appendChild(button('Download PMID CSV', function () { download('pmids.csv', pmidCsv(shown), 'text/csv'); }));
		bar.appendChild(document.createTextNode(' '));
		bar.appendChild(button('Download all ' + matching.length + ' papers as TSV', function () {
			download('literature-digest.tsv', papersTsv(matching), 'text/tab-separated-values');
		}));
		return bar;
	}

	function section(wrap, title, note, papers, ui) {
		wrap.appendChild(node('h4', title + ' (' + papers.length + ')'));
		wrap.appendChild(node('p', note, 'agr-note'));
		if (papers.length) wrap.appendChild(paperTable(papers.slice(0, TOP_N), ui));
	}

	function render(el, data, ui) {
		var filters = ui.filters || {};
		var offerTopics = topicsOffered(data.papers);
		var matching = rankPapers(filterPapers(data.papers, filters));
		var parts = splitLarge(matching, LARGE_STUDY_GENES);
		var shown = parts.focused.slice(0, TOP_N).concat(parts.large.slice(0, TOP_N));
		clear(el);
		var wrap = node('div', null, 'alliance-literature-digest');
		wrap.appendChild(node('p', data.papers.length + ' papers cite ' + data.geneCount + ' genes. ' + matching.length + ' match the filters.', 'alliance-literature-digest-summary'));
		if (data.truncated) wrap.appendChild(node('p', 'The mine returned more rows than the tool reads. Results are partial.', 'agr-note'));
		wrap.appendChild(filterBar(data.papers, filters, offerTopics, function (change) {
			ui.filters = Object.assign({}, filters, change);
			render(el, data, ui);
		}));
		wrap.appendChild(exportBar(shown, matching));
		section(wrap, 'Papers by gene coverage', 'Top ' + TOP_N + ' papers ranked by how many list genes they cover.', parts.focused, ui);
		section(wrap, 'Large-scale studies', 'Papers covering more than ' + LARGE_STUDY_GENES + ' list genes, such as reviews and screens.', parts.large, ui);
		el.appendChild(wrap);
	}

	function geneIds(imEntity) {
		var v = imEntity.Gene && imEntity.Gene.value;
		return (Array.isArray(v) ? v : [v]).filter(function (x) { return x !== undefined && x !== null && x !== ''; }).map(String);
	}

	function main(el, service, imEntity, state, config, navigate, context) {
		if (!el || !service || !imEntity) {
			throw new Error('Call main with correct signature');
		}
		var token = (el.__agrLitReq = (el.__agrLitReq || 0) + 1);
		var ids = geneIds(imEntity);
		if (!ids.length) {
			message(el, 'No genes to summarise', 'agr-empty');
			return;
		}
		message(el, 'Loading papers for ' + ids.length + ' genes', 'agr-loading');
		var ui = { navigate: navigate, saveList: context && typeof context.saveList === 'function' ? context.saveList : null, filters: {} };
		fetchAll(service.root, ids, viewFor(service))
			.then(function (res) {
				if (el.__agrLitReq !== token) return;
				var papers = groupPapers(res.rows);
				if (!papers.length) return message(el, 'No papers for these genes', 'agr-empty');
				render(el, { papers: papers, geneCount: ids.length, truncated: res.truncated }, ui);
			})
			.catch(function (err) {
				if (el.__agrLitReq === token) message(el, 'Could not load papers: ' + err.message, 'agr-error');
			});
	}

	var api = {
		main: main,
		serviceRoot: serviceRoot,
		VIEW: VIEW,
		hasPath: hasPath,
		viewFor: viewFor,
		chunk: chunk,
		buildQuery: buildQuery,
		requestBody: requestBody,
		toRow: toRow,
		groupPapers: groupPapers,
		rankPapers: rankPapers,
		splitLarge: splitLarge,
		topicCoverage: topicCoverage,
		topicsOffered: topicsOffered,
		filterPapers: filterPapers,
		pmidCsv: pmidCsv,
		papersTsv: papersTsv,
		fetchAll: fetchAll,
		render: render
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceLiteratureDigest = api;
})(typeof window !== 'undefined' ? window : globalThis);
