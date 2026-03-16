self.addEventListener("push", event => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || "Cargo Update", {
      body: data.body || "",
      tag:  data.tag  || "cargo-update",
      icon: "/favicon.ico",
      badge: "/favicon.ico",
      requireInteraction: true
    })
  );
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window" }).then(list => {
      for (const client of list) {
        if (client.url.includes("tracker") && "focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow("/agi.html");
    })
  );
});
