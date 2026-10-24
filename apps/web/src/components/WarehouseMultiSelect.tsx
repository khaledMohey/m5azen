type Warehouse = { id: string; name: string };

export function WarehouseMultiSelect({
  warehouses,
  value,
  onChange,
  hint = 'لو مفيش اختيار، يظهر للكل',
}: {
  warehouses: Warehouse[];
  value: string[];
  onChange: (ids: string[]) => void;
  hint?: string;
}) {
  return (
    <div>
      <div className="flex flex-wrap gap-2 rounded-xl border border-slate-200 bg-white p-3">
        {warehouses.length === 0 ? (
          <span className="text-xs text-muted">مفيش مخازن</span>
        ) : (
          warehouses.map((warehouse) => {
            const checked = value.includes(warehouse.id);
            return (
              <label
                key={warehouse.id}
                className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-bold ${
                  checked ? 'border-brand-300 bg-brand-50 text-brand-800' : 'border-slate-200 text-slate-600'
                }`}
              >
                <input
                  type="checkbox"
                  className="accent-[var(--color-brand-700)]"
                  checked={checked}
                  onChange={(event) => {
                    onChange(
                      event.target.checked
                        ? [...value, warehouse.id]
                        : value.filter((id) => id !== warehouse.id),
                    );
                  }}
                />
                {warehouse.name}
              </label>
            );
          })
        )}
      </div>
      {hint ? <p className="mt-1.5 text-[11px] text-muted">{hint}</p> : null}
    </div>
  );
}
