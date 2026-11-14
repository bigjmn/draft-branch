import type { Scene } from "@/lib/editor/types";
interface Props {
  title: string;
  scenes: Scene[];
  selectedId: string | null;
  onScene: (id: string) => void;
  onAdd: () => void;
  onHelp: () => void;
}
export function Sidebar({
  title,
  scenes,
  selectedId,
  onScene,
  onAdd,
  onHelp,
}: Props) {
  return (
    <aside id="sidebar">
      <a className="brand" href="#canvas">
        <span className="brand-icon">s.</span> scriptroom
      </a>
      <div className="project">
        <div className="eyebrow">YOUR WORKSPACE</div>
        <div className="project-name">
          {title} <span className="private">PRIVATE</span>
        </div>
        <div className="project-detail">Feature screenplay</div>
      </div>
      <div className="sidebar-label">
        MANUSCRIPT <span>01</span>
      </div>
      <a href="#canvas" className="document active">
        <span>▤</span> Screenplay <span className="dot" />
      </a>
      <div className="scene-header">
        <span>SCENE OUTLINE</span>
        <button onClick={onAdd} title="Add a scene" aria-label="Add a scene">
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
        <span className="avatar">Y</span>
        <div>
          Your workspace<small>Saved on this device</small>
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
