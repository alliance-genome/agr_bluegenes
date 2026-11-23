/*
 * Run templates on these genes, a BlueGenes tool (tool API version 2).
 * Plain JavaScript without dependencies, so this file is both the source and
 * the bundle. BlueGenes loads it as a script and calls
 * bluegenesAllianceTemplateRunner.main(el, service, entity, state, config, navigate, context).
 * context is undefined on hosts that do not pass it.
 */
(function (root) {
	'use strict';

	var settings = { timeoutMs: 20000, backoffMs: [1000, 2000, 4000] };
	var templateCache = {};

	function serviceRoot(root) {
		var r = String(root || '').replace(/\/+$/, '');
		return /\/service$/.test(r) ? r : r + '/service';
	}

	function templatesUrl(root) {
		return serviceRoot(root) + '/templates?format=json';
	}

	function resultsUrl(root) {
		return serviceRoot(root) + '/query/results';
	}

	function classesOf(service) {
		return (service && service.model && service.model.classes) || null;
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

	// Class a dotted path ends in, or null. A path ending in an attribute has no class and returns null.
	function typeOfPath(classes, path) {
		var parts = String(path).split('.');
		var cls = parts[0];
		if (!classes[cls]) return null;
		for (var i = 1; i < parts.length; i++) {
			var f = fieldOf(classes, cls, parts[i], {});
			if (!f || !f.referencedType) return null;
			cls = f.referencedType;
		}
		return cls;
	}

	function hasPath(classes, path) {
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

	function orderPath(entry) {
		return typeof entry === 'string' ? entry : Object.keys(entry)[0];
	}

	// Where paths and constraint types the model lacks. A template with any of them cannot run.
	function missingWhere(t, classes) {
		var out = [];
		(t.where || []).forEach(function (c) {
			if (!hasPath(classes, c.path)) out.push(c.path);
			if (c.type && !classes[c.type]) out.push('type ' + c.type);
		});
		return out;
	}

	// Copy of the template without the select, orderBy and join paths the model lacks.
	function adaptTemplate(t, classes) {
		var dropped = [];
		function known(p) {
			if (hasPath(classes, p)) return true;
			if (dropped.indexOf(p) === -1) dropped.push(p);
			return false;
		}
		var copy = Object.assign({}, t, { select: (t.select || []).filter(known) });
		if (t.orderBy) copy.orderBy = t.orderBy.filter(function (o) { return known(orderPath(o)); });
		if (t.joins) copy.joins = t.joins.filter(function (p) { return hasPath(classes, p); });
		return { template: copy, dropped: dropped };
	}

	function isGenePath(path, classes) {
		return classes ? typeOfPath(classes, path) === 'Gene' : path === 'Gene';
	}

	function editableLookups(t) {
		return (t.where || []).filter(function (c) { return c.op === 'LOOKUP' && c.editable !== false; });
	}

	function isPublic(t) {
		return Array.isArray(t.tags) && t.tags.indexOf('im:public') !== -1;
	}

	function isOff(c) {
		return c.switched === 'OFF';
	}

	// Organism lists the template limits its genes to. A gene matches when it is in every list.
	function organismLimits(t, lookup) {
		var path = lookup.path + '.organism.shortName';
		var limits = [];
		(t.where || []).forEach(function (c) {
			if (c.path !== path || c.editable !== false || isOff(c)) return;
			if (c.op === '=') limits.push([c.value]);
			if (c.op === 'ONE OF' && Array.isArray(c.values)) limits.push(c.values.slice());
		});
		if (lookup.extraValue) limits.push([lookup.extraValue]);
		return limits;
	}

	// status: 'run' (shown with a Run button) or 'hide'. A template hidden because the
	// model lacks a where path carries those paths in missing.
	function classify(t, service) {
		var classes = classesOf(service);
		if (!isPublic(t)) return { status: 'hide' };
		var lookups = editableLookups(t);
		if (lookups.length !== 1 || !isGenePath(lookups[0].path, classes)) return { status: 'hide' };
		var lookup = lookups[0];
		var dropped = [];
		if (classes) {
			var missing = missingWhere(t, classes);
			if (missing.length) return { status: 'hide', template: t, missing: missing };
			var adapted = adaptTemplate(t, classes);
			if (!adapted.template.select.length) return { status: 'hide', template: t, missing: adapted.dropped };
			if (lookup.extraValue && !hasPath(classes, lookup.path + '.organism.shortName')) {
				return { status: 'hide', template: t, missing: [lookup.path + '.organism.shortName'] };
			}
			t = adapted.template;
			dropped = adapted.dropped;
		}
		return { status: 'run', template: t, lookup: lookup, dropped: dropped, limits: organismLimits(t, lookup) };
	}

	function matchesOrganisms(limits, organisms) {
		if (!organisms) return true;
		return limits.every(function (list) {
			return list.some(function (name) { return organisms.indexOf(name) !== -1; });
		});
	}

	function limitText(limits) {
		var names = [];
		limits.forEach(function (list) {
			list.forEach(function (n) { if (names.indexOf(n) === -1) names.push(n); });
		});
		return names.join(', ');
	}

	function byTitle(a, b) {
		var x = String(a.template.title || a.template.name).toLowerCase();
		var y = String(b.template.title || b.template.name).toLowerCase();
		return x < y ? -1 : x > y ? 1 : 0;
	}

	// organisms is the list of organism short names of the selected genes, or null when unknown.
	function partition(templates, service, organisms) {
		var out = { runnable: [], skipped: [], hidden: [] };
		Object.keys(templates || {}).forEach(function (key) {
			var c = classify(templates[key], service);
			if (c.status === 'hide') {
				if (c.missing) out.hidden.push({ template: c.template, missing: c.missing });
				return;
			}
			var entry = { template: c.template, lookup: c.lookup, dropped: c.dropped };
			if (matchesOrganisms(c.limits, organisms)) {
				out.runnable.push(entry);
			} else {
				entry.reason = 'Limited to ' + limitText(c.limits) + '. Your genes are in ' + organisms.join(', ') + '.';
				out.skipped.push(entry);
			}
		});
		out.runnable.sort(byTitle);
		out.skipped.sort(byTitle);
		out.hidden.sort(byTitle);
		return out;
	}

	function copyConstraint(c) {
		var out = {};
		Object.keys(c).forEach(function (k) {
			if (k !== 'editable' && k !== 'switchable' && k !== 'extraValue') out[k] = c[k];
		});
		return out;
	}

	function replacement(lookup, target) {
		var c = { path: lookup.path, op: 'IN', value: target.listName };
		if (!target.listName) {
			c = { path: lookup.path + '.id', op: 'ONE OF', values: target.ids.map(String) };
		}
		if (lookup.code) c.code = lookup.code;
		return c;
	}

	function toOrderBy(entry) {
		if (typeof entry === 'string') return { path: entry, direction: 'ASC' };
		var path = orderPath(entry);
		return { path: path, direction: entry[path] };
	}

	// Constraint logic as a tree: {code} or {op, kids}. Returns null for logic it cannot read.
	function parseLogic(text) {
		var tokens = String(text).match(/\(|\)|[A-Za-z]+/g) || [];
		var pos = 0;
		function group(op, next) {
			var kids = [next()];
			while (tokens[pos] && tokens[pos].toLowerCase() === op) {
				pos++;
				kids.push(next());
			}
			return kids.length === 1 ? kids[0] : { op: op, kids: kids };
		}
		function atom() {
			var tok = tokens[pos++];
			if (tok === '(') {
				var inner = orExpr();
				if (tokens[pos++] !== ')') throw new Error('logic');
				return inner;
			}
			if (!tok || tok === ')' || /^(and|or)$/i.test(tok)) throw new Error('logic');
			return { code: tok };
		}
		function andExpr() { return group('and', atom); }
		function orExpr() { return group('or', andExpr); }
		try {
			var tree = orExpr();
			return pos === tokens.length ? tree : null;
		} catch (e) {
			return null;
		}
	}

	function pruneTree(node, removed) {
		if (node.code) return removed.indexOf(node.code) === -1 ? node : null;
		var kids = node.kids.map(function (k) { return pruneTree(k, removed); }).filter(Boolean);
		if (!kids.length) return null;
		return kids.length === 1 ? kids[0] : { op: node.op, kids: kids };
	}

	function logicText(node, parentOp) {
		if (node.code) return node.code;
		var s = node.kids.map(function (k) { return logicText(k, node.op); }).join(' ' + node.op + ' ');
		return parentOp && parentOp !== node.op ? '(' + s + ')' : s;
	}

	// Constraint logic without the removed codes, or null when nothing is left.
	function pruneLogic(text, removed) {
		var tree = parseLogic(text);
		if (!tree) return text;
		var kept = pruneTree(tree, removed);
		return kept ? logicText(kept, null) : null;
	}

	function unusedCode(where) {
		var used = where.map(function (c) { return c.code; });
		for (var i = 0; i < 26; i++) {
			var code = String.fromCharCode(65 + i);
			if (used.indexOf(code) === -1) return code;
		}
		return null;
	}

	// Returns a PathQuery object. target is {ids} or {ids, listName}; the template is not changed.
	// Constraints switched OFF are dropped. A lookup limited to one organism (extraValue) keeps
	// that limit as an extra constraint on the organism of the lookup path.
	function rewriteQuery(t, lookup, target) {
		var off = (t.where || []).filter(isOff);
		var where = (t.where || []).filter(function (c) { return !isOff(c); }).map(function (c) {
			return c === lookup ? replacement(lookup, target) : copyConstraint(c);
		});
		var logic = t.constraintLogic ? pruneLogic(t.constraintLogic, off.map(function (c) { return c.code; })) : null;
		var extra = lookup.extraValue ? unusedCode(t.where || []) : null;
		if (extra) {
			where.push({ path: lookup.path + '.organism.shortName', op: '=', value: lookup.extraValue, code: extra });
			if (logic) logic = '(' + logic + ') and ' + extra;
		}
		var q = { from: t.select[0].split('.')[0], select: t.select.slice(), where: where };
		if (logic) q.constraintLogic = logic;
		if (t.orderBy && t.orderBy.length) q.orderBy = t.orderBy.map(toOrderBy);
		if (t.joins && t.joins.length) q.joins = t.joins.slice();
		return q;
	}

	function geneIds(entity) {
		var v = entity && entity.Gene && entity.Gene.value;
		return (Array.isArray(v) ? v : [v])
			.filter(function (x) { return x !== undefined && x !== null && x !== ''; })
			.map(String);
	}

	function listName(context) {
		var l = context && context.list;
		return l && l.name && l.type === 'Gene' ? l.name : null;
	}

	function noun(n, word) {
		return n + ' ' + word + (n === 1 ? '' : 's');
	}

	function plainText(html) {
		return String(html).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
	}

	function pause(ms) {
		return new Promise(function (resolve) { setTimeout(resolve, ms); });
	}

	function failure(message) {
		return new Error(message);
	}

	// One request with a timeout. A 429 is retried after each delay in settings.backoffMs.
	function request(url, init, attempt) {
		var ctl = typeof AbortController === 'function' ? new AbortController() : null;
		var timer = ctl ? setTimeout(function () { ctl.abort(); }, settings.timeoutMs) : null;
		var opts = Object.assign({}, init);
		if (ctl) opts.signal = ctl.signal;
		return fetch(url, opts)
			.then(function (res) {
				if (timer) clearTimeout(timer);
				if (res.status === 429 && attempt < settings.backoffMs.length) {
					return pause(settings.backoffMs[attempt]).then(function () { return request(url, init, attempt + 1); });
				}
				if (!res.ok) throw failure('HTTP ' + res.status);
				return res.json();
			}, function (err) {
				if (timer) clearTimeout(timer);
				if (err && err.name === 'AbortError') throw failure('timed out after ' + settings.timeoutMs / 1000 + ' s');
				throw failure((err && err.message) || 'network error');
			});
	}

	function fetchTemplates(root) {
		var key = serviceRoot(root);
		if (!templateCache[key]) {
			templateCache[key] = request(templatesUrl(root), { headers: { Accept: 'application/json' } }, 0)
				.then(function (json) { return (json && json.templates) || {}; });
			templateCache[key].catch(function () { delete templateCache[key]; });
		}
		return templateCache[key];
	}

	function organismQuery(target) {
		var c = target.listName
			? '<constraint path="Gene" op="IN" value="' + escapeXml(target.listName) + '"/>'
			: '<constraint path="Gene.id" op="ONE OF">' + target.ids.map(function (id) { return '<value>' + escapeXml(id) + '</value>'; }).join('') + '</constraint>';
		return '<query model="genomic" view="Gene.organism.shortName">' + c + '</query>';
	}

	function escapeXml(s) {
		return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	// Resolves {organisms} with the organism short names of the genes, or {organisms: null, error}.
	function fetchOrganisms(root, target) {
		var body = new URLSearchParams();
		body.set('query', organismQuery(target));
		body.set('format', 'json');
		body.set('summaryPath', 'Gene.organism.shortName');
		return request(resultsUrl(root), {
			method: 'POST',
			headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
			body: body.toString()
		}, 0).then(function (json) {
			var rows = (json && json.results) || [];
			return { organisms: rows.map(function (r) { return r[0]; }).filter(Boolean) };
		}).catch(function (err) {
			return { organisms: null, error: err.message };
		});
	}

	function node(tag, text, className) {
		var e = document.createElement(tag);
		if (text !== undefined && text !== null) e.textContent = String(text);
		if (className) e.className = className;
		return e;
	}

	function attr(e, name, value) {
		e.setAttribute(name, value);
		return e;
	}

	function clear(el) {
		while (el.firstChild) el.removeChild(el.firstChild);
	}

	function message(el, text, cls, role, retry) {
		clear(el);
		var wrap = node('div', null, 'alliance-template-runner');
		wrap.appendChild(attr(node('p', text, cls), 'role', role));
		if (retry) {
			var button = node('button', 'Retry', 'btn btn-default btn-sm');
			button.addEventListener('click', function (ev) {
				if (ev && ev.preventDefault) ev.preventDefault();
				retry();
			});
			wrap.appendChild(button);
		}
		el.appendChild(wrap);
	}

	function templateItem(entry, onRun) {
		var t = entry.template;
		var title = t.title || t.name;
		var li = node('li', null, 'agr-template');
		li.appendChild(node('strong', title));
		if (t.description) li.appendChild(node('p', plainText(t.description), 'agr-note'));
		if (entry.dropped && entry.dropped.length) {
			li.appendChild(node('p', 'Columns the mine model lacks are left out: ' + entry.dropped.join(', '), 'agr-note'));
		}
		if (entry.reason) {
			li.appendChild(node('p', 'Not run: ' + entry.reason, 'agr-note'));
			return li;
		}
		var button = attr(node('button', 'Run', 'btn btn-default btn-sm'), 'aria-label', 'Run ' + title);
		button.addEventListener('click', function (ev) {
			if (ev && ev.preventDefault) ev.preventDefault();
			onRun(entry);
		});
		li.appendChild(button);
		return li;
	}

	var headingSeq = 0;

	function section(heading, entries, onRun) {
		var wrap = node('div');
		var id = 'agr-template-heading-' + (++headingSeq);
		attr(wrap.appendChild(node('h4', heading)), 'id', id);
		var ul = attr(node('ul', null, 'agr-template-list'), 'aria-labelledby', id);
		entries.forEach(function (e) { ul.appendChild(templateItem(e, onRun)); });
		wrap.appendChild(ul);
		return wrap;
	}

	function render(el, parts, onRun, organisms) {
		clear(el);
		var wrap = node('div', null, 'alliance-template-runner');
		if (organisms && organisms.error) {
			wrap.appendChild(attr(node('p', 'Could not read the organisms of your genes (' + organisms.error + '). All templates are shown.', 'agr-note'), 'role', 'alert'));
		} else if (organisms && organisms.organisms) {
			wrap.appendChild(node('p', 'Your genes are in ' + (organisms.organisms.join(', ') || 'no known organism') + '.', 'agr-note'));
		}
		if (!parts.runnable.length && !parts.skipped.length) {
			wrap.appendChild(node('p', 'No templates in this mine take a gene lookup', 'agr-empty'));
		}
		if (parts.runnable.length) wrap.appendChild(section(noun(parts.runnable.length, 'template') + ' to run', parts.runnable, onRun));
		if (parts.skipped.length) wrap.appendChild(section(noun(parts.skipped.length, 'template') + ' not run', parts.skipped, onRun));
		if (parts.hidden && parts.hidden.length) {
			var note = node('p', noun(parts.hidden.length, 'template') + ' hidden: the mine model lacks paths ' + (parts.hidden.length === 1 ? 'it uses' : 'they use') + '.', 'agr-note');
			attr(note, 'title', parts.hidden.map(function (h) { return (h.template.title || h.template.name) + ' (' + h.missing.join(', ') + ')'; }).join('\n'));
			wrap.appendChild(note);
		}
		el.appendChild(wrap);
	}

	function main(el, service, imEntity, state, config, navigate, context) {
		if (!el || !service || !imEntity) {
			throw new Error('Call main with correct signature');
		}
		var token = (el.__agrTplReq = (el.__agrTplReq || 0) + 1);
		var ids = geneIds(imEntity);
		if (!ids.length) {
			message(el, 'No genes selected', 'agr-empty', 'status');
			return;
		}
		var target = { ids: ids, listName: listName(context) };
		message(el, 'Loading templates', 'agr-loading', 'status');
		Promise.all([fetchTemplates(service.root), fetchOrganisms(service.root, target)])
			.then(function (got) {
				if (el.__agrTplReq !== token) return;
				var organisms = got[1];
				render(el, partition(got[0], service, organisms.organisms), function (entry) {
					navigate('query', rewriteQuery(entry.template, entry.lookup, target));
				}, organisms);
			})
			.catch(function (err) {
				if (el.__agrTplReq !== token) return;
				message(el, 'Could not load templates from the mine (' + err.message + ')', 'agr-error', 'alert', function () {
					main(el, service, imEntity, state, config, navigate, context);
				});
			});
	}

	var api = {
		main: main,
		settings: settings,
		clearCache: function () { templateCache = {}; },
		serviceRoot: serviceRoot,
		templatesUrl: templatesUrl,
		typeOfPath: typeOfPath,
		classify: classify,
		partition: partition,
		rewriteQuery: rewriteQuery,
		pruneLogic: pruneLogic,
		geneIds: geneIds,
		listName: listName
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceTemplateRunner = api;
})(typeof window !== 'undefined' ? window : globalThis);
