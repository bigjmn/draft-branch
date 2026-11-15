import { RequireAuth } from "@/components/auth/require-auth";
import { ScreenplayEditor } from "@/components/editor/screenplay-editor";

export default function EditorPage() {
  return (
    <RequireAuth>
      <ScreenplayEditor />
    </RequireAuth>
  );
}
