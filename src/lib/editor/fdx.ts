import { type Draft, type ElementType, wrapParenthetical } from "./types";
import { titlePageLines, titlePageOf } from "./title-page";

const elements: Record<
  ElementType,
  { name: string; left: number; right: number; caps?: boolean }
> = {
  scene: { name: "Scene Heading", left: 1.5, right: 7.5, caps: true },
  action: { name: "Action", left: 1.5, right: 7.5 },
  character: { name: "Character", left: 3.8, right: 7.5, caps: true },
  dialogue: { name: "Dialogue", left: 2.5, right: 6 },
  parenthetical: { name: "Parenthetical", left: 3, right: 5.5 },
  shot: { name: "Shot", left: 1.5, right: 7.5, caps: true },
  transition: { name: "Transition", left: 1.5, right: 7.5, caps: true },
};
/** XML 1.0 excludes some control characters and unpaired UTF-16 surrogates. */
function xml(text: string): string {
  return text
    .replace(
      /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu,
      "\uFFFD",
    )
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
/** Portable FDX screenplay, independent of UI theme and browser pagination.
 * One editor block becomes one typed paragraph; embedded line breaks stay text.
 * Git history and application-specific identities are intentionally not exported.
 */
export function toFdx(
  draft: Draft,
  options: { titlePage?: boolean; author?: string } = {},
): string {
  const content = draft.blocks
    .map((block) => {
      const element = elements[block.type];
      let text = block.text.replace(/\r\n?/g, "\n");
      if (element.caps) text = text.toUpperCase();
      if (block.type === "parenthetical" && text)
        text = wrapParenthetical({ text, offset: 0 }).text;
      return `    <Paragraph Type="${element.name}"><Text>${xml(text)}</Text></Paragraph>`;
    })
    .join("\n");
  const settings = Object.entries(elements)
    .map(
      ([type, element]) => `  <ElementSettings Type="${element.name}">
    <FontSpec Font="Courier" Size="12" Style="${element.caps ? "AllCaps" : ""}" Color="#000000000000"/>
    <ParagraphSpec Alignment="${type === "transition" ? "Right" : "Left"}" FirstIndent="0.00" LeftIndent="${element.left.toFixed(2)}" RightIndent="${element.right.toFixed(2)}" SpaceBefore="${type === "dialogue" || type === "parenthetical" ? 0 : 12}" Spacing="1"/>
  </ElementSettings>`,
    )
    .join("\n");
  const titlePage = options.titlePage
    ? `
  <TitlePage>
    <Content>
${titlePageLines(titlePageOf(draft, options.author))
  .map(
    (line) =>
      `      <Paragraph Type="General" Alignment="${line.align}" SpaceBefore="${line.before}"><Text Font="Courier" Size="12">${xml(line.text)}</Text></Paragraph>`,
  )
  .join("\n")}
    </Content>
  </TitlePage>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<FinalDraft DocumentType="Script" Template="No" Version="1">
  <Content>
${content}
  </Content>
  <PageLayout TopMargin="72" BottomMargin="72" HeaderMargin="36" FooterMargin="36" BackgroundColor="#FFFFFFFFFFFF" ForegroundColor="#000000000000">
    <PageSize Width="8.50" Height="11.00"/>
  </PageLayout>
${settings}${titlePage}
</FinalDraft>
`;
}
