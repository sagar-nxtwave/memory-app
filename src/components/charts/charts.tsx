'use client'

import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  AreaChart, Area, ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'

const COLORS = ['#0d9488', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#10b981', '#ec4899', '#6366f1']

export interface ChartDataPoint {
  label: string
  value: number
  [key: string]: string | number
}

export interface LineConfig {
  key: string
  name: string
  color: string
}

interface ChartProps {
  data: ChartDataPoint[]
  lines?: LineConfig[]
  height?: number
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ color?: string; stroke?: string; name?: string; value?: number | string }>; label?: string }) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-[#1c1c1e] dark:bg-[#1c1c1e] text-white px-3 py-2 rounded-lg shadow-lg text-xs border border-gray-700">
      <p className="font-medium mb-1">{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.color || p.stroke }}>
          {p.name}: {typeof p.value === 'number' ? p.value.toLocaleString() : p.value}
        </p>
      ))}
    </div>
  )
}

export function LineTrend({ data, lines, height = 250 }: ChartProps) {
  const series = lines?.length ? lines : [{ key: 'value', name: 'Value', color: COLORS[0] }]
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" className="dark:stroke-gray-700" />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="#9ca3af" />
        <YAxis tick={{ fontSize: 11 }} stroke="#9ca3af" />
        <Tooltip content={<CustomTooltip />} />
        {series.map((s) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.name}
            stroke={s.color}
            strokeWidth={2.5}
            dot={{ r: 4, fill: s.color, strokeWidth: 0 }}
            activeDot={{ r: 6, strokeWidth: 2, stroke: '#fff' }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}

export function BarComp({ data, lines, height = 250 }: ChartProps) {
  const series = lines?.length ? lines : [{ key: 'value', name: 'Value', color: COLORS[0] }]
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" className="dark:stroke-gray-700" />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="#9ca3af" />
        <YAxis tick={{ fontSize: 11 }} stroke="#9ca3af" />
        <Tooltip content={<CustomTooltip />} />
        {series.map((s) => (
          <Bar key={s.key} dataKey={s.key} name={s.name} fill={s.color} radius={[4, 4, 0, 0]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}

export function PieDonut({ data, height = 250 }: ChartProps) {
  const total = data.reduce((sum, d) => sum + (d.value as number), 0)
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          innerRadius={height * 0.25}
          outerRadius={height * 0.4}
          paddingAngle={2}
          dataKey="value"
          nameKey="label"
          animationBegin={0}
          animationDuration={800}
        >
          {data.map((_, i) => (
            <Cell key={i} fill={COLORS[i % COLORS.length]} strokeWidth={0} />
          ))}
        </Pie>
        <Tooltip content={<CustomTooltip />} />
        <text x="50%" y="48%" textAnchor="middle" className="fill-gray-900 dark:fill-white text-lg font-semibold">
          {total.toLocaleString()}
        </text>
        <text x="50%" y="58%" textAnchor="middle" className="fill-gray-400 dark:fill-gray-500 text-[10px]">
          total
        </text>
      </PieChart>
    </ResponsiveContainer>
  )
}

export function AreaTrend({ data, lines, height = 250 }: ChartProps) {
  const series = lines?.length ? lines : [{ key: 'value', name: 'Value', color: COLORS[0] }]
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.3} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" className="dark:stroke-gray-700" />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="#9ca3af" />
        <YAxis tick={{ fontSize: 11 }} stroke="#9ca3af" />
        <Tooltip content={<CustomTooltip />} />
        {series.map((s) => (
          <Area
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.name}
            stroke={s.color}
            strokeWidth={2}
            fill={`url(#grad-${s.key})`}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  )
}

export function FunnelChart({ data, height = 250 }: ChartProps) {
  const maxVal = Math.max(...data.map((d) => d.value as number))
  return (
    <div className="flex flex-col items-center gap-1 py-2" style={{ height }}>
      {data.map((d, i) => {
        const pct = maxVal > 0 ? ((d.value as number) / maxVal) * 100 : 0
        return (
          <div key={i} className="flex items-center gap-2 w-full" style={{ maxWidth: '90%' }}>
            <div className="flex-1 flex justify-end">
              <div
                className="h-7 rounded-r-lg flex items-center justify-end px-2 text-[11px] font-medium text-white transition-all duration-500"
                style={{
                  width: `${Math.max(pct, 8)}%`,
                  backgroundColor: COLORS[i % COLORS.length],
                }}
              >
                {(d.value as number).toLocaleString()}
              </div>
            </div>
            <span className="text-[11px] text-gray-500 dark:text-gray-400 w-20 text-left shrink-0 truncate">{d.label}</span>
          </div>
        )
      })}
    </div>
  )
}

export function StackedBarComp({ data, lines, height = 250 }: ChartProps) {
  const series = lines?.length ? lines : [{ key: 'value', name: 'Value', color: COLORS[0] }]
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" className="dark:stroke-gray-700" />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="#9ca3af" />
        <YAxis tick={{ fontSize: 11 }} stroke="#9ca3af" />
        <Tooltip content={<CustomTooltip />} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        {series.map((s) => (
          <Bar key={s.key} dataKey={s.key} name={s.name} stackId="a" fill={s.color} radius={s === series[series.length - 1] ? [4, 4, 0, 0] : [0, 0, 0, 0]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}

export function ScatterPlot({ data, lines, height = 250 }: ChartProps) {
  const scatterData = data.map((d) => ({
    x: typeof d.value === 'number' ? d.value : 0,
    y: typeof d.value2 === 'number' ? d.value2 : 0,
    label: d.label,
  }))
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ScatterChart margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" className="dark:stroke-gray-700" />
        <XAxis type="number" dataKey="x" name={lines?.[0]?.name || 'X'} tick={{ fontSize: 11 }} stroke="#9ca3af" />
        <YAxis type="number" dataKey="y" name={lines?.[1]?.name || 'Y'} tick={{ fontSize: 11 }} stroke="#9ca3af" />
        <Tooltip
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null
            const d = payload[0].payload
            return (
              <div className="bg-[#1c1c1e] text-white px-3 py-2 rounded-lg shadow-lg text-xs border border-gray-700">
                <p className="font-medium">{d.label}</p>
                <p>{lines?.[0]?.name || 'X'}: {d.x?.toLocaleString()}</p>
                <p>{lines?.[1]?.name || 'Y'}: {d.y?.toLocaleString()}</p>
              </div>
            )
          }}
        />
        <Scatter data={scatterData} fill={COLORS[0]} />
      </ScatterChart>
    </ResponsiveContainer>
  )
}

export function RadialKPI({ data, height = 250 }: ChartProps) {
  const item = data[0]
  const value = item?.value ?? 0
  const secondary = data[1]?.value
  return (
    <div className="flex flex-col items-center justify-center" style={{ height }}>
      <div className="text-4xl font-bold text-gray-900 dark:text-white tracking-tight">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      <div className="text-sm text-gray-400 dark:text-gray-500 mt-1">{item?.label}</div>
      {typeof secondary === 'number' && (
        <div className="text-xs text-gray-400 dark:text-gray-500 mt-2">
          {data[1]?.label}: {secondary.toLocaleString()}
        </div>
      )}
    </div>
  )
}
