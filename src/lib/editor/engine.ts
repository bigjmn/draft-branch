import {
  ELEMENT_LABELS,
  NEXT_ELEMENT,
  type EditorLayout,
  type ElementType,
  type ScriptBlock,
} from "./types";

interface Callbacks {
  onChange: (blocks: ScriptBlock[]) => void;
  onSelection: (id: string, type: ElementType) => void;
  onLayout: (layout: EditorLayout) => void;
}

/** Owns only the contentEditable subtree. React owns the surrounding application.
 * Keeping typed DOM editing here avoids React replacing the caret on every input.
 */
export class ScreenplayEngine {
  private abort = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: HTMLDivElement | null = null;

  constructor(
    private root: HTMLDivElement,
    blocks: ScriptBlock[],
    private callbacks: Callbacks,
  ) {
    const content = this.createPage();
    blocks.forEach((block) => content.append(this.createBlock(block)));
    const options = { signal: this.abort.signal };
    root.addEventListener("focusin", this.onFocus, options);
    root.addEventListener("input", this.onInput, options);
    root.addEventListener("keydown", this.onKeyDown, options);
    root.addEventListener("paste", this.onPaste, options);
    this.paginate();
  }

  destroy() {
    this.abort.abort();
    clearTimeout(this.timer);
    this.root.replaceChildren();
  }

  private blocks() {
    return Array.from(this.root.querySelectorAll<HTMLDivElement>(".block"));
  }
  private type(block: HTMLElement) {
    return block.dataset.type as ElementType;
  }
  private text(block: HTMLElement) {
    return block.innerText.replace(/\r/g, "");
  }
  private createBlock(value: ScriptBlock) {
    const block = document.createElement("div");
    block.className = "block";
    block.contentEditable = "true";
    block.spellcheck = true;
    block.dataset.id = value.id;
    this.applyType(block, value.type);
    block.setAttribute("role", "textbox");
    block.setAttribute("aria-multiline", "true");
    block.textContent = value.text;
    return block;
  }
  private applyType(block: HTMLElement, type: ElementType) {
    block.dataset.type = type;
    block.dataset.placeholder = ELEMENT_LABELS[type];
    block.setAttribute("aria-label", ELEMENT_LABELS[type]);
  }
  private createPage() {
    const page = document.createElement("article");
    page.className = "page";
    const content = document.createElement("div");
    content.className = "page-content";
    page.append(content);
    this.root.append(page);
    return content;
  }
  private changed() {
    this.callbacks.onChange(
      this.blocks().map((block) => ({
        id: block.dataset.id!,
        type: this.type(block),
        text: this.text(block),
      })),
    );
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.paginate(), 400);
  }
  private onFocus = (event: FocusEvent) => {
    const block = event.target;
    if (!(block instanceof HTMLDivElement) || !block.matches(".block")) return;
    this.active = block;
    this.callbacks.onSelection(block.dataset.id!, this.type(block));
  };
  private onInput = () => this.changed();
  private onPaste = (event: ClipboardEvent) => {
    if (
      !(event.target instanceof HTMLElement) ||
      !event.target.matches(".block")
    )
      return;
    event.preventDefault();
    // Browser's editing transaction retains native undo for plain-text paste.
    document.execCommand(
      "insertText",
      false,
      event.clipboardData?.getData("text/plain") ?? "",
    );
  };
  private onKeyDown = (event: KeyboardEvent) => {
    const block = event.target;
    if (
      !(block instanceof HTMLDivElement) ||
      !block.matches(".block") ||
      event.isComposing
    )
      return;
    if (event.key === "Tab") {
      event.preventDefault();
      const types = Object.keys(ELEMENT_LABELS) as ElementType[];
      this.setType(
        types[
          (types.indexOf(this.type(block)) +
            (event.shiftKey ? types.length - 1 : 1)) %
            types.length
        ],
      );
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const selection = window.getSelection();
      if (!selection?.rangeCount) return;
      const range = selection.getRangeAt(0);
      if (
        !block.contains(range.startContainer) ||
        !block.contains(range.endContainer)
      )
        return;
      range.deleteContents();
      const trailing = range.cloneRange();
      trailing.setEnd(block, block.childNodes.length);
      const tail = trailing.extractContents().textContent ?? "";
      const next = this.createBlock({
        id: crypto.randomUUID(),
        type: NEXT_ELEMENT[this.type(block)],
        text: tail,
      });
      block.after(next);
      this.focusBlock(next);
      this.changed();
    } else if (
      event.key === "Backspace" &&
      !this.text(block).trim() &&
      this.blocks().length > 1
    ) {
      event.preventDefault();
      const blocks = this.blocks(),
        index = blocks.indexOf(block);
      const target = blocks[index - 1] ?? blocks[index + 1];
      block.remove();
      this.focusBlock(target, true);
      this.changed();
    }
  };

  private focusBlock(block: HTMLDivElement, end = false) {
    block.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(block);
    range.collapse(!end);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  focus(id: string) {
    const block = this.blocks().find((block) => block.dataset.id === id);
    if (block) {
      this.focusBlock(block);
      block.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
  setType(type: ElementType) {
    const block = this.active?.isConnected ? this.active : this.blocks()[0];
    if (!block) return;
    this.applyType(block, type);
    this.callbacks.onSelection(block.dataset.id!, type);
    block.focus({ preventScroll: true });
    this.changed();
  }
  append(type: ElementType) {
    const block = this.createBlock({ id: crypto.randomUUID(), type, text: "" });
    this.root.lastElementChild?.querySelector(".page-content")?.append(block);
    this.paginate();
    this.focusBlock(block);
    block.scrollIntoView({ behavior: "smooth", block: "center" });
    this.changed();
  }

  paginate() {
    const blocks = this.blocks();
    const firstPage = this.root.querySelector<HTMLElement>(".page");
    if (!firstPage) return;
    const style = getComputedStyle(firstPage);
    // Dimensions come from screenplay.css, not duplicated magic pixel constants.
    const capacity =
      parseFloat(style.minHeight) -
      parseFloat(style.paddingTop) -
      parseFloat(style.paddingBottom);
    const groups: HTMLDivElement[][] = [[]];
    let height = 0;
    for (const block of blocks) {
      const gap = ["dialogue", "parenthetical"].includes(this.type(block))
        ? 0
        : parseFloat(getComputedStyle(block).lineHeight);
      const needed = block.offsetHeight + (height ? gap : 0);
      if (height && height + needed > capacity) {
        groups.push([]);
        height = 0;
      }
      groups.at(-1)!.push(block);
      height += block.offsetHeight + (height ? gap : 0);
    }
    const activeElement = document.activeElement;
    const selection = window.getSelection();
    const range = selection?.rangeCount
      ? selection.getRangeAt(0).cloneRange()
      : null;
    while (this.root.children.length < groups.length) this.createPage();
    groups.forEach((group, index) => {
      const page = this.root.children[index] as HTMLElement;
      const content = page.querySelector<HTMLElement>(".page-content")!;
      // Keep existing nodes in place whenever pagination has not changed.
      group.forEach((block, position) => {
        if (content.children[position] !== block)
          content.insertBefore(block, content.children[position] ?? null);
      });
      let number = page.querySelector<HTMLElement>(".page-number");
      if (index > 0 && !number) {
        number = document.createElement("span");
        number.className = "page-number";
        page.append(number);
      }
      if (number) number.textContent = `${index + 1}.`;
    });
    while (this.root.children.length > groups.length)
      this.root.lastElementChild?.remove();
    if (
      activeElement instanceof HTMLElement &&
      activeElement.matches(".block") &&
      this.root.contains(activeElement)
    ) {
      activeElement.focus({ preventScroll: true });
      if (range && selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
    this.callbacks.onLayout({
      pages: groups.length,
      scenes: groups.flatMap((group, index) =>
        group
          .filter((block) => this.type(block) === "scene")
          .map((block) => ({
            id: block.dataset.id!,
            title: this.text(block) || "UNTITLED SCENE",
            page: index + 1,
          })),
      ),
    });
  }
}
