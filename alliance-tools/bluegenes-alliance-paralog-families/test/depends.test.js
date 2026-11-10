'use strict';
const test = require('node:test');
const assert = require('node:assert');
const config = require('../config.json');
const fixture = require('./fixtures/alliancemine-model.json');

const classes = fixture.model.classes;

function member(cls, name) {
	const seen = new Set();
	const queue = [cls];
	while (queue.length) {
		const c = queue.shift();
		if (seen.has(c) || !classes[c]) continue;
		seen.add(c);
		for (const kind of ['attributes', 'references', 'collections']) {
			if (classes[c][kind] && classes[c][kind][name]) return { kind, def: classes[c][kind][name] };
		}
		[].concat(classes[c].extends || []).forEach((x) => queue.push(x));
	}
	return null;
}

// A path resolves when the root is a class and every segment is a member of the
// class reached so far (inherited members included). Only the last segment may
// be an attribute.
function resolves(p) {
	const segs = p.split('.');
	let cur = segs[0];
	if (!classes[cur]) return false;
	for (let i = 1; i < segs.length; i++) {
		const m = member(cur, segs[i]);
		if (!m) return false;
		if (m.kind === 'attributes') return i === segs.length - 1;
		cur = m.def.referencedType;
	}
	return true;
}

test('config depends is a non-empty array of strings', () => {
	assert.ok(Array.isArray(config.depends) && config.depends.length > 0);
	config.depends.forEach((d) => assert.strictEqual(typeof d, 'string'));
});

test('every depends path resolves in the AllianceMine model', () => {
	const missing = config.depends.filter((d) => !resolves(d));
	assert.deepStrictEqual(missing, []);
});

test('the resolver rejects a path that is not in the model', () => {
	assert.strictEqual(resolves('Gene.noSuchCollection.id'), false);
	assert.strictEqual(resolves('NoSuchClass'), false);
});
