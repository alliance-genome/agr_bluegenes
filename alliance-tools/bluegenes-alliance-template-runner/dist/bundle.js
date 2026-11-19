/*
 * Run templates on these genes, a BlueGenes tool (tool API version 2).
 * Plain JavaScript without dependencies, so this file is both the source and
 * the bundle. BlueGenes loads it as a script and calls
 * bluegenesAllianceTemplateRunner.main(el, service, entity, state, config, navigate, context).
 * context is undefined on hosts that do not pass it.
 */
(function (root) {
	'use strict';

	function serviceRoot(root) {
		var r = String(root || '').replace(/\/+$/, '');
		return /\/service$/.test(r) ? r : r + '/service';
	}

	function templatesUrl(root) {
		return serviceRoot(root) + '/templates?format=json';
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

	function templatePaths(t) {
		var paths = (t.select || []).slice();
		(t.where || []).forEach(function (c) { paths.push(c.path); });
		(t.orderBy || []).forEach(function (o) { paths.push(orderPath(o)); });
		return paths;
	}

	function typesKnown(t, classes) {
		return (t.where || []).every(function (c) { return !c.type || !!classes[c.type]; });
	}

	function modelHasAll(t, classes) {
		if (!classes) return true;
		return templatePaths(t).every(function (p) { return hasPath(classes, p); }) && typesKnown(t, classes);
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

	// status: 'run' (shown with a Run button), 'skip' (shown with a reason) or 'hide'.
	function classify(t, service) {
		var classes = classesOf(service);
		if (!isPublic(t) || !modelHasAll(t, classes)) return { status: 'hide' };
		var lookups = editableLookups(t);
		if (lookups.length !== 1 || !isGenePath(lookups[0].path, classes)) return { status: 'hide' };
		var lookup = lookups[0];
		if (lookup.extraValue) {
			return {
				status: 'skip',
				lookup: lookup,
				reason: 'The gene lookup is limited to "' + lookup.extraValue + '" and an id constraint would drop that limit.'
			};
		}
		return { status: 'run', lookup: lookup };
	}

	function byTitle(a, b) {
		var x = String(a.template.title || a.template.name).toLowerCase();
		var y = String(b.template.title || b.template.name).toLowerCase();
		return x < y ? -1 : x > y ? 1 : 0;
	}

	function partition(templates, service) {
		var out = { runnable: [], skipped: [] };
		Object.keys(templates || {}).forEach(function (key) {
			var t = templates[key];
			var c = classify(t, service);
			if (c.status === 'run') out.runnable.push({ template: t, lookup: c.lookup });
			if (c.status === 'skip') out.skipped.push({ template: t, lookup: c.lookup, reason: c.reason });
		});
		out.runnable.sort(byTitle);
		out.skipped.sort(byTitle);
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

	// Returns a PathQuery object. target is {ids} or {ids, listName}; the template is not changed.
	function rewriteQuery(t, lookup, target) {
		var q = {
			from: t.select[0].split('.')[0],
			select: t.select.slice(),
			where: (t.where || []).map(function (c) {
				return c === lookup ? replacement(lookup, target) : copyConstraint(c);
			})
		};
		if (t.constraintLogic) q.constraintLogic = t.constraintLogic;
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
		var wrap = node('div', null, 'alliance-template-runner');
		wrap.appendChild(node('p', text, cls));
		el.appendChild(wrap);
	}

	function templateItem(entry, onRun) {
		var t = entry.template;
		var li = node('li', null, 'agr-template');
		li.appendChild(node('strong', t.title || t.name));
		if (t.description) li.appendChild(node('p', t.description, 'agr-note'));
		if (entry.reason) {
			li.appendChild(node('p', 'Not run: ' + entry.reason, 'agr-note'));
			return li;
		}
		var button = node('button', 'Run', 'btn btn-default btn-sm');
		button.addEventListener('click', function (ev) {
			if (ev && ev.preventDefault) ev.preventDefault();
			onRun(entry);
		});
		li.appendChild(button);
		return li;
	}

	function section(heading, entries, onRun) {
		var wrap = node('div');
		wrap.appendChild(node('h4', heading));
		var ul = node('ul', null, 'agr-template-list');
		entries.forEach(function (e) { ul.appendChild(templateItem(e, onRun)); });
		wrap.appendChild(ul);
		return wrap;
	}

	function render(el, parts, onRun) {
		clear(el);
		var wrap = node('div', null, 'alliance-template-runner');
		if (!parts.runnable.length && !parts.skipped.length) {
			wrap.appendChild(node('p', 'No templates in this mine take a gene lookup', 'agr-empty'));
		}
		if (parts.runnable.length) wrap.appendChild(section(parts.runnable.length + ' templates to run', parts.runnable, onRun));
		if (parts.skipped.length) wrap.appendChild(section(parts.skipped.length + ' templates not run', parts.skipped, onRun));
		el.appendChild(wrap);
	}

	function fetchTemplates(root) {
		return fetch(templatesUrl(root), { headers: { Accept: 'application/json' } })
			.then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status);
				return res.json();
			})
			.then(function (json) { return (json && json.templates) || {}; });
	}

	function main(el, service, imEntity, state, config, navigate, context) {
		if (!el || !service || !imEntity) {
			throw new Error('Call main with correct signature');
		}
		var token = (el.__agrTplReq = (el.__agrTplReq || 0) + 1);
		var ids = geneIds(imEntity);
		if (!ids.length) {
			message(el, 'No genes selected', 'agr-empty');
			return;
		}
		var target = { ids: ids, listName: listName(context) };
		message(el, 'Loading templates', 'agr-loading');
		fetchTemplates(service.root)
			.then(function (templates) {
				if (el.__agrTplReq !== token) return;
				render(el, partition(templates, service), function (entry) {
					navigate('query', rewriteQuery(entry.template, entry.lookup, target));
				});
			})
			.catch(function () {
				if (el.__agrTplReq !== token) return;
				message(el, 'Could not load templates from the mine', 'agr-error');
			});
	}

	var api = {
		main: main,
		serviceRoot: serviceRoot,
		templatesUrl: templatesUrl,
		typeOfPath: typeOfPath,
		classify: classify,
		partition: partition,
		rewriteQuery: rewriteQuery,
		geneIds: geneIds,
		listName: listName
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.bluegenesAllianceTemplateRunner = api;
})(typeof window !== 'undefined' ? window : globalThis);
