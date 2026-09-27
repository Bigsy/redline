/** Browser adapter for redline-engine models 1 and 2. Source classes never establish ownership. */
function markerSelector(dataPrefix: string): string {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(dataPrefix))
    throw new Error("Invalid engine data prefix");
  return ["node", "unwrap", "attrs"]
    .map((name) => `[data-${dataPrefix}-op][data-${dataPrefix}-${name}]`)
    .join(", ");
}
export const MARKER_SELECTOR = markerSelector("diff");
export type Side = "before" | "after";
export interface ReviewTarget {
  operation: string;
  kind: "ins" | "del" | "attrs";
  description?: string;
  node: Element | Range;
}
export function markerKind(
  el: Element,
  dataPrefix = "diff",
): ReviewTarget["kind"] {
  if (el.hasAttribute(`data-${dataPrefix}-attrs`)) return "attrs";
  return el.getAttribute(`data-${dataPrefix}-node`) === "insert" ||
    el.getAttribute(`data-${dataPrefix}-unwrap`) === "before"
    ? "ins"
    : "del";
}
export function elements(root: ParentNode): Element[] {
  return [...root.querySelectorAll("*")].flatMap((el) => [
    el,
    ...(el.localName === "template" && "content" in el
      ? elements((el as HTMLTemplateElement).content)
      : []),
  ]);
}
/** Complete before attributes, never interpreted as HTML. Malformed metadata fails closed. */
function beforeAttributes(el: Element, dataPrefix: string): [string, string][] {
  const value: unknown = JSON.parse(
    el.getAttribute(`data-${dataPrefix}-attrs`)!,
  );
  if (
    !Array.isArray(value) ||
    !value.every(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        pair.every((part) => typeof part === "string"),
    )
  )
    throw new Error("Invalid engine attribute metadata");
  return value;
}
function targetFor(el: Element, dataPrefix: string): ReviewTarget {
  const target: ReviewTarget = {
    operation: el.getAttribute(`data-${dataPrefix}-op`)!,
    kind: markerKind(el, dataPrefix),
    node: el,
  };
  if (target.kind === "attrs") {
    const before = new Map(beforeAttributes(el, dataPrefix));
    const after = new Map(
      [...el.attributes]
        .filter((attr) => !attr.name.startsWith(`data-${dataPrefix}-`))
        .map((attr) => [attr.name, attr.value]),
    );
    const names = new Set([...before.keys(), ...after.keys()]);
    const changes = [...names].filter(
      (name) => before.get(name) !== after.get(name),
    );
    const value = (attrs: Map<string, string>, name: string) =>
      attrs.has(name) ? JSON.stringify(attrs.get(name)) : "(absent)";
    target.description =
      "Attributes changed:\n" +
      changes
        .map(
          (name) => `${name}: ${value(before, name)} → ${value(after, name)}`,
        )
        .join("\n");
  }
  return target;
}
export function reviewTargets(
  root: Element,
  dataPrefix = "diff",
): ReviewTarget[] {
  const selector = markerSelector(dataPrefix);
  return elements(root)
    .filter((el) => el.matches(selector))
    .map((el) => targetFor(el, dataPrefix));
}
/** Mutates a detached clone, processing children before ancestors; ranges track unwrapped text. */
export function projectBody(
  root: HTMLElement,
  side: Side,
  dataPrefix = "diff",
): ReviewTarget[] {
  const selector = markerSelector(dataPrefix);
  const prefix = `data-${dataPrefix}-`;
  const all = elements(root);
  // Capture ownership before removals/unwrapping can change sibling relationships.
  // Do not normalize adjacent text until all owned leads have been resolved.
  const leads = new Map<Element, ChildNode>();
  for (const el of all) {
    const lead = el.previousSibling;
    if (
      el.hasAttribute(`${prefix}lead`) &&
      lead?.nodeType === 3 &&
      /^\s*$/.test(lead.textContent ?? "")
    )
      leads.set(el, lead);
  }
  const targets: ReviewTarget[] = [];
  const textTargets: (Omit<ReviewTarget, "node"> & { node: Node })[] = [];
  for (const el of all.reverse()) {
    const owned = el.matches(selector);
    const direction = el.getAttribute(`${prefix}node`);
    if (
      (direction === "insert" && side === "before") ||
      (direction === "delete" && side === "after")
    ) {
      leads.get(el)?.remove();
      el.remove();
      continue;
    }
    const unwrap =
      el.hasAttribute(`${prefix}wrapper`) ||
      el.getAttribute(`${prefix}unwrap`) === side;
    if (owned) {
      const target = targetFor(el, dataPrefix);
      if (unwrap) {
        // Create ranges on the retained leaves, rather than on the removed shell's boundary.
        const leaves = (node: Node): void => {
          if (node.nodeType === 3 && node.textContent) {
            textTargets.push({
              ...target,
              node,
            });
          } else if (node.nodeType === 1 && !node.childNodes.length) {
            targets.push({
              ...target,
              node: node as Element,
            });
          } else node.childNodes.forEach(leaves);
        };
        el.childNodes.forEach(leaves);
      } else targets.push(target);
    }
    if (side === "before" && el.hasAttribute(`${prefix}attrs`)) {
      const attrs = beforeAttributes(el, dataPrefix);
      for (const attr of [...el.attributes]) el.removeAttributeNode(attr);
      for (const [name, value] of attrs) el.setAttribute(name, value);
    }
    for (const attr of [...el.attributes])
      if (attr.name.startsWith(prefix)) el.removeAttribute(attr.name);
    if (unwrap) el.replaceWith(...el.childNodes);
  }
  for (const target of textTargets)
    if (root.contains(target.node)) {
      const range = root.ownerDocument.createRange();
      range.selectNodeContents(target.node);
      targets.push({ ...target, node: range });
    }
  return targets.filter((target) =>
    root.contains(
      "nodeType" in target.node
        ? (target.node as Element)
        : (target.node as Range).commonAncestorContainer,
    ),
  );
}
/** Exact browser tree oracle: only attribute order and adjacent text splits are normalized. */
export function canonicalBody(root: Node): string {
  const encode = (node: Node): unknown => {
    if (node.nodeType === 3) return ["text", node.textContent];
    if (node.nodeType === 8) return ["comment", node.textContent];
    const el = node as Element;
    const children =
      el.localName === "template" && "content" in el
        ? (el as HTMLTemplateElement).content.childNodes
        : node.childNodes;
    const values: unknown[] = [];
    for (const child of children) {
      const value = encode(child) as unknown[];
      const previous = values.at(-1) as unknown[] | undefined;
      if (value[0] === "text" && previous?.[0] === "text")
        previous[1] = String(previous[1]) + value[1];
      else values.push(value);
    }
    return node.nodeType === 1
      ? [
          el.namespaceURI,
          el.localName,
          [...el.attributes]
            .map((a) => [a.namespaceURI, a.name, a.value])
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
          values,
        ]
      : values;
  };
  return JSON.stringify(encode(root));
}
