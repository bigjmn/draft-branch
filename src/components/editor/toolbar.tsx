import { ELEMENT_LABELS, type ElementType } from "@/lib/editor/types";
interface Props {
  readOnly?: boolean;
  type: ElementType;
  zoom: string;
  focus: boolean;
  onType: (type: ElementType) => void;
  onZoom: (zoom: string) => void;
  onFocus: () => void;
}
export function Toolbar({
  readOnly = false,
  type,
  zoom,
  focus,
  onType,
  onZoom,
  onFocus,
}: Props) {
  return (
    <div className="toolbar" aria-label="Screenplay formatting">
      <div className="tool-group">
        <label htmlFor="element">ELEMENT</label>
        <select
          id="element"
          disabled={readOnly}
          value={type}
          onChange={(event) => onType(event.target.value as ElementType)}
        >
          {Object.entries(ELEMENT_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <span className="divider" />
      <span className="font-label">
        Courier <span>12 pt</span>
      </span>
      <div className="toolbar-right">
        <button
          id="focus"
          onClick={onFocus}
          aria-pressed={focus}
          title="Toggle focus mode"
        >
          ⛶ <span>{focus ? "Exit focus" : "Focus"}</span>
        </button>
        <span className="divider" />
        <select
          id="zoom"
          aria-label="Page zoom"
          value={zoom}
          onChange={(event) => onZoom(event.target.value)}
        >
          <option value="fit">Fit</option>
          {["0.65", "0.8", "0.9", "1", "1.15"].map((value) => (
            <option key={value} value={value}>
              {Math.round(Number(value) * 100)}%
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
