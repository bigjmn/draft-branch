"use client";
import { useLayoutEffect, useRef } from "react";
import type { TitlePage } from "@/lib/editor/types";
import {
  TITLE_PAGE_LABELS,
  TITLE_PAGE_LIMITS,
  TITLE_PAGE_PLACEHOLDERS,
  type TitlePageField,
} from "@/lib/editor/title-page";

/** A screenplay cover on a US Letter page, laid out like a standard title
 * page: the title 16 lines down, the credit and author centred under it with
 * two blank lines between each, and the contact block at the bottom left. */
export function TitlePageView({
  page,
  readOnly = false,
  onChange,
  printOnly = false,
}: {
  page: TitlePage;
  readOnly?: boolean;
  onChange?: (field: TitlePageField, value: string) => void;
  /** The copy printed before the script, which is never edited. */
  printOnly?: boolean;
}) {
  const field = (name: TitlePageField) =>
    readOnly || printOnly || !onChange ? (
      <div
        className={`title-page-field title-page-${name}`}
        data-empty={!page[name] || undefined}
        data-placeholder={printOnly ? undefined : TITLE_PAGE_PLACEHOLDERS[name]}
      >
        {page[name]}
      </div>
    ) : (
      <FieldInput
        name={name}
        value={page[name]}
        onChange={(value) => onChange(name, value)}
      />
    );
  return (
    <div
      className={`page title-page${printOnly ? " print-title-page" : ""}`}
      aria-label={printOnly ? undefined : "Title page"}
      aria-hidden={printOnly || undefined}
    >
      <div className="title-page-top">
        {field("title")}
        {field("credit")}
        {field("authors")}
      </div>
      {field("contact")}
    </div>
  );
}

/** A textarea that grows with its text, so the page keeps its layout. */
function FieldInput({
  name,
  value,
  onChange,
}: {
  name: TitlePageField;
  value: string;
  onChange: (value: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      className={`title-page-field title-page-${name}`}
      aria-label={`Title page ${TITLE_PAGE_LABELS[name].toLowerCase()}`}
      placeholder={TITLE_PAGE_PLACEHOLDERS[name]}
      maxLength={TITLE_PAGE_LIMITS[name]}
      rows={1}
      spellCheck={name !== "contact"}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
