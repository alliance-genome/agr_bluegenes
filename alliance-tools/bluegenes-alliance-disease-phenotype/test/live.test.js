'use strict';
// Runs main() against a local test mine. Skipped when the mine does not answer.
// ALLIANCE_TESTMINE_ROOT overrides the service root.
const test = require('node:test');
const assert = require('node:assert');

const ROOT = process.env.ALLIANCE_TESTMINE_ROOT || 'http://localhost:9999/alliancetestmine/service';

class Node_ {
	constructor(tag) {
		this.tag = tag;
		this.children = [];
		this._text = '';
		this.className = '';
	}
	get firstChild() {
		return this.children[0] || null;
	}
	appendChild(c) {
		this.children.push(c);
		return c;
	}
	removeChild(c) {
		this.children.splice(this.children.indexOf(c), 1);
	}
	set textContent(v) {
		this.children = [];
		this._text = String(v);
	}
	get textContent() {
		return this._text;
	}
	addEventListener() {}
}
global.document = { createElement: (t) => new Node_(t) };

const tool = require('../dist/bundle.js');

function dump(node, depth = 0, lines = []) {
	const pad = '  '.repeat(depth);
	if (node.tag === 'tr') {
		lines.push(pad + node.children.map((c) => flat(c)).join(' | '));
	} else {
		if (node._text && node.children.length === 0) lines.push(pad + node._text);
		node.children.forEach((c) => dump(c, depth + 1, lines));
	}
	return lines;
}
function flat(n) {
	return n._text + n.children.map(flat).join('');
}

async function internalId(primaryIdentifier) {
	const q =
		'<query model="genomic" view="Gene.id"><constraint path="Gene.primaryIdentifier" op="=" value="' +
		primaryIdentifier +
		'"/></query>';
	const res = await fetch(ROOT + '/query/results?format=json&query=' + encodeURIComponent(q), {
		signal: AbortSignal.timeout(15000)
	});
	const json = await res.json();
	return json.results[0][0];
}

async function reachable() {
	try {
		const res = await fetch(ROOT + '/version', { signal: AbortSignal.timeout(5000) });
		return res.ok;
	} catch (e) {
		return false;
	}
}

async function run(primaryIdentifier) {
	const id = await internalId(primaryIdentifier);
	const el = new Node_('div');
	tool.main(el, { root: ROOT }, { Gene: { class: 'Gene', format: 'id', value: id } });
	for (let i = 0; i < 100 && /Loading/.test(JSON.stringify(dump(el))); i++) {
		await new Promise((r) => setTimeout(r, 100));
	}
	const out = dump(el);
	console.log('--- ' + primaryIdentifier + ' (Gene.id ' + id + ')\n' + out.join('\n'));
	return out.join('\n');
}

test('live: HGNC:11179 has disease rows', async (t) => {
	if (!(await reachable())) return t.skip('test mine not reachable');
	const out = await run('HGNC:11179');
	assert.match(out, /DOID:/);
	assert.doesNotMatch(out, /Could not load/);
});

test('live: HGNC:620 has phenotype rows', async (t) => {
	if (!(await reachable())) return t.skip('test mine not reachable');
	const out = await run('HGNC:620');
	assert.match(out, /abnormal locomotor behavior/);
	assert.doesNotMatch(out, /Could not load/);
});
