// What a list's custom CSS can target. The MCP get_style_guide tool returns
// this, and the Style tab in a list's settings shows it, so it has to stay in
// step with web/src/styles.css.

export const STYLE_GUIDE = `# Styling a Shared List page

A list's custom CSS loads after the built-in stylesheet, so a rule here wins over
the default with the same selector. It applies only to that list's page, for
everyone who opens it. Start with the variables; most restyles need nothing else.

## Variables (set them on :root)

Colors
  --sl-paper        page background
  --sl-surface      cards, inputs, dialogs
  --sl-ink          main text, primary buttons
  --sl-ink-soft     secondary text
  --sl-ink-faint    hints, placeholders, empty cells
  --sl-rule         lines between rows, progress track
  --sl-margin       the heavy line under the column headings and above totals
  --sl-accent       ticks, the strike-through on done rows, progress fill, switches
  --sl-border       input and card borders
  --sl-highlight    the cell being edited
  --sl-focus        keyboard focus ring
  --sl-danger       delete actions and errors
  --sl-tag-<color>-bg / --sl-tag-<color>-fg
                    choice tags; <color> is gray, red, orange, yellow, green,
                    teal, blue, purple or pink

Type and shape
  --sl-font           body text
  --sl-font-display   the title (also dialog headings)
  --sl-font-mono      column headings, labels, metadata
  --sl-title-stretch  width of the title face, 62%–125% (default 125%)
  --sl-title-weight   weight of the title (default 800)
  --sl-radius         corner radius of buttons and inputs
  --sl-row-height     minimum height of a row on wide screens
  --sl-max-width      width of the page column

Dark mode: the defaults switch under @media (prefers-color-scheme: dark). Set
your own there too, or set colors once on :root to use them in both modes.

## Structure

  body[data-page="list"]      the list page (also "lock", "landing", "admin")
  .sl-app[data-list="<id>"]   page root; data-role is admin, editor or viewer
  .sl-topbar  .sl-brand  .sl-actions  .sl-button  .sl-icon-button
  .sl-main                    the page column
  .sl-header  .sl-title  .sl-description  .sl-meta
  .sl-tally  .sl-progress  .sl-progress-fill  .sl-stats  .sl-stat
  .sl-toolbar  .sl-search  .sl-add (the Add item button)
  .sl-sheet                   scroll container around the table
  .sl-table                   grid; its columns come from --sl-columns
  .sl-head  .sl-th[data-col][data-type]
  .sl-body
  .sl-group[data-group]  .sl-group-title  .sl-group-label  .sl-group-count  .sl-group-total
  .sl-row[data-item][data-done]
  .sl-cell[data-col][data-type][data-label][data-primary][data-empty]
  .sl-quick-add               the "Add item…" line under the rows (wide screens)
  .sl-foot                    totals
  .sl-empty                   shown when the list has no items
  .sl-dialog  .sl-dialog-head  .sl-form  .sl-field  .sl-label  .sl-input
  .sl-toast

Inside cells
  .sl-text   .sl-num   .sl-date   .sl-blank (the dash in an empty cell)
  .sl-tag[data-color][data-value]
  .sl-link   .sl-thumb   .sl-check[aria-checked="true"]

## Data attributes worth knowing

  data-col="<column id>" on .sl-th and .sl-cell. Column ids come from the
    column's first name, lowercased with dashes ("Got it" → got-it), and stay
    the same when the column is renamed. get_list shows them.
  data-type="text|number|currency|url|image|checkbox|select|date"
  data-primary on the row's name cell (the first text column).
  data-done on a row whose first checkbox column is ticked.
  data-col-<column id>="<value>" on .sl-row for every choice and checkbox
    column, so a whole row can be styled by its value.
  data-value="<option>" and data-color="<color>" on .sl-tag.

## Phones

Below 720px wide the head row and quick-add line are hidden and each .sl-row
becomes a wrapped block: the checkbox sits at the left, an image at the right,
the primary cell on its own line, and the rest flowing after it. Wrap layout
changes for phones in @media (max-width: 719px).

## Fonts and images

Fonts can come from Google Fonts:
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,700&display=swap');
@import has to be the first rule. Other font hosts are blocked by the page's
Content-Security-Policy. Background images may come from any https URL.

## Examples

Warm and soft:
  :root {
    --sl-paper: #fff8f0;
    --sl-surface: #fffdf9;
    --sl-rule: #f0dcc8;
    --sl-margin: #c2410c;
    --sl-accent: #c2410c;
    --sl-radius: 10px;
  }

Fade rows that are done, and tint ones marked urgent:
  .sl-row[data-done] { opacity: 0.55; }
  .sl-row[data-col-priority="Urgent"] { background: var(--sl-tag-red-bg); }

A different title face:
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,700&display=swap');
  :root { --sl-font-display: 'Fraunces', serif; --sl-title-stretch: 100%; --sl-title-weight: 700; }

Hide a column on phones only:
  @media (max-width: 719px) { .sl-cell[data-col="notes"] { display: none; } }
`;
