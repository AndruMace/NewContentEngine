interface Props {
  schema: { properties: Record<string, any> };
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
}

/** Controls generated from a template's JSON Schema (derived from its zod schema). */
export function ParamControls({ schema, values, onChange }: Props) {
  const set = (key: string, v: unknown) => onChange({ ...values, [key]: v });
  return (
    <div className="params">
      {Object.entries(schema.properties).map(([key, prop]) => {
        const label = prop.title ?? key;
        const value = values[key] ?? prop.default;
        if (prop.type === 'boolean') {
          return (
            <label key={key} className="param param-check">
              <input type="checkbox" checked={Boolean(value)} onChange={(e) => set(key, e.target.checked)} />
              {label}
            </label>
          );
        }
        if (prop.enum) {
          return (
            <label key={key} className="param">
              <span>{label}</span>
              <select value={String(value)} onChange={(e) => set(key, e.target.value)}>
                {prop.enum.map((opt: string) => (
                  <option key={opt}>{opt}</option>
                ))}
              </select>
            </label>
          );
        }
        if (prop.type === 'number' || prop.type === 'integer') {
          const step = prop.step ?? (prop.type === 'integer' ? 1 : (prop.maximum - prop.minimum) / 200);
          return (
            <label key={key} className="param">
              <span>
                {label} <b>{Number(value).toFixed(prop.type === 'integer' ? 0 : step < 0.01 ? 3 : step < 1 ? 2 : 0)}</b>
              </span>
              <input
                type="range"
                min={prop.minimum}
                max={prop.maximum}
                step={step}
                value={Number(value)}
                onChange={(e) => set(key, Number(e.target.value))}
              />
            </label>
          );
        }
        return null;
      })}
    </div>
  );
}
