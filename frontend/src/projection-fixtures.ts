import { model2Pairs } from "./model-2-fixtures";
export const projectionPairs = [
  ...model2Pairs.map(({ before, after }) => [before, after]),
  ["<p>hello world</p>", "<p>hello <b>world</b></p>"],
  ["<p><b>one two</b> three</p>", "<p>one <i>two three</i></p>"],
  ["<ul><li>a</li></ul>", "<ul><li>a</li><li>b<ul><li>c</li></ul></li></ul>"],
  [
    "<table><tbody><tr><td>a</td></tr></tbody></table>",
    '<table><tbody><tr><td class="x">a</td><td>b</td></tr></tbody></table>',
  ],
  ['<p class="a">same</p><hr>', '<p class="b">same</p><hr><br><div></div>'],
  [
    '<ins class="redline">source</ins><del>old</del>',
    '<ins class="redline">source</ins><del>new</del>',
  ],
  ["<pre>a  b\n</pre>", "<pre>a b\n\n</pre>"],
  [
    "<template><template><p>a</p></template></template>",
    "<template><template><p>b</p></template></template>",
  ],
  ['<svg><circle r="1"/></svg>', '<svg><circle r="2"/></svg>'],
];
