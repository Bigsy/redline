/** Browser adapter for redline-engine model 1. Source classes never establish ownership. */
export const MARKER_SELECTOR =
  "[data-diff-op][data-diff-node], [data-diff-op][data-diff-unwrap]";
export type Side = "before" | "after";
export interface ReviewTarget {
  operation: string;
  kind: "ins" | "del";
  node: Element | Range;
}
export function markerKind(el: Element): "ins" | "del" {
  return el.getAttribute("data-diff-node") === "insert" ||
    el.getAttribute("data-diff-unwrap") === "before"
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
export function reviewTargets(root: Element): ReviewTarget[] {
  return elements(root)
    .filter((el) => el.matches(MARKER_SELECTOR))
    .map((el) => ({
      operation: el.getAttribute("data-diff-op")!,
      kind: markerKind(el),
      node: el,
    }));
}
/** Mutates a detached clone, processing children before ancestors; ranges track unwrapped text. */
export function projectBody(root: HTMLElement, side: Side): ReviewTarget[] {
  const targets: ReviewTarget[] = [];
  const textTargets: { operation: string; kind: "ins" | "del"; node: Node }[] =
    [];
  for (const el of elements(root).reverse()) {
    const owned = el.matches(MARKER_SELECTOR);
    const direction = el.getAttribute("data-diff-node");
    if (
      (direction === "insert" && side === "before") ||
      (direction === "delete" && side === "after")
    ) {
      el.remove();
      continue;
    }
    const unwrap =
      el.hasAttribute("data-diff-wrapper") ||
      el.getAttribute("data-diff-unwrap") === side;
    if (owned) {
      if (unwrap) {
        // Create ranges on the retained leaves, rather than on the removed shell's boundary.
        const leaves = (node: Node): void => {
          if (node.nodeType === 3 && node.textContent) {
            textTargets.push({
              operation: el.getAttribute("data-diff-op")!,
              kind: markerKind(el),
              node,
            });
          } else if (node.nodeType === 1 && !node.childNodes.length) {
            targets.push({
              operation: el.getAttribute("data-diff-op")!,
              kind: markerKind(el),
              node: node as Element,
            });
          } else node.childNodes.forEach(leaves);
        };
        el.childNodes.forEach(leaves);
      } else
        targets.push({
          operation: el.getAttribute("data-diff-op")!,
          kind: markerKind(el),
          node: el,
        });
    }
    for (const attr of [...el.attributes])
      if (attr.name.startsWith("data-diff-")) el.removeAttribute(attr.name);
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
