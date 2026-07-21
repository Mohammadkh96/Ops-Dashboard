type SparklineProps = {
  data: number[];
  width?: number;
  height?: number;
  stroke?: string;
  fill?: string;
  className?: string;
};

/**
 * Tiny inline area sparkline (pure SVG, no deps). Trend-only — no axes, no ticks.
 * Direction is carried by an explicit up/down color, not by the line alone.
 */
export function Sparkline({
  data,
  width = 72,
  height = 24,
  stroke = "var(--accent-blue)",
  fill,
  className,
}: SparklineProps) {
  if (data.length < 2) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const pad = 2;
  const usableH = height - pad * 2;

  const points = data.map((d, i) => {
    const x = i * stepX;
    const y = pad + usableH - ((d - min) / range) * usableH;
    return [x, y] as const;
  });

  const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} ${width},${height} 0,${height}`;
  const gradientId = `spark-${stroke.replace(/[^a-z0-9]/gi, "")}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {fill ? (
        <>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={fill} stopOpacity={0.35} />
              <stop offset="100%" stopColor={fill} stopOpacity={0} />
            </linearGradient>
          </defs>
          <polygon points={area} fill={`url(#${gradientId})`} />
        </>
      ) : null}
      <polyline
        points={line}
        fill="none"
        stroke={stroke}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
