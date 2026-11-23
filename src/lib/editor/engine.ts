import { characterSuggestions } from "./characters";
import { editorText } from "./dom-text";
import { parseClipboard, SCREENPLAY_MIME, validateImport } from "./import";
import {
  ELEMENT_LABELS,
  NEXT_ELEMENT,
  cycleElement,
  unwrapParenthetical,
  wrapParenthetical,
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
  private history: ScriptBlock[][] = [];
  private historyIndex = 0;
  private restoring = false;
  private active: HTMLDivElement | null = null;
  private suggestionMenu: HTMLDivElement | null = null;
  private suggestionBlock: HTMLDivElement | null = null;
  private suggestions: string[] = [];
  private suggestionIndex = 0;

  constructor(
    private root: HTMLDivElement,
    blocks: ScriptBlock[],
    private callbacks: Callbacks,
    private readOnly = false,
  ) {
    this.history = [blocks.map((b) => ({ ...b }))];
    const content = this.createPage();
    blocks.forEach((block) => content.append(this.createBlock(block)));
    const options = { signal: this.abort.signal };
    root.addEventListener("focusin", this.onFocus, options);
    root.addEventListener("copy", this.onCopy, options);
    if (!readOnly) {
      root.addEventListener("input", this.onInput, options);
      root.addEventListener(
        "beforeinput",
        (event) => {
          if (
            event.inputType === "historyUndo" ||
            event.inputType === "historyRedo"
          ) {
            event.preventDefault();
            this.travelHistory(event.inputType === "historyRedo" ? 1 : -1);
          }
        },
        options,
      );
      root.addEventListener("keydown", this.onKeyDown, options);
      root.addEventListener("paste", this.onPaste, options);
      root.addEventListener("focusout", () => this.closeSuggestions(), options);
      root.addEventListener(
        "compositionstart",
        () => this.closeSuggestions(),
        options,
      );
      root.addEventListener(
        "compositionend",
        () => this.updateSuggestions(),
        options,
      );
      window.addEventListener("scroll", this.positionSuggestions, {
        ...options,
        capture: true,
      });
      window.addEventListener("resize", this.positionSuggestions, options);
    }
    this.paginate();
  }

  destroy() {
    this.closeSuggestions();
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
    return editorText(block);
  }
  private createBlock(value: ScriptBlock) {
    const block = document.createElement("div");
    block.className = "block";
    block.contentEditable = this.readOnly ? "false" : "true";
    if (this.readOnly) block.tabIndex = 0;
    block.spellcheck = true;
    block.dataset.id = value.id;
    this.applyType(block, value.type);
    if (!this.readOnly) {
      block.setAttribute("role", "textbox");
      block.setAttribute("aria-multiline", "true");
    }
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
  private snapshot() {
    return this.blocks().map((b) => ({
      id: b.dataset.id!,
      type: this.type(b),
      text: this.text(b),
    }));
  }
  private changed() {
    if (!this.restoring) {
      const next = this.snapshot();
      if (
        JSON.stringify(next) !== JSON.stringify(this.history[this.historyIndex])
      ) {
        this.history.splice(this.historyIndex + 1);
        this.history.push(next);
        if (this.history.length > 100) this.history.shift();
        this.historyIndex = this.history.length - 1;
      }
    }
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
    this.updateSuggestions();
  };
  private onInput = (event: Event) => {
    this.changed();
    if (!(event as InputEvent).isComposing) this.updateSuggestions();
  };
  private closeSuggestions() {
    this.suggestionBlock?.removeAttribute("data-suggestion");
    for (const attribute of [
      "aria-controls",
      "aria-expanded",
      "aria-activedescendant",
      "aria-autocomplete",
      "aria-haspopup",
    ])
      this.suggestionBlock?.removeAttribute(attribute);
    this.suggestionMenu?.remove();
    this.suggestionMenu = null;
    this.suggestionBlock = null;
    this.suggestions = [];
  }
  private updateSuggestions() {
    this.closeSuggestions();
    const block = this.active;
    if (
      this.readOnly ||
      !block?.isConnected ||
      document.activeElement !== block ||
      this.type(block) !== "character"
    )
      return;
    this.suggestions = characterSuggestions(
      this.snapshot(),
      block.dataset.id!,
      this.text(block),
    );
    if (!this.suggestions.length) return;
    this.suggestionBlock = block;
    this.suggestionIndex = 0;
    const menu = document.createElement("div");
    menu.className = "character-suggestions";
    menu.id = `character-options-${block.dataset.id}`;
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", "Existing characters");
    block.setAttribute("aria-controls", menu.id);
    block.setAttribute("aria-expanded", "true");
    block.setAttribute("aria-autocomplete", "list");
    block.setAttribute("aria-haspopup", "listbox");
    this.suggestions.forEach((name, index) => {
      const option = document.createElement("div");
      option.id = `${menu.id}-${index}`;
      option.setAttribute("role", "option");
      option.textContent = name;
      option.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.suggestionIndex = index;
        this.acceptSuggestion();
      });
      menu.append(option);
    });
    this.suggestionMenu = menu;
    document.body.append(menu);
    this.highlightSuggestion();
    this.positionSuggestions();
  }
  private highlightSuggestion() {
    const menu = this.suggestionMenu,
      block = this.suggestionBlock;
    if (!menu || !block) return;
    Array.from(menu.children).forEach((option, index) =>
      option.setAttribute(
        "aria-selected",
        String(index === this.suggestionIndex),
      ),
    );
    const option = menu.children[this.suggestionIndex] as HTMLElement;
    block.setAttribute("aria-activedescendant", option.id);
    if (!this.text(block).trim())
      block.dataset.suggestion = `${this.suggestions[this.suggestionIndex]} (Enter)`;
    menu.scrollTop = Math.max(
      0,
      option.offsetTop - menu.clientHeight + option.offsetHeight,
    );
  }
  private positionSuggestions = () => {
    if (!this.suggestionMenu || !this.suggestionBlock) return;
    const rect = this.suggestionBlock.getBoundingClientRect();
    const menu = this.suggestionMenu;
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, rect.bottom + menu.offsetHeight + 8 > window.innerHeight ? rect.top - menu.offsetHeight - 4 : rect.bottom + 4)}px`;
  };
  private acceptSuggestion() {
    const block = this.suggestionBlock,
      name = this.suggestions[this.suggestionIndex];
    if (!block || !name) return;
    this.closeSuggestions();
    block.textContent = name;
    const following = this.blocks()[this.blocks().indexOf(block) + 1];
    if (following && this.type(following) === "dialogue")
      this.focusBlock(following);
    else {
      const dialogue = this.createBlock({
        id: crypto.randomUUID(),
        type: "dialogue",
        text: "",
      });
      block.after(dialogue);
      this.focusBlock(dialogue);
    }
    this.changed();
  }
  private selectedRange() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    const blocks = this.blocks();
    const start = blocks.find((b) => b.contains(range.startContainer));
    const end = blocks.find((b) => b.contains(range.endContainer));
    return start && end ? { range, blocks, start, end } : null;
  }
  private onCopy = (event: ClipboardEvent) => {
    const selected = this.selectedRange();
    if (!selected || selected.range.collapsed || !event.clipboardData) return;
    const { range, blocks, start, end } = selected;
    const copied = blocks
      .slice(blocks.indexOf(start), blocks.indexOf(end) + 1)
      .map((b) => {
        const part = document.createRange();
        part.selectNodeContents(b);
        if (b === start) part.setStart(range.startContainer, range.startOffset);
        if (b === end) part.setEnd(range.endContainer, range.endOffset);
        return { type: this.type(b), text: part.toString() };
      });
    event.preventDefault();
    event.clipboardData.setData(SCREENPLAY_MIME, JSON.stringify(copied));
    event.clipboardData.setData(
      "text/plain",
      copied.map((b) => b.text).join("\n"),
    );
    const container = document.createElement("div");
    copied.forEach((b) => {
      const el = document.createElement("p");
      el.dataset.type = b.type;
      el.textContent = b.text;
      container.append(el);
    });
    event.clipboardData.setData("text/html", container.innerHTML);
  };
  private onPaste = (event: ClipboardEvent) => {
    const selected = this.selectedRange();
    if (!selected || !event.clipboardData) return;
    event.preventDefault();
    const { range, blocks, start, end } = selected;
    try {
      let pasted = parseClipboard(event.clipboardData, this.type(start));
      if (!pasted && start === end) {
        document.execCommand(
          "insertText",
          false,
          event.clipboardData.getData("text/plain"),
        );
        return;
      }
      pasted ??= [
        {
          id: crypto.randomUUID(),
          type: this.type(start),
          text: event.clipboardData.getData("text/plain"),
        },
      ];
      if (!pasted.length) return;
      const before = range.cloneRange();
      before.selectNodeContents(start);
      before.setEnd(range.startContainer, range.startOffset);
      const after = range.cloneRange();
      after.selectNodeContents(end);
      after.setStart(range.endContainer, range.endOffset);
      const prefix = before.toString(),
        suffix = after.toString();
      // Preserve existing partial paragraphs; whole-element paste keeps explicit types.
      if (prefix) {
        if (pasted[0].type === this.type(start))
          pasted[0].text = prefix + pasted[0].text;
        else
          pasted.unshift({
            id: start.dataset.id!,
            type: this.type(start),
            text: prefix,
          });
      }
      const caretId = pasted.at(-1)!.id,
        caretOffset = pasted.at(-1)!.text.length;
      if (suffix) {
        if (pasted.at(-1)!.type === this.type(end))
          pasted.at(-1)!.text += suffix;
        else
          pasted.push({
            id: crypto.randomUUID(),
            type: this.type(end),
            text: suffix,
          });
      }
      const first = blocks.indexOf(start),
        last = blocks.indexOf(end);
      validateImport({
        title: "",
        blocks: [
          ...this.snapshot().slice(0, first),
          ...pasted,
          ...this.snapshot().slice(last + 1),
        ],
      });
      const elements = pasted.map((b) => this.createBlock(b));
      start.before(...elements);
      blocks.slice(first, last + 1).forEach((b) => b.remove());
      const caret = elements.find((b) => b.dataset.id === caretId)!;
      caret.focus();
      this.setCaret(caret, caretOffset);
      this.changed();
    } catch (error) {
      window.alert(
        error instanceof Error
          ? error.message
          : "Could not paste this screenplay.",
      );
    }
  };
  private travelHistory(direction: number) {
    this.closeSuggestions();
    const next = this.historyIndex + direction;
    if (next < 0 || next >= this.history.length) return;
    this.historyIndex = next;
    this.root.replaceChildren();
    const page = this.createPage();
    this.history[next].forEach((b) => page.append(this.createBlock(b)));
    this.restoring = true;
    this.changed();
    this.restoring = false;
    this.paginate();
    this.focusBlock(this.blocks().at(-1)!, true);
  }
  private onKeyDown = (event: KeyboardEvent) => {
    const block = event.target;
    if (
      !(block instanceof HTMLDivElement) ||
      !block.matches(".block") ||
      event.isComposing
    )
      return;
    if (
      this.suggestionMenu &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        this.suggestionIndex =
          (this.suggestionIndex +
            (event.key === "ArrowDown" ? 1 : -1) +
            this.suggestions.length) %
          this.suggestions.length;
        this.highlightSuggestion();
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.acceptSuggestion();
        return;
      }
      if (["ArrowLeft", "ArrowRight", "Escape", "Tab"].includes(event.key))
        this.closeSuggestions();
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y")
    ) {
      event.preventDefault();
      this.travelHistory(
        event.shiftKey || event.key.toLowerCase() === "y" ? 1 : -1,
      );
    } else if (event.key === "Tab") {
      event.preventDefault();
      this.retype(
        block,
        cycleElement(this.type(block), event.shiftKey ? -1 : 1),
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
      let tail = trailing.extractContents().textContent ?? "";
      // The closing parenthesis belongs to the parenthetical, not the next line.
      if (this.type(block) === "parenthetical" && tail.endsWith(")")) {
        tail = tail.slice(0, -1);
        block.append(")");
      }
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
    if (this.readOnly) return;
    const block = this.active?.isConnected ? this.active : this.blocks()[0];
    if (!block) return;
    block.focus({ preventScroll: true });
    this.retype(block, type);
  }
  /** Changes a block's type, adding or removing parenthetical brackets as needed. */
  private retype(block: HTMLDivElement, type: ElementType) {
    const from = this.type(block);
    if (from === type) return;
    const text = this.text(block);
    const current = { text, offset: this.caretOffset(block) ?? text.length };
    const next =
      type === "parenthetical"
        ? wrapParenthetical(current)
        : from === "parenthetical"
          ? unwrapParenthetical(current)
          : current;
    this.applyType(block, type);
    if (next.text !== text) {
      block.textContent = next.text;
      this.setCaret(block, next.offset);
    }
    this.callbacks.onSelection(block.dataset.id!, type);
    this.changed();
    this.updateSuggestions();
  }
  private caretOffset(block: HTMLElement): number | null {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!block.contains(range.endContainer)) return null;
    const before = document.createRange();
    before.selectNodeContents(block);
    before.setEnd(range.endContainer, range.endOffset);
    return before.toString().length;
  }
  private setCaret(block: HTMLElement, offset: number) {
    const range = document.createRange();
    const node = block.firstChild;
    if (node instanceof Text)
      range.setStart(node, Math.min(offset, node.length));
    else range.selectNodeContents(block);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  append(type: ElementType) {
    if (this.readOnly) return;
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
    this.positionSuggestions();
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
