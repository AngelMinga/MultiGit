# MultiGit

Manejo de Git **multi-repositorio** al estilo IntelliJ IDEA para VS Code: pensado para workspaces
con varios repos independientes (por ejemplo, micro-frontends) que suelen estar en la misma rama.

> Estado: en desarrollo (Fase 1: vista de repositorios + barra de estado). Ver [PLAN.md](PLAN.md) para la hoja de ruta.

## Qué hace hoy

- Contenedor **MultiGit** en la Activity Bar con la vista **Repositorios**: color por repo, rama
  actual, `↑` commits por subir / `↓` por bajar y un badge con la cantidad de cambios sin commit.
- Barra de estado: `⎇ rama` si todos los repos están en la misma, o `⎇ N ramas` si difieren.
- Auto-refresh cuando cambia un repo (o al volver a la ventana) y fetch periódico opcional.
- Detecta los repos con la API de la extensión integrada `vscode.git` y, además, escaneando las
  carpetas del workspace (`multigit.scanDepth`, por defecto 2).
- Comandos **MultiGit: Refrescar repositorios**, **Fetch en todos los repositorios** y **Ramas…**.
- Output channel **MultiGit** con los repos detectados y su rama.

## Configuración

| Clave | Por defecto | Descripción |
| --- | --- | --- |
| `multigit.scanDepth` | `2` | Profundidad máxima para buscar carpetas `.git` en cada carpeta del workspace. |
| `multigit.autoFetchMinutes` | `0` | Cada cuántos minutos hacer `git fetch --all --prune` en todos los repos (`0` = desactivado). |

Los colores de los repos (`multigit.repo0` … `multigit.repo11`) se pueden cambiar en
`workbench.colorCustomizations`.

## Desarrollo

```bash
npm install
npm run build        # typecheck + extensión (esbuild) + webviews (Vite)
npm run watch        # extensión en modo watch
npm run watch:webview
npm test             # vitest
npm run package      # genera multigit-x.y.z.vsix
```

Abre esta carpeta en VS Code y pulsa **F5** para lanzar el *Extension Development Host*.

## Licencia

MIT
