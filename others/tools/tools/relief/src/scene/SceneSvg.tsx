// The SVG consumer of Prim[] and the placed labels. Everything with a data-id carries data-basis (design 12).
import type { Placed } from './labels.ts';
import type { Prim } from './paint.ts';

type Props = { prims: Prim[]; labels: Placed[]; view: [number, number, number, number]; hiddenLod: number; hiddenCollision: number };

export function SceneSvg({ prims, labels, view, hiddenLod, hiddenCollision }: Props) {
  return (
    <svg
      className="scene" viewBox={view.map((n) => n.toFixed(1)).join(' ')} xmlns="http://www.w3.org/2000/svg" role="group" aria-label="sagae 네트워크 지도"
      data-testid="scene" data-hidden-lod={hiddenLod} data-hidden-collision={hiddenCollision}
    >
      <defs>
        <pattern id="declared" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="7" height="7" fill="#f3d3b6" /><rect width="3.5" height="7" fill="#dd7f33" />
        </pattern>
      </defs>
      {prims.map((p, i) => {
        if (p.t === 'line') return <polyline key={i} points={p.pts} className={p.cls} data-edge={p.edge} />;
        if (p.t === 'poly') {
          return (
            <polygon
              key={i} points={p.pts} className={p.cls} fill={p.fill} fillOpacity={p.cls === 'plane' ? 0.03 : undefined} stroke={p.stroke} strokeWidth={p.sw}
              strokeDasharray={p.dash ? "7 5" : undefined} pointerEvents={p.cls === "plane" ? "none" : undefined} data-id={p.id} data-kind={p.kind} data-basis={p.basis} data-state={p.state}
            >
              {p.title ? <title>{p.title}</title> : null}
            </polygon>
          );
        }
        return (
          <g key={p.id} data-id={p.id} data-kind={p.kind} data-basis={p.basis} data-state={p.state} data-parent={p.parent} data-selected={p.selected ? '1' : undefined}
            opacity={p.opacity} role="button" aria-label={p.aria} aria-pressed={p.selected}>
            <title>{p.title}</title>
            {p.faces.map((f, j) => (
              <polygon key={j} points={f.pts} fill={f.fill} fillOpacity={f.fillOpacity} stroke={f.stroke} strokeWidth={f.sw} strokeDasharray={f.dash ? '5 3' : undefined} data-face={f.face} />
            ))}
          </g>
        );
      })}
      {labels.map((l) => (
        <g key={l.id} className="lb" data-for={l.id} data-ax={l.at[0].toFixed(1)} data-ay={l.at[1].toFixed(1)} pointerEvents="none">
          {l.lead && l.anchor ? <line x1={l.at[0].toFixed(1)} y1={(l.y + l.h).toFixed(1)} x2={l.anchor[0].toFixed(1)} y2={l.anchor[1].toFixed(1)} className="lead" /> : null}
          <rect x={l.x.toFixed(1)} y={l.y.toFixed(1)} width={l.w.toFixed(1)} height={l.h} rx={3} />
          <text x={(l.x + l.w / 2).toFixed(1)} y={(l.y + l.h - 5.4).toFixed(1)} textAnchor="middle" fill={l.color}>{l.text}</text>
        </g>
      ))}
    </svg>
  );
}
