import { useEffect, useState } from "react";
/** Presentation preference only; not authentication or hardware proof. */
export function useComputerBinding(deviceId: string) {
  const key = `busybar.this-computer.${deviceId}`;
  const [binding, setBinding] = useState<{ key: string; id: string | null }>({
    key,
    id: null,
  });
  useEffect(() => {
    let id: string | null = null;
    try {
      id = localStorage.getItem(key);
    } catch {
      /* Storage may be disabled. */
    }
    setBinding({ key, id });
    const changed = (event: StorageEvent) => {
      if (event.key === key || event.key === null)
        setBinding({ key, id: event.newValue });
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [key]);
  const bind = (id: string | null) => {
    try {
      if (id) localStorage.setItem(key, id);
      else localStorage.removeItem(key);
    } catch {
      /* In-memory preference still works. */
    }
    setBinding({ key, id });
  };
  return [binding.key === key ? binding.id : null, bind] as const;
}
