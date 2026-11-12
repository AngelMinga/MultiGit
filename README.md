# MultiGit

Manejo de Git **multi-repositorio** al estilo IntelliJ IDEA para VS Code: pensado para workspaces
con varios repos independientes (por ejemplo, micro-frontends) que suelen estar en la misma rama.

> Estado: en desarrollo (Fase 3: diálogo de Push). Ver [PLAN.md](PLAN.md) para la hoja de ruta.

## Qué hace hoy

- Contenedor **MultiGit** en la Activity Bar con la vista **Repositorios**: color por repo, rama
  actual, `↑` commits por subir / `↓` por bajar y un badge con la cantidad de cambios sin commit.
- Barra de estado: `⎇ rama` si todos los repos están en la misma, o `⎇ N ramas` si difieren.
- Auto-refresh cuando cambia un repo (o al volver a la ventana) y fetch periódico opcional.
- **Popup de ramas** (clic en la barra de estado o botón ⎇ de la vista), como el de IntelliJ:
  - *Acciones*: Update Project, Commit…, Push…, New Branch…, Checkout Tag or Revision…
  - *Repositorios*: entra a las ramas de un solo repo.
  - *Common Local / Remote Branches*: ramas que existen en todos los repos, favoritas arriba con ★.
  - Por rama: Checkout, New Branch from…, Checkout and Rebase, Compare, Rebase, Merge,
    New Worktree, Update, Push…, Rename… (F2) y Delete.
- Vista **Ramas**: árbol Local / Remote (como el panel de ramas del Git Log de IntelliJ), agrupado
  por repositorio o por rama (`n/9` repos donde existe). Clic en una rama → sus acciones; F2 renombra.
- Diálogo **Push Commits** (botón ⬆ de la vista, *Push…* del popup o *MultiGit: Push Commits…*):
  repos con checkbox y destino `rama → origin : rama` (etiqueta **New** si no existe en el remote),
  commits por subir y sus archivos (doble clic → diff), *Edit all targets*, *Push tags*
  (Current Branch / All), *Force push (with lease)* con confirmación y *Pull y reintentar* si el
  remote rechaza el push.
- Toda operación multi-repo hace un *preflight* (si un repo lo impide no se toca ninguno), muestra
  el progreso repo por repo y, si algo falla, se detiene con un resumen ✅ / ❌ / ⏭.
- Detecta los repos con la API de la extensión integrada `vscode.git` y, además, escaneando las
  carpetas del workspace (`multigit.scanDepth`, por defecto 2).
- Comandos **MultiGit: Refrescar repositorios**, **Fetch en todos los repositorios** y **Ramas…**.
- Output channel **MultiGit** con los repos detectados y su rama.

## Configuración

| Clave | Por defecto | Descripción |
| --- | --- | --- |
| `multigit.scanDepth` | `2` | Profundidad máxima para buscar carpetas `.git` en cada carpeta del workspace. |
| `multigit.favoriteBranches` | `["develop", "production-lt"]` | Ramas que aparecen arriba con ★ en el popup. |
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

Abre esta carpeta en VS Code y pulsa **F5** (en Mac, `fn` + `F5`, con el foco en el editor) para lanzar el
*Extension Development Host*. Alternativa sin depurador:

```bash
npm run dev -- /ruta/al/workspace   # compila y abre una ventana con la extensión en desarrollo
```

## Licencia

MIT
