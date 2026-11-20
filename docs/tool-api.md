# Tool API 2

BlueGenes tools are scripts that call a global `main` function when the host mounts them. This page lists the arguments, the context object, `config.json` keys used by the host, and tool groups. `tool-api` stays at 2: tools written before the context argument keep working.

## main

```js
main(el, service, package, state, config, navigate, context)
```

| Argument | Content |
| --- | --- |
| `el` | DOM element to render into |
| `service` | `{root, token, model, ...}` of the current mine. Use `service.root`, never a fixed mine URL |
| `package` | Entities by class. `package.Gene.value` is the id (report page) or an array of ids (list and results pages). `package.Gene.class` is the class name |
| `state` | Empty object |
| `config` | The tool's `config.json` |
| `navigate` | `navigate('report', {type, id}, mine)`, `navigate('query', pathQuery, mine)`, `navigate('list', listName, mine)` |
| `context` | Added in this version. Undefined on older hosts, so check before use |

## context

```js
{
  mine,      // namespace of the current mine, e.g. "alliancemine"
  list,      // {name, title, size, type} on a saved list page, else null
  query,     // PathQuery (JS object) behind the results page, null on a report page
  intent,    // intent string of the results page ("list", "query", "tool", ...), null on a report page
  page,      // "report", "results" or "list"
  saveList   // function, see below
}
```

The host builds the context each time it starts a tool. Changing the query on the results page remounts the tools, so `main` runs again with a new context.

`list` is null as soon as the query on the results page is no longer exactly one `IN` constraint on the saved list.

### saveList

```js
context.saveList({name: 'My genes', class: 'Gene', ids: [101, 102], tags: ['bluegenes']})
  .then(function (savedName) { ... })
  .catch(function (err) { ... });
```

- `ids` are InterMine object ids, not identifiers. They are sent in the request body.
- `tags` is optional.
- The Promise resolves with the saved list name. If a list with `name` exists, the host saves `name_1` (or the next free number) and resolves with that name.
- The Promise rejects with an `Error`. `err.message` is `login required` for anonymous users. Invalid arguments (empty name, class that is not a plain class name, no ids, ids that are not integers) reject with a message starting `saveList:`. Server failures reject with the server message.
- After a save the host refreshes the lists of the current mine.

Hide save buttons when `context` or `context.saveList` is missing:

```js
var canSave = context && typeof context.saveList === 'function';
```

## config.json keys read by the host

| Key | Meaning |
| --- | --- |
| `accepts`, `classes`, `depends` | Where the tool shows, see `suitable-entities` in `src/cljs/bluegenes/utils.cljs` |
| `threshold` | Largest number of ids the tool starts with on its own. Default 1000. Above it the tool stays collapsed with a notice, and the user can start it by clicking the heading |
| `group` | `Annotation`, `Enrichment`, `Export` or `Other`. Optional, see below |

## Groups

The results page lists tools under the headings Annotation, Enrichment, Export and Other, in that order. Empty groups are hidden. A heading collapses its tools. Tools in a collapsed group are not started, and the state lives at `[:tools :collapsed-groups]` in the app db.

The group of a tool comes from, in order:

1. `group` in the tool's own `config.json`.
2. The `:groups` map in `resources/tool-depends.edn`, keyed by npm package name. The backend adds it to `config.group` when it serves `/api/tools/all`.
3. `Other`.

Add an entry to `:groups` for every new `@intermine` or `@alliance` tool, or set `group` in its `config.json`. `test/clj/bluegenes/ws/tool_depends_test.clj` fails when an Alliance tool has neither.
