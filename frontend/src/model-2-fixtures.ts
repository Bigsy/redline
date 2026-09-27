/** Shared precision cases: unit oracle, bundled browser viewer and packaged JCEF. */
export const model2Pairs = [
  {
    name: "pretty-printed list insertion and deletion",
    before: "<ul>\n  <li>alpha</li>\n  <li>beta</li>\n  <li>gamma</li>\n</ul>",
    after: "<ul>\n  <li>alpha</li>\n  <li>gamma</li>\n  <li>delta</li>\n</ul>",
    leads: 2,
    attrs: 0,
  },
  {
    name: "pretty-printed table row and cell edits",
    before:
      "<table>\n  <tbody>\n    <tr><td>alpha</td><td>old value</td></tr>\n    <tr><td>beta</td><td>keep</td></tr>\n  </tbody>\n</table>",
    after:
      "<table>\n  <tbody>\n    <tr><td>alpha</td><td>new value</td></tr>\n    <tr><td>beta</td><td>keep</td></tr>\n    <tr><td>gamma</td><td>added</td></tr>\n  </tbody>\n</table>",
    leads: 1,
    attrs: 0,
  },
  {
    name: "attribute-only wrapper with escaped values",
    before:
      '<section class="old" title="old title" data-note="&lt;img src=x onerror=bad()&gt;"><p>same text</p></section>',
    after:
      '<section class="new" title="new &quot;title&quot;" id="added"><p>same text</p></section>',
    leads: 0,
    attrs: 1,
  },
  {
    name: "attributes and text in a table cell",
    before:
      '<table><tbody><tr><td class="old" data-note="a &amp; b">old value</td></tr></tbody></table>',
    after:
      '<table><tbody><tr><td class="new">new value</td></tr></tbody></table>',
    leads: 0,
    attrs: 1,
  },
];
