import { useStore } from "../state/store";

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind}`} role="status">
          <span style={{ flex: 1 }}>{toast.message}</span>
          <button title="Dismiss" onClick={() => dismiss(toast.id)}>
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}
