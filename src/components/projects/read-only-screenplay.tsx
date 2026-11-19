import type { Draft } from "@/lib/editor/types";
export function ReadOnlyScreenplay({ draft }: { draft: Draft }) {
  return (
    <section className="shared-screenplay" aria-label="Read-only screenplay">
      <div className="shared-paper">
        <h1>{draft.title}</h1>
        <div className="shared-blocks">
          {draft.blocks.map((block) => (
            <p className="block" data-type={block.type} key={block.id}>
              {block.text || "\u00a0"}
            </p>
          ))}
        </div>
      </div>
    </section>
  );
}
