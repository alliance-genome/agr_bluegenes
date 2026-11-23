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
  saveList,  // function, see below
  onDestroy  // function, see below
}
```

The host builds the context each time it starts a tool. Changing the query on the results page remounts the tools, so `main` runs again with a new context.

`saveList` is bound to `context.mine`. If the user has switched to another mine when it is called, the Promise rejects. `navigate` also uses `context.mine` when its third argument is missing.

`list` is null as soon as the query on the results page is no longer exactly one `IN` constraint on the saved list.

### onDestroy

```js
context.onDestroy(function () { controller.abort(); });
```

The callback runs once when the tool is removed from the page, and before `main` runs again for the same element. Use it to cancel requests and timers. Register again in each `main` call. Undefined on older hosts, so check before use.

### saveList

```js
context.saveList({name: 'My genes', class: 'Gene', ids: [101, 102], tags: ['bluegenes']})
  .then(function (savedName) { ... })
  .catch(function (err) { ... });
```

- `ids` are InterMine object ids, not identifiers. They are sent as a `ONE OF` constraint in the form body of the `/query/tolist` request.
- `tags` is optional.
- The Promise resolves with the saved list name. If a list with `name` exists, the host saves `name_1` (or the next free number) and resolves with that name.
- The Promise rejects with an `Error`. `err.message` is `login required` when no user is logged in to the mine. Anonymous sessions have a token too, so the host checks the login, not the token. Invalid arguments (empty name, class that is not a plain class name, no ids, ids that are not positive integers) reject with a message starting `saveList:`. Server failures reject with the server message.
- An id is a positive integer, or a string of digits without a leading zero.
- After a save the host refreshes the lists of the current mine and shows a message with a link to the new list, the number of ids, and a note when the name was taken. When no user is logged in, the host shows a message with a link to log in.

Hide save buttons when `context` or `context.saveList` is missing:

```js
var canSave = context && typeof context.saveList === 'function';
```

## config.json keys read by the host

| Key | Meaning |
| --- | --- |
| `accepts`, `classes`, `depends` | Where the tool shows, see `suitable-entities` in `src/cljs/bluegenes/utils.cljs` |
| `threshold` | Largest number of ids the tool starts with on its own. Default 1000. Above it the tool stays collapsed with a notice of the id count and the limit, and the user can start it with "Run anyway" or by clicking the heading. The choice holds until the entity changes, for example by editing the query |
| `group` | `Annotation`, `Enrichment`, `Export` or `Other`. Optional, see below |

## Groups

The results page lists tools under the headings Annotation, Enrichment, Export and Other, in that order. Empty groups are hidden. A heading collapses its tools. Tools in a collapsed group are not started. The state lives at `[:tools :collapsed-groups]` in the app db, and collapsed tools at `[:tools :collapsed]`. Both are kept in localStorage under `bluegenes/tools-collapsed`.

## Failures

When a tool script does not load within 20 seconds, fails to load, or `main` throws, the host shows the message and a Retry button in the tool element, and adds a warning message. Tools that call the mine should also time out, retry after HTTP 429 with backoff, and say in their element when a result is cut short or a request fails.

The group of a tool comes from, in order:

1. `group` in the tool's own `config.json`.
2. The `:groups` map in `resources/tool-depends.edn`, keyed by npm package name. The backend adds it to `config.group` when it serves `/api/tools/all`.
3. `Other`.

Add an entry to `:groups` for every new `@intermine` or `@alliance` tool, or set `group` in its `config.json`. `test/clj/bluegenes/ws/tool_depends_test.clj` fails when an Alliance tool has neither.
