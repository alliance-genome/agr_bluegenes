'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

let Node;
try {
	Node = require('./dom-stub.js').install();
} catch (e) {
	Node = class {
		constructor(tag) { this.tag = tag; this.children = []; this._text = ''; this.className = ''; this.attrs = {}; }
		set textContent(v) { this._text = String(v); this.children = []; }
		get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
		get firstChild() { return this.children[0] || null; }
		appendChild(c) { this.children.push(c); return c; }
		removeChild(c) { this.children.splice(this.children.indexOf(c), 1); return c; }
		addEventListener() {}
		setAttribute(k, v) { this.attrs[k] = String(v); }
		find(tag, out = []) { if (this.tag === tag) out.push(this); this.children.forEach((c) => c.find && c.find(tag, out)); return out; }
	};
	globalThis.document = { createElement: (t) => new Node(t), createTextNode: (s) => { const n = new Node('#text'); n._text = s; return n; } };
}
const tool = require('../dist/bundle.js');
const config = require('../config.json');
const accepts = config.accepts;
const entity = { [config.classes[0]]: { value: ['1', '2'] } };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('an empty result for a list says these genes', async () => {
	globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ results: [] }), text: async () => '0' });
	const el = document.createElement('div');
	tool.main(el, { root: 'http://h/m' }, entity, {}, {}, () => {});
	await wait(80);
	assert.match(el.textContent, /these genes/);
	assert.doesNotMatch(el.textContent, /this gene/);
});
