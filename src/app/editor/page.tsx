import { Suspense } from "react";
import { EditorRoute } from "@/components/projects/project-editor";
export default function EditorPage() {
  return (
    <Suspense
      fallback={
        <main className="loading-state">Opening your writing room…</main>
      }
    >
      <EditorRoute />
    </Suspense>
  );
}
