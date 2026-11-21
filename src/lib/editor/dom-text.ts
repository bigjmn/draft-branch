/** Read contentEditable text without CSS text-transform changing stored writing.
 * Browsers represent soft breaks as BR and pasted/edited paragraphs as DIV/P. */
export function editorText(root: Node): string {
  const read = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent ?? "";
    if (node.nodeName === "BR") return "\n";
    const children = Array.from(node.childNodes);
    if (children.length === 1 && children[0].nodeName === "BR") return "";
    let result = "";
    children.forEach((child, index) => {
      const paragraph = child.nodeName === "DIV" || child.nodeName === "P";
      const previous = children[index - 1];
      const previousParagraph =
        previous?.nodeName === "DIV" || previous?.nodeName === "P";
      if (
        index > 0 &&
        (previousParagraph || (paragraph && !result.endsWith("\n")))
      )
        result += "\n";
      result += read(child);
    });
    return result;
  };
  return read(root).replace(/\r\n?/g, "\n");
}
