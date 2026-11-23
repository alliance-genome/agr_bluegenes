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
	var LARGE_FACTOR = 5;
	var SIZE_CANDIDATES = 300;
	var CHIPS_SHOWN = 8;
	var PUBMED_URL = 'https://pubmed.ncbi.nlm.nih.gov/';
	var TOPIC_PATH = 'Gene.publications.literatureTopics.name';
	var ENTITIES_PATH = 'Publication.entities';
	var RETRY_STATUS = { 429: true, 502: true, 503: true, 504: true };
	var settings = { retries: 3, retryDelayMs: 1000, timeoutMs: 60000 };
	var journalListId = 0;
	var VIEW = [
		'Gene.id',
		'Gene.symbol',
		'Gene.publications.pubMedId',
		'Gene.publications.title',
		'Gene.publications.year',
		'Gene.publications.journal',
		'Gene.publications.citation',
		'Gene.publications.firstAuthor',
		'Gene.primaryIdentifier',
		'Gene.organism.shortName'
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

	function valuesXml(list) {
		return list.map(function (v) { return '<value>' + escapeXml(v) + '</value>'; }).join('');
	}

	// Most papers have no topic, so the topic collection is an outer join. A sort on the
	// topic is not allowed with it; Gene.id then PubMed id keeps page boundaries stable.
	function buildQuery(ids, view) {
		var join = view.indexOf(TOPIC_PATH) === -1 ? '' : '<join path="Gene.publications.literatureTopics" style="OUTER"/>';
		return (
			'<query model="genomic" view="' + view.join(' ') + '" sortOrder="Gene.id asc Gene.publications.pubMedId asc">' +
			join +
			'<constraint path="Gene.id" op="ONE OF">' + valuesXml(ids) + '</constraint>' +
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
			primaryIdentifier: at['Gene.primaryIdentifier'],
			organism: at['Gene.organism.shortName'],
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
			total: null,
			_seen: {}
		};
	}

	function addRow(paper, row) {
		var gid = String(row.gene);
		if (!paper._seen[gid]) {
			paper._seen[gid] = true;
			paper.genes.push({ id: gid, symbol: row.symbol || gid, primaryIdentifier: row.primaryIdentifier || '', organism: row.organism || '' });
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

	// Genes covered times the share of the paper's annotated genes that are in the list.
	// Without a known size the score is the gene count.
	function score(p) {
		var n = p.genes.length;
		return p.total ? n * (n / Math.max(p.total, n)) : n;
	}

	// Highest score first, then more genes, newest year, lowest PubMed id for a stable order.
	function rankPapers(papers) {
		return papers.slice().sort(function (a, b) {
			return cmpNum(score(b), score(a)) || cmpNum(b.genes.length, a.genes.length) || cmpNum(b.year, a.year) || cmpNum(Number(a.pmid), Number(b.pmid));
		});
	}

	// A paper is a large study when it annotates far more genes than the list covers.
	function isLarge(p, limit) {
		return p.total ? p.total > Math.max(limit, LARGE_FACTOR * p.genes.length) : p.genes.length > limit;
	}

	function splitLarge(ranked, limit) {
		var focused = [];
		var large = [];
		ranked.forEach(function (p) { (isLarge(p, limit) ? large : focused).push(p); });
		return { focused: focused, large: large };
	}

	function isReview(p) {
		return p.topics.indexOf('Reviews') !== -1;
	}

	function topicCoverage(papers) {
		if (!papers.length) return 0;
		var n = papers.filter(function (p) { return p.topics.length > 0; }).length;
		return n / papers.length;
	}

	// Few papers carry a topic, so the filter is offered whenever any paper has one.
	function topicsOffered(papers) {
		return topicCoverage(papers) > 0;
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

	function pmidLines(papers) {
		return papers.map(function (p) { return p.pmid; }).join('\n');
	}

	// A leading = + - @ makes a spreadsheet evaluate the cell, so those cells get a quote prefix.
	function cell(v) {
		var t = String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ');
		return /^[=+\-@]/.test(t) ? "'" + t : t;
	}

	var TSV_HEAD = ['PMID', 'Genes', 'Year', 'Journal', 'First author', 'Title', 'Citation', 'Topics', 'Gene symbols', 'Gene IDs', 'Species'];

	function uniq(list) {
		return list.filter(function (v, i) { return v && list.indexOf(v) === i; });
	}

	function papersTsv(papers) {
		var lines = [TSV_HEAD.join('\t')];
		papers.forEach(function (p) {
			lines.push([
				p.pmid, p.genes.length, p.year, p.journal, p.firstAuthor, p.title, p.citation,
				p.topics.join('; '),
				p.genes.map(function (g) { return g.symbol; }).join(','),
				p.genes.map(function (g) { return g.primaryIdentifier; }).join(','),
				uniq(p.genes.map(function (g) { return g.organism; })).join('; ')
			].map(cell).join('\t'));
		});
		return lines.join('\n');
	}

	function wait(ms) {
		return new Promise(function (resolve) { setTimeout(resolve, ms); });
	}

	function retryDelay(res, attempt) {
		var after = res && res.headers && res.headers.get && Number(res.headers.get('Retry-After'));
		return after > 0 ? after * 1000 : settings.retryDelayMs * Math.pow(2, attempt);
	}

	// POSTs a form body. Retries 429, 502, 503, 504, timeouts and network errors with backoff.
	function post(url, body, attempt) {
		attempt = attempt || 0;
		var ctl = typeof AbortController === 'function' ? new AbortController() : null;
		var timer = ctl ? setTimeout(function () { ctl.abort(); }, settings.timeoutMs) : null;
		var init = {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: body
		};
		if (ctl) init.signal = ctl.signal;
		function again(res, err) {
			if (attempt >= settings.retries) throw err;
			return wait(retryDelay(res, attempt)).then(function () { return post(url, body, attempt + 1); });
		}
		return fetch(url, init).then(function (res) {
			if (timer) clearTimeout(timer);
			if (res.ok) return res.json();
			var err = new Error('HTTP ' + res.status);
			if (RETRY_STATUS[res.status]) return again(res, err);
			throw err;
		}, function (e) {
			if (timer) clearTimeout(timer);
			return again(null, new Error(ctl && ctl.signal.aborted ? 'request timed out' : (e && e.message) || 'network error'));
		});
	}

	// Rows are sorted by Gene.id, so after a cut the last gene read may be incomplete.
	// Drops its rows and returns the ids from that gene onwards as unloaded.
	function cutAtLastGene(rows, ids) {
		if (!rows.length) return { rows: [], unloaded: ids.slice() };
		var last = String(rows[rows.length - 1].gene);
		return {
			rows: rows.filter(function (r) { return String(r.gene) !== last; }),
			unloaded: ids.filter(function (id) { return Number(id) >= Number(last); })
		};
	}

	function emptyResult() {
		return { rows: [], truncated: false, unloaded: [], errors: [] };
	}

	function merge(into, res) {
		into.rows = into.rows.concat(res.rows);
		into.truncated = into.truncated || res.truncated;
		into.unloaded = into.unloaded.concat(res.unloaded);
		into.errors = into.errors.concat(res.errors);
	}

	// Pages through one chunk. A chunk that reaches MAX_PAGES is split in halves and read again.
	// A single gene that still reaches it is kept but listed as unloaded. A failed request
	// keeps the complete genes read so far and lists the rest as unloaded.
	function fetchChunk(url, ids, view, onRows) {
		var rows = [];
		function next(page) {
			return post(url, requestBody(ids, view, page * PAGE_SIZE)).then(function (json) {
				var got = (json && json.results) || [];
				got.forEach(function (r) { rows.push(toRow(r, view)); });
				if (onRows) onRows(got.length);
				if (got.length < PAGE_SIZE) return { rows: rows, truncated: false, unloaded: [], errors: [] };
				if (page + 1 < MAX_PAGES) return next(page + 1);
				if (ids.length === 1) return { rows: rows, truncated: true, unloaded: ids.slice(), errors: [] };
				return splitChunk();
			});
		}
		function splitChunk() {
			var mid = Math.ceil(ids.length / 2);
			var merged = emptyResult();
			return [ids.slice(0, mid), ids.slice(mid)].reduce(function (prev, part) {
				return prev.then(function () {
					return fetchChunk(url, part, view, onRows).then(function (res) { merge(merged, res); });
				});
			}, Promise.resolve()).then(function () { return merged; });
		}
		return next(0).catch(function (err) {
			var cut = cutAtLastGene(rows, ids);
			return { rows: cut.rows, truncated: false, unloaded: cut.unloaded, errors: [err.message] };
		});
	}

	// Chunks run one after another so one list never opens many connections. A failed chunk
	// is recorded and the next one still runs.
	function fetchAll(rootUrl, ids, view, onProgress) {
		var url = serviceRoot(rootUrl) + '/query/results';
		var all = emptyResult();
		var parts = chunk(ids, CHUNK_SIZE);
		var loaded = 0;
		function report(i) {
			if (onProgress) onProgress({ chunk: i + 1, chunks: parts.length, rows: loaded });
		}
		return parts
			.reduce(function (prev, part, i) {
				return prev.then(function () {
					report(i);
					return fetchChunk(url, part, view, function (n) { loaded += n; report(i); }).then(function (res) { merge(all, res); });
				});
			}, Promise.resolve())
			.then(function () { return all; });
	}

	// Annotated gene count per PubMed id, from one summary query over Publication.entities.
	function fetchSizes(rootUrl, pmids) {
		if (!pmids.length) return Promise.resolve({});
		var query =
			'<query model="genomic" view="Publication.pubMedId Publication.entities.primaryIdentifier">' +
			'<constraint path="Publication.pubMedId" op="ONE OF">' + valuesXml(pmids) + '</constraint>' +
			'<constraint path="Publication.entities" type="Gene"/>' +
			'</query>';
		var body = 'format=json&size=' + Math.max(pmids.length, 10) + '&summaryPath=Publication.pubMedId&query=' + encodeURIComponent(query);
		return post(serviceRoot(rootUrl) + '/query/results', body).then(function (json) {
			var sizes = {};
			((json && json.results) || []).forEach(function (r) { sizes[String(r[0])] = Number(r[1]); });
			return sizes;
		});
	}

	function applySizes(papers, sizes) {
		papers.forEach(function (p) { if (sizes[p.pmid] > 0) p.total = sizes[p.pmid]; });
	}

	function count(n, word) {
		return n + ' ' + word + (n === 1 ? '' : 's');
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
		var url = URL.createObjectURL(new Blob([text], { type: type }));
		var a = node('a');
		a.href = url;
		a.download = name;
		a.click();
		setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
	}

	function button(label, onClick) {
		var b = node('button', label, 'agr-btn');
		b.type = 'button';
		b.addEventListener('click', onClick);
		return b;
	}

	function chipLabel(g, ui) {
		return ui.multiSpecies && g.organism ? g.symbol + ' (' + g.organism + ')' : g.symbol;
	}

	function geneChips(paper, ui) {
		var box = node('span', null, 'agr-chips');
		paper.genes.slice(0, CHIPS_SHOWN).forEach(function (g) {
			var chip = node('button', chipLabel(g, ui), 'agr-chip');
			chip.type = 'button';
			chip.title = [g.primaryIdentifier, g.organism].filter(Boolean).join(', ');
			chip.addEventListener('click', function () {
				if (typeof ui.navigate === 'function') ui.navigate('report', { type: 'Gene', id: g.id });
			});
			box.appendChild(chip);
			box.appendChild(document.createTextNode(' '));
		});
		if (paper.genes.length > CHIPS_SHOWN) box.appendChild(node('span', '+' + (paper.genes.length - CHIPS_SHOWN) + ' more', 'agr-note'));
		return box;
	}

	function saveButton(paper, ui) {
		var status = node('span', null, 'agr-note');
		status.setAttribute('role', 'status');
		var b = button('Save ' + count(paper.genes.length, 'gene') + ' as list', function () {
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
		main.appendChild(geneChips(paper, ui));
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

	function paperTable(papers, ui, caption) {
		var wrap = node('div', null, 'agr-table-wrap');
		var table = node('table', null, 'agr-table agr-table-sm');
		table.appendChild(node('caption', caption, 'agr-note'));
		var head = node('tr');
		['Genes', 'Paper', 'PubMed'].forEach(function (h) {
			var th = node('th', h);
			th.setAttribute('scope', 'col');
			head.appendChild(th);
		});
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
		var opts = options.map(function (o) {
			var opt = node('option', o);
			opt.value = String(o);
			s.appendChild(opt);
			return opt;
		});
		s.value = value ? String(value) : '';
		s.addEventListener('change', function () { onChange(s.value); });
		var l = node('label', label + ' ', 'agr-field');
		l.appendChild(s);
		return { label: l, control: s, options: opts };
	}

	// Journals with their paper counts, most papers first, in a datalist behind a text input.
	function journalField(papers, value, onChange) {
		var counts = {};
		papers.forEach(function (p) { if (p.journal) counts[p.journal] = (counts[p.journal] || 0) + 1; });
		var names = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || (a < b ? -1 : 1); });
		var id = 'agr-literature-journals-' + (journalListId += 1);
		var input = node('input');
		input.type = 'text';
		input.setAttribute('list', id);
		input.value = value || '';
		input.addEventListener('change', function () { onChange(input.value.trim()); });
		var list = node('datalist');
		list.setAttribute('id', id);
		names.forEach(function (n) {
			var opt = node('option', count(counts[n], 'paper'));
			opt.value = n;
			list.appendChild(opt);
		});
		var l = node('label', 'Journal ', 'agr-field');
		l.appendChild(input);
		l.appendChild(list);
		return { label: l, control: input };
	}

	// Builds the filter bar once. Changing a filter calls refresh and keeps these nodes, so
	// keyboard focus stays on the control the user used.
	function filterBar(papers, filters, offerTopics, refresh) {
		var bar = node('div', null, 'agr-filters');
		var years = distinct(papers, 'year').map(Number).sort(function (a, b) { return b - a; });
		var controls = [];
		function update(change) {
			Object.assign(filters, change);
			syncYears();
			refresh();
		}
		var from = select('From year', years, filters.yearFrom, function (v) { update({ yearFrom: v ? Number(v) : null }); });
		var to = select('To year', years, filters.yearTo, function (v) { update({ yearTo: v ? Number(v) : null }); });
		var journal = journalField(papers, filters.journal, function (v) { update({ journal: v }); });
		controls.push(from, to, journal);
		var topic = null;
		if (offerTopics) {
			topic = select('Topic', distinct(papers, 'topics'), filters.topic, function (v) { update({ topic: v }); });
			controls.push(topic);
		}
		function syncYears() {
			from.options.forEach(function (o) { o.disabled = !!(filters.yearTo && Number(o.value) > filters.yearTo); });
			to.options.forEach(function (o) { o.disabled = !!(filters.yearFrom && Number(o.value) < filters.yearFrom); });
		}
		controls.forEach(function (c) { bar.appendChild(c.label); });
		bar.appendChild(button('Clear filters', function () {
			Object.keys(filters).forEach(function (k) { delete filters[k]; });
			controls.forEach(function (c) { c.control.value = ''; });
			syncYears();
			refresh();
		}));
		syncYears();
		return bar;
	}

	function exportBar(matching) {
		var bar = node('p');
		var status = node('span', null, 'agr-note');
		status.setAttribute('role', 'status');
		var n = count(matching.length, 'PMID');
		var lines = pmidLines(matching);
		bar.appendChild(button('Copy ' + n, function () {
			var nav = typeof navigator !== 'undefined' ? navigator : null;
			if (!nav || !nav.clipboard) {
				download('pmids.txt', lines, 'text/plain');
				status.textContent = 'Clipboard unavailable, downloaded pmids.txt';
				return;
			}
			nav.clipboard.writeText(lines).then(function () {
				status.textContent = 'Copied ' + n;
			}, function () {
				download('pmids.txt', lines, 'text/plain');
				status.textContent = 'Clipboard blocked, downloaded pmids.txt';
			});
		}));
		bar.appendChild(document.createTextNode(' '));
		bar.appendChild(button('Download ' + n, function () { download('pmids.txt', lines, 'text/plain'); }));
		bar.appendChild(document.createTextNode(' '));
		bar.appendChild(button('Download ' + count(matching.length, 'paper') + ' as TSV', function () {
			download('literature-digest.tsv', '﻿' + papersTsv(matching), 'text/tab-separated-values');
		}));
		bar.appendChild(document.createTextNode(' '));
		bar.appendChild(status);
		return bar;
	}

	function section(wrap, title, note, papers, ui) {
		var shown = papers.slice(0, TOP_N);
		var heading = title + ' (' + (shown.length < papers.length ? shown.length + ' of ' + papers.length : papers.length) + ')';
		wrap.appendChild(node('h4', heading));
		wrap.appendChild(node('p', note, 'agr-note'));
		if (shown.length) wrap.appendChild(paperTable(shown, ui, heading));
	}

	function summaryText(data, matching, filters) {
		var text = count(data.papers.length, 'paper') + (data.papers.length === 1 ? ' cites ' : ' cite ') + count(data.geneCount, 'gene') + '. ' + matching.length + ' match the filters.';
		var noYear = data.papers.filter(function (p) { return p.year == null; }).length;
		if ((filters.yearFrom || filters.yearTo) && noYear) text += ' ' + count(noYear, 'paper') + ' without a year ' + (noYear === 1 ? 'is' : 'are') + ' hidden by the year filter.';
		return text;
	}

	function renderResults(host, data, ui) {
		var filters = ui.filters;
		var matching = rankPapers(filterPapers(data.papers, filters));
		clear(host);
		var summary = node('p', summaryText(data, matching, filters), 'alliance-literature-digest-summary');
		summary.setAttribute('aria-live', 'polite');
		host.appendChild(summary);
		if (!matching.length) {
			host.appendChild(node('p', 'No papers match these filters. Use Clear filters to start again.', 'agr-empty'));
			return;
		}
		var parts = splitLarge(matching, LARGE_STUDY_GENES);
		var reviews = parts.focused.filter(isReview);
		var focused = parts.focused.filter(function (p) { return !isReview(p); });
		host.appendChild(exportBar(matching));
		section(host, 'Papers by gene coverage', 'Top ' + TOP_N + ' papers ranked by list genes covered, weighted by the share of each paper\'s annotated genes in the list.', focused, ui);
		section(host, 'Reviews', 'Papers with the literature topic Reviews.', reviews, ui);
		section(host, 'Large-scale studies', 'Papers that annotate far more genes than the list covers, such as screens.', parts.large, ui);
	}

	function notices(wrap, data, ui) {
		if (data.unloaded && data.unloaded.length) {
			wrap.appendChild(node('p', 'Results are partial: ' + count(data.unloaded.length, 'gene') + ' of ' + data.geneCount + ' not fully loaded (gene ids ' + data.unloaded.slice(0, 10).join(', ') + (data.unloaded.length > 10 ? ', ...' : '') + '). Papers for these genes are missing or undercounted.', 'agr-note'));
		}
		(data.errors || []).forEach(function (e) { wrap.appendChild(node('p', 'Request failed: ' + e, 'agr-error')); });
		if (data.sizeError) wrap.appendChild(node('p', 'Paper sizes were not loaded (' + data.sizeError + '), so papers are ranked by gene count only.', 'agr-note'));
		if (ui.retry && ((data.errors && data.errors.length) || data.sizeError)) wrap.appendChild(button('Retry', ui.retry));
	}

	function render(el, data, ui) {
		ui.filters = ui.filters || {};
		var offerTopics = topicsOffered(data.papers);
		clear(el);
		var wrap = node('div', null, 'alliance-literature-digest');
		notices(wrap, data, ui);
		var host = node('div');
		wrap.appendChild(filterBar(data.papers, ui.filters, offerTopics, function () { renderResults(host, data, ui); }));
		wrap.appendChild(host);
		el.appendChild(wrap);
		renderResults(host, data, ui);
	}

	function geneIds(imEntity) {
		var v = imEntity.Gene && imEntity.Gene.value;
		return (Array.isArray(v) ? v : [v]).filter(function (x) { return x !== undefined && x !== null && x !== ''; }).map(String);
	}

	// Paper sizes only for the best candidates by gene count; the rest rank by gene count.
	function loadSizes(service, papers) {
		if (!hasPath(service, ENTITIES_PATH)) return Promise.resolve({ sizes: {} });
		var pmids = rankPapers(papers).slice(0, SIZE_CANDIDATES).map(function (p) { return p.pmid; });
		return fetchSizes(service.root, pmids).then(function (sizes) { return { sizes: sizes }; }, function (err) { return { sizes: {}, error: err.message }; });
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
		var ui = {
			navigate: navigate,
			saveList: context && typeof context.saveList === 'function' ? context.saveList : null,
			filters: {},
			retry: function () { main(el, service, imEntity, state, config, navigate, context); }
		};
		message(el, 'Loading papers for ' + count(ids.length, 'gene'), 'agr-loading');
		var current = function () { return el.__agrLitReq === token; };
		var progress = function (p) {
			if (current()) message(el, 'Loading papers for ' + count(ids.length, 'gene') + ': chunk ' + p.chunk + ' of ' + p.chunks + ', ' + p.rows + ' rows', 'agr-loading');
		};
		fetchAll(service.root, ids, viewFor(service), progress)
			.then(function (res) {
				if (!current()) return null;
				var papers = groupPapers(res.rows);
				if (!papers.length && !res.errors.length && !res.unloaded.length) return message(el, 'No papers for these genes', 'agr-empty');
				if (!papers.length) return message(el, 'Could not load papers: ' + res.errors.join('; '), 'agr-error');
				message(el, 'Loading paper sizes for ' + count(papers.length, 'paper'), 'agr-loading');
				return loadSizes(service, papers).then(function (sz) {
					if (!current()) return;
					applySizes(papers, sz.sizes);
					ui.multiSpecies = uniq(res.rows.map(function (r) { return r.organism; })).length > 1;
					render(el, {
						papers: papers, geneCount: ids.length, truncated: res.truncated,
						unloaded: uniq(res.unloaded), errors: res.errors, sizeError: sz.error
					}, ui);
				});
			})
			.catch(function (err) {
				if (current()) message(el, 'Could not load papers: ' + err.message, 'agr-error');
			});
	}

	var api = {
		main: main,
		settings: settings,
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
		pmidLines: pmidLines,
		papersTsv: papersTsv,
		fetchAll: fetchAll,
		fetchSizes: fetchSizes,
		applySizes: applySizes,
		render: render
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceLiteratureDigest = api;
})(typeof window !== 'undefined' ? window : globalThis);
