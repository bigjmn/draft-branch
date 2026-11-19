import { TypewriterLoader } from "@/components/ui/typewriter-loader";
import { Suspense } from "react";
import { EditorRoute } from "@/components/projects/project-editor";
export default function EditorPage() {
  return (
    <Suspense fallback={<TypewriterLoader />}>
      <EditorRoute />
    </Suspense>
  );
}
