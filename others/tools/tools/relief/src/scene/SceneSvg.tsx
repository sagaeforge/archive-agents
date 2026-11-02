// The SVG consumer of Prim[] and the placed labels. Everything with a data-id carries data-basis (design 12). Colours arrive as tokens.
// The drawing is memoised apart from the viewBox: a pan or a hover must not walk thousands of elements.
import { memo } from 'react';
import type { Placed } from './labels.ts';
import type { Prim } from './paint.ts';

type Props = { prims: Prim[]; labels: Placed[]; view: [number, number, number, number]; hiddenLod: number; hiddenCollision: number; svgRef?: React.Ref<SVGSVGElement> };

const Body = memo(function Body({ prims }: { prims: Prim[] }) {
  return prims.map((p, i) => {
    if (p.t === 'line') return <polyline key={i} points={p.pts} className={p.cls} data-edge={p.edge} data-link={p.link} data-measured={p.edge ? (p.measured ? '1' : '0') : undefined}>{p.title ? <title>{p.title}</title> : null}</polyline>;
    if (p.t === 'path') return <path key={i} d={p.d} className={p.cls} pointerEvents="none" />;
    if (p.t === 'packet') return <rect key={`p${p.edge}${p.lane}${p.at}`} className="packet" x={-3.5} y={-1.5} width={7} height={3} rx={1} data-packet-for={p.edge} data-lane={p.lane} pointerEvents="none" style={{ offsetPath: `path('${p.d}')`, animationDuration: `${p.dur}s`, animationDelay: `${p.delay}s`, ['--at' as string]: `${p.at}%` }} />;
    if (p.t === 'poly') return <polygon key={i} points={p.pts} className={p.cls} fill={p.fill} stroke={p.stroke} strokeWidth={p.sw} />;
    return (
      <g key={p.id} data-id={p.id} data-kind={p.kind} data-basis={p.basis} data-state={p.state} data-parent={p.parent} data-selected={p.selected ? '1' : undefined} data-alert={p.alert} data-flash={p.flash ? '1' : undefined}
        opacity={p.opacity} role="button" aria-label={p.aria} aria-pressed={p.selected}>
        {p.halo ? <path className="halo" d={p.halo} /> : null}
        {p.faces.map((f, j) => (
          <polygon key={j} points={f.pts} fill={f.fill} fillOpacity={f.fillOpacity} stroke={f.stroke} strokeWidth={f.sw} strokeDasharray={f.dash ? '5 3' : undefined} data-face={f.face} />
        ))}
        {p.detail ? <path className="detail" d={p.detail} /> : null}
      </g>
    );
  });
});

const Labels = memo(function Labels({ labels }: { labels: Placed[] }) {
  return labels.map((l) => (
    <g key={l.id} className={l.alert ? 'lb alert' : 'lb'} data-for={l.id} data-ax={l.at[0].toFixed(1)} data-ay={l.at[1].toFixed(1)} pointerEvents="none">
      {l.lead && l.anchor ? <line x1={l.at[0].toFixed(1)} y1={(l.y + l.h).toFixed(1)} x2={l.anchor[0].toFixed(1)} y2={l.anchor[1].toFixed(1)} className="lead" /> : null}
      <rect x={l.x.toFixed(1)} y={l.y.toFixed(1)} width={l.w.toFixed(1)} height={l.h} rx={4} />
      <text x={(l.x + l.w / 2).toFixed(1)} y={(l.y + l.h - 5.4).toFixed(1)} textAnchor="middle" fill={l.color}>{l.text}</text>
    </g>
  ));
});

export function SceneSvg({ prims, labels, view, hiddenLod, hiddenCollision, svgRef }: Props) {
  return (
    <svg
      ref={svgRef} className="scene" viewBox={view.map((n) => n.toFixed(1)).join(' ')} xmlns="http://www.w3.org/2000/svg" role="group" aria-label="sagae 네트워크 지도"
      data-testid="scene" data-hidden-lod={hiddenLod} data-hidden-collision={hiddenCollision}
    >
      <defs>
        <pattern id="declared" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="7" height="7" fill="var(--hatch-a)" /><rect width="3.5" height="7" fill="var(--hatch-b)" />
        </pattern>
      </defs>
      <Body prims={prims} />
      <Labels labels={labels} />
    </svg>
  );
}
