import { useId, useLayoutEffect, useRef, useState } from "react";

/** Single-series column chart: thin columns, rounded data-end, recessive grid, hover tooltip. */
export function ColumnChart({ data, height = 180, format = (v: number) => String(v), unit = "" }: { data: { label: string; value: number }[]; height?: number; format?: (v: number) => string; unit?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  const gid = `cg${useId().replace(/:/g, "")}`;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const padL = 32;
  const padB = 22;
  const padT = 8;
  const innerW = width - padL;
  const innerH = height - padB - padT;
  const max = Math.max(1, ...data.map((d) => d.value));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const slot = innerW / Math.max(1, data.length);
  const barW = Math.min(28, slot * 0.56);
  const y = (v: number) => padT + innerH - (v / top) * innerH;
  const labelEvery = Math.ceil(data.length / Math.max(1, Math.floor(innerW / 56)));

  return (
    <div className="chart" ref={ref} onMouseLeave={() => setHover(null)}>
      <svg width={width} height={height} role="img" aria-label="Column chart">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: "var(--g2)" }} />
            <stop offset="1" style={{ stopColor: "var(--g1)" }} />
          </linearGradient>
        </defs>
        <g className="grid">
          {ticks.map((t) => (
            <line key={t} x1={padL} x2={width} y1={y(t)} y2={y(t)} />
          ))}
        </g>
        <g className="axis">
          {ticks.map((t) => (
            <text key={t} x={padL - 8} y={y(t) + 4} textAnchor="end">
              {format(t)}
            </text>
          ))}
          {data.map((d, i) =>
            i % labelEvery === 0 ? (
              <text key={i} x={padL + slot * i + slot / 2} y={height - 6} textAnchor="middle">
                {d.label}
              </text>
            ) : null,
          )}
        </g>
        {data.map((d, i) => {
          const x = padL + slot * i + (slot - barW) / 2;
          const h = Math.max(d.value > 0 ? 2 : 0, padT + innerH - y(d.value));
          const r = Math.min(4, h / 2, barW / 2);
          const yTop = padT + innerH - h;
          return (
            <g key={i} onMouseEnter={() => setHover(i)}>
              <rect x={padL + slot * i} y={padT} width={slot} height={innerH} fill="transparent" />
              {h > 0 && (
                <path
                  className={`bar ${hover !== null && hover !== i ? "dim" : ""}`}
                  style={{ fill: `url(#${gid})` }}
                  d={`M${x},${padT + innerH} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + barW - r} Q${x + barW},${yTop} ${x + barW},${yTop + r} V${padT + innerH} Z`}
                />
              )}
            </g>
          );
        })}
      </svg>
      {hover !== null && data[hover] && (
        <div className="tooltip" style={{ left: padL + slot * hover + slot / 2, top: y(data[hover].value) }}>
          {data[hover].label} · <b>{format(data[hover].value)}</b>
          {unit && ` ${unit}`}
        </div>
      )}
    </div>
  );
}

function niceStep(max: number): number {
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

/** Ranked horizontal bars, labelled directly. */
export function BarList({ data, format = (v: number) => String(v) }: { data: { label: string; value: number; sub?: string }[]; format?: (v: number) => string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="barlist">
      {data.map((d) => (
        <div className="barlist-row" key={d.label} title={`${d.label}: ${format(d.value)}`}>
          <span className="label">{d.label}</span>
          <div className="track">
            <div className="fill" style={{ width: `${(d.value / max) * 100}%` }} />
          </div>
          <span className="val">{format(d.value)}</span>
        </div>
      ))}
    </div>
  );
}
