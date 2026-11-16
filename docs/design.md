# Alliance design foundation

BlueGenes follows the look of alliancegenome.org for all mines. Tokens and shared classes live in `less/alliance/`, imported last from `less/site.less`.

- `less/alliance/tokens.less`: CSS custom properties on `:root`, prefix `--agr-`.
- `less/alliance/components.less`: global defaults and the `.agr-*` classes.

Tool bundles can use the same classes and `var(--agr-*)` values, since they load inside the BlueGenes page.

## Rules

- Chrome (navbar, buttons, section headers) uses the Alliance palette for every mine. Logos and mine names stay.
- Bootstrap 3 stays. Overrides are in `components.less`; do not rename existing classes that im-tables or tools use.
- Text contrast is at least 4.5:1. Use `--agr-muted` for text. `--agr-secondary` (#7f7f7f) is for borders and outline buttons only.
- Focus ring is 2px `--agr-primary`.
- At 375px wide, tables scroll inside `.agr-table-wrap`, not the page.

## Mine branding colours

Mines still send `branding.colors.header.{main,secondary,text}` in web properties. The cljs (`views.cljs`) still sets `--branding-header-*` on `.approot`, but no Less variable reads them any more. `@extra-color-*`, `@branding-color-*`, `@highlight-color` and `@link-color` in `less/variables.less` are fixed to the Alliance values, so every old rule that used them now renders in Alliance blue. To bring mine colours back for one element, read `var(--branding-header-main)` directly.

## Tokens

| Token | Value | Use |
|---|---|---|
| `--agr-font`, `--agr-font-mono` | Lato, Helvetica, sans-serif / SFMono stack | text, code |
| `--agr-font-size`, `--agr-line-height` | 14.4px, 1.5 | body |
| `--agr-h1-size`, `--agr-h3-size`, `--agr-h4-size` | 36px, 25.2px, 18px | headings (weight 500) |
| `--agr-text`, `--agr-muted`, `--agr-secondary` | #212529, #6c757d, #7f7f7f | text, muted text, outlines |
| `--agr-primary`, `--agr-primary-dark`, `--agr-primary-light` | #2598c5, #2681a6, #adddf0 | navbar and buttons, links and hover, focus halo |
| `--agr-border`, `--agr-border-strong` | #dee2e6, #ced4da | rules, inputs |
| `--agr-bg`, `--agr-bg-light`, `--agr-bg-hover` | #fff, #f8f9fa, #e9ecef | surfaces |
| `--agr-success`, `--agr-danger`, `--agr-warning`, `--agr-info` | #28a745, #dc3545, #ffc107, #17a2b8 | status |
| `--agr-radius` | 4px | corners |
| `--agr-space-1` to `--agr-space-6` | 4, 8, 12, 16, 24, 32px | spacing |
| `--agr-heat-1` to `--agr-heat-6` | #f0f6fc to #08519c | count scales |

Global defaults set by `components.less`: Lato on body, forms, buttons and headings; text colour; link colour (primary-dark, underline on hover); `.btn-primary`, `.nav-pills` active and `.form-control:focus` in primary; 2px primary focus ring on `:focus-visible`.

## Components

### .agr-section
```html
<section class="agr-section">
  <h3 class="agr-section-title">Orthology <span class="agr-help" title="Help">?</span></h3>
  ...
</section>
```

### .agr-page-title, .agr-subtitle
`.agr-page-title` is the one H1-sized heading of a page (28px below 768px). `.agr-subtitle` is a bold 18px heading for a panel or tool.
```html
<h2 class="agr-page-title">Lists</h2>
<h4 class="agr-subtitle">Paralog families</h4>
```

### .agr-attrs
A `dl`, 16px margin below. Use `.agr-na` for missing values. Below 576px the label sits over the value.
```html
<dl class="agr-attrs">
  <dt>Symbol</dt><dd>TP53</dd>
  <dt>Synonyms</dt><dd class="agr-na">Not available</dd>
</dl>
```

### .agr-table, .agr-table-striped, .agr-table-sm, .num, .agr-table-wrap
`.agr-table-wrap` has 16px margin below, and a `.agr-btn*` right after it gets 8px above. Consecutive `tbody` elements get a rule between them.
```html
<div class="agr-table-wrap">
  <table class="agr-table agr-table-sm">
    <thead><tr><th>Species</th><th class="num">Genes</th></tr></thead>
    <tbody><tr><td>Human</td><td class="num">12</td></tr></tbody>
  </table>
</div>
```

### .agr-tabs
Add `class="active"` to the current `li` or button (or `aria-selected="true"` on the link or button). The container is a `ul` of `li` or a `div` of buttons.
```html
<ul class="agr-tabs" role="tablist">
  <li class="active"><button role="tab">Orthologs <span class="agr-count">12</span></button></li>
  <li><button role="tab">Paralogs</button></li>
</ul>

<div class="agr-tabs" role="tablist">
  <button role="tab" aria-selected="true">Orthologs</button>
  <button role="tab">Paralogs</button>
</div>
```

### .agr-btn, .agr-btn-primary, .agr-btn-danger, .agr-btn-sm
```html
<button class="agr-btn">Download</button>
<button class="agr-btn-danger">Delete</button>
<button class="agr-btn-primary agr-btn-sm">Search</button>
```

### .agr-badge, .agr-badge-primary, .agr-badge-truncate
Badges never wrap. `.agr-badge-truncate` cuts long text at 14em with an ellipsis; set `max-width` to change it.
```html
<span class="agr-badge">Best</span> <span class="agr-badge agr-badge-primary">12</span>
```

### .agr-count
Muted count after a label, in tabs or anywhere else.
```html
<h3>Orthologs <span class="agr-count">12</span></h3>
```

### .agr-empty, .agr-loading, .agr-error
```html
<p class="agr-empty">No data available</p>
<p class="agr-loading">Loading</p>
<p class="agr-error">Could not load data</p>
```

### .agr-note, .agr-notice-warning
`.agr-note` wraps long words. `.agr-notice-warning` is a box with a warning-coloured left border.
```html
<p class="agr-note">Data from RGD</p>
<p class="agr-notice-warning">Only the first 2000 rows are shown.</p>
```

### .agr-filter-bar
```html
<div class="agr-filter-bar">
  <label>Species <select class="form-control"></select></label>
  <label><input type="checkbox"> Best only</label>
  <label>Threshold <input type="number" class="form-control"></label>
</div>
```
Inside the bar `.form-control` has auto width and height, `input[type=number]` is 6em wide, and labels around a checkbox or radio are regular weight.

### Links: .agr-link, .agr-external, .agr-external-icon
Plain `a` is already primary-dark. `a.agr-external` appends a Font Awesome external-link icon. Add `.agr-external-icon` in dense columns to show only the icon (keep a `title`).
```html
<a class="agr-external" href="https://www.alliancegenome.org">Alliance</a>
<a class="agr-external agr-external-icon" title="Alliance" href="https://www.alliancegenome.org">Alliance</a>
```

### .agr-heat-1 to .agr-heat-6
Background from the heat scale; text turns white from step 4.
```html
<td class="agr-heat-4 num">23</td>
```

## Reagent example

```clojure
[:section.agr-section
 [:h3.agr-section-title "Homologues"]
 [:p.agr-note "Data from the Alliance"]]
```
