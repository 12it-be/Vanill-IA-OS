# Vanill-IA OS — Dynamic Plugins Directory

Drop any folder containing a `manifest.json` inside `/var/lib/vanill-ia-os/apps/<your-plugin>/` and reload the desktop (no `.deb` rebuild required).

## Example 1 — Sandboxed Window App (`launchMode: "window"`)
`/var/lib/vanill-ia-os/apps/hello-world/manifest.json`:
```json
{
  "id": "hello-world",
  "name": {
    "en": "Hello Tool",
    "fr": "Outil Hello"
  },
  "description": {
    "en": "Custom internal admin widget",
    "fr": "Widget interne personnalisé"
  },
  "icon": "icon.svg",
  "accentColor": "#6366F1",
  "launchMode": "window",
  "entry": "index.html",
  "width": 900,
  "height": 600
}
```

## Example 2 — External Browser Tab (`launchMode: "external"`)
`/var/lib/vanill-ia-os/apps/grafana/manifest.json`:
```json
{
  "id": "grafana",
  "name": "Grafana",
  "description": {
    "en": "Metrics & Dashboards",
    "fr": "Métriques & Tableaux de bord"
  },
  "icon": "activity",
  "accentColor": "#F59E0B",
  "launchMode": "external",
  "url": "https://grafana.example.local"
}
```
