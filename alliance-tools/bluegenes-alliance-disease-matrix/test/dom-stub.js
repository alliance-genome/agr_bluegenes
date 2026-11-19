'use strict';
// Minimal DOM: createElement, createTextNode, appendChild, removeChild, firstChild, addEventListener.
class Node {
	constructor(tag) {
		this.tag = tag;
		this.children = [];
		this._text = '';
		this.listeners = {};
	}
	set textContent(v) { this._text = String(v); this.children = []; }
	get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
	get firstChild() { return this.children[0] || null; }
	appendChild(c) { this.children.push(c); return c; }
	removeChild(c) { this.children.splice(this.children.indexOf(c), 1); return c; }
	addEventListener(t, f) { this.listeners[t] = f; }
	find(tag, out = []) {
		if (this.tag === tag) out.push(this);
		this.children.forEach((c) => c.find && c.find(tag, out));
		return out;
	}
}
function install() {
	globalThis.document = {
		createElement: (t) => new Node(t),
		createTextNode: (s) => { const n = new Node('#text'); n._text = s; return n; }
	};
	return Node;
}
module.exports = { install, Node };
