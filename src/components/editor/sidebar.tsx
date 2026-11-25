"use client";
import { BetaBadge } from "@/components/ui/beta-badge";
import { signOut } from "firebase/auth";
import { useAuth } from "@/components/auth/auth-provider";
import type { Scene } from "@/lib/editor/types";
import { firebaseAuth } from "@/lib/firebase/client";
export type EditorSection = "screenplay" | "titlePage";
interface Props {
  readOnly?: boolean;
  /** Which manuscript document the editor shows. */
  section: EditorSection;
  onSection: (section: EditorSection) => void;
  title: string;
  scenes: Scene[];
  selectedId: string | null;
  onScene: (id: string) => void;
  onAdd: () => void;
  onHelp: () => void;
  /** Name and description shown when nobody is signed in. */
  guest?: { name: string; detail: string };
}
export function Sidebar({
  readOnly = false,
  section,
  onSection,
  title,
  scenes,
  selectedId,
  onScene,
  onAdd,
  onHelp,
  guest,
}: Props) {
  const { user } = useAuth();
  const name = user?.displayName || user?.email || guest?.name || "Guest";
  return (
    <aside id="sidebar">
      <a
        className="brand"
        href={!user || user.isAnonymous ? "/" : "/dashboard"}
      >
        <span className="brand-icon">d.</span> DraftBranch <BetaBadge />
      </a>
      <div className="project">
        <div className="eyebrow">YOUR WORKSPACE</div>
        <div className="project-name">
          {title} <span className="private">PRIVATE</span>
        </div>
        <div className="project-detail">Feature screenplay</div>
      </div>
      <div className="sidebar-label">
        MANUSCRIPT <span>02</span>
      </div>
      <nav className="documents" aria-label="Manuscript">
        {(
          [
            ["titlePage", "▢", "Title page"],
            ["screenplay", "▤", "Screenplay"],
          ] as const
        ).map(([value, icon, label]) => (
          <button
            key={value}
            type="button"
            className={`document${section === value ? " active" : ""}`}
            aria-current={section === value ? "page" : undefined}
            onClick={() => onSection(value)}
          >
            <span>{icon}</span> {label}
            {section === value && <span className="dot" />}
          </button>
        ))}
      </nav>
      <div className="scene-header">
        <span>SCENE OUTLINE</span>
        <button
          disabled={readOnly}
          onClick={onAdd}
          title="Add a scene"
          aria-label="Add a scene"
        >
          +
        </button>
      </div>
      <nav id="outline" aria-label="Scene outline">
        {scenes.map((scene, index) => (
          <button
            key={scene.id}
            className={`scene-link${scene.id === selectedId ? " selected" : ""}`}
            onClick={() => onScene(scene.id)}
          >
            <span className="num">{String(index + 1).padStart(2, "0")}</span>
            <span>
              <strong>{scene.title}</strong>
              <small>Page {scene.page}</small>
            </span>
          </button>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <span className="avatar">{name.charAt(0).toUpperCase()}</span>
        <div className="account">
          <span className="account-name" title={name}>
            {name}
          </span>
          <small>
            {!user || user.isAnonymous
              ? (guest?.detail ?? "Guest workspace")
              : "Your workspace"}
            {user && (
              <>
                {" "}
                ·{" "}
                <button
                  className="sign-out"
                  onClick={() => signOut(firebaseAuth())}
                >
                  Sign out
                </button>
              </>
            )}
          </small>
        </div>
        <button
          onClick={onHelp}
          title="Keyboard shortcuts"
          aria-label="Keyboard shortcuts"
        >
          ?
        </button>
      </div>
    </aside>
  );
}
