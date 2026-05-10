export function logClientAction(action, details = {}) {
  if (typeof window === "undefined") {
    return;
  }

  const payload = JSON.stringify({
    action,
    details: {
      page: window.location.pathname,
      ...details,
    },
  });

  if (navigator.sendBeacon) {
    const blob = new Blob([payload], { type: "application/json" });

    navigator.sendBeacon("/api/v1/user-actions/log", blob);
    return;
  }

  fetch("/api/v1/user-actions/log", {
    method: "POST",
    body: payload,
    cache: "no-store",
    headers: {
      "content-type": "application/json",
    },
    keepalive: true,
  }).catch(() => {});
}
