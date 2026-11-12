# Changelog

## 0.1.3

- Vista **Proyecto** al principio del panel MultiGit con los botones de IntelliJ: `[B] proyecto ⌄` (proyectos recientes) y `⎇ rama ⌄` (popup de ramas), más una línea de resumen que abre el Git Log.

## 0.1.2

- Clic derecho en una rama (vista Ramas) con el menú de IntelliJ: Checkout, New Branch from, Checkout and Rebase onto Current, Compare with Current, Show Diff with Working Tree, Rebase, Merge, New Worktree, Update, Push…, Rename… (F2), Delete y Show in Git Log.
- Nueva acción *Show Diff with Working Tree* (también en el popup).

## 0.1.1

- Popup de ramas al estilo IntelliJ: acciones con sus atajos, New Worktree…, repos con su cuadrado de color y la rama con ›, rama actual primero con 🏷 y tracking (`origin/develop`), remotas agrupadas por remote.
- Barra de estado: nombre del proyecto (abre los recientes) junto a la rama, al principio a la izquierda.

## 0.1.0

Primera versión completa (Fases 0 a 8 de PLAN.md).

- Configuración: `multigit.ignoredRepos` y `multigit.confirmCheckoutWithChanges`, además de
  profundidad de búsqueda, ramas favoritas y auto-fetch.
- Atajos estilo IntelliJ (`⌘K` commit, `⌘⇧K` push, `⌘T` update project) activos con el foco en
  MultiGit, y `⌘⇧⌥B` para el popup de ramas.
- Comando *Update Project*, ícono y metadatos para el Marketplace, README completo.

## 0.0.14

- Grafo: las aristas largas se cortan con flechas ↓/↑ como en IntelliJ (más de 30 commits del repo o 120 filas), máximo 16 carriles.
- Etiquetas de ramas compactas a la derecha del mensaje (primera + "+N"); el mensaje siempre visible.

## 0.0.13

- Fase 7: grafo de commits en el Git Log (algoritmo propio de carriles, merges, ramas paralelas y octopus; colores por rama; un SVG por fila compatible con la virtualización).

## 0.0.12

- Git Log al estilo IntelliJ: etiquetas a la derecha, autor en negrita, fechas "Hoy 08:51" / "20/10/26, 12:04", commits fuera de la rama actual atenuados y buscador de ramas.

## 0.0.11

- Changes y Commit dentro del panel MultiGit; Agrupar por Repositorio/Directorio combinables.
- Fase 6: Git Log combinado en el panel inferior (ramas, filtros, lista virtualizada de 300 en 300, detalle y menú contextual).

## 0.0.8

- Fase 5: vista Changes con checkboxes (por repo o por directorio), caja de Commit con Amend y Commit and Push…, Rollback con confirmación y Shelve/Unshelve.

## 0.0.7

- Fase 4: diálogo de Pull (repositorio → remote → rama → merge/rebase/--ff-only) y resolución de conflictos con el merge editor.
- Los resúmenes de merge/rebase/pull indican los archivos en conflicto.

## 0.0.4

- Vista de árbol **Ramas** (Local / Remote), agrupada por repositorio o por rama.
- Fase 3: diálogo **Push Commits** en webview: New, Edit all targets, Push tags, Force push (with lease), resumen por repo y Pull y reintentar.

## 0.0.3

- Fase 2: popup de ramas multi-repo (ramas comunes, favoritas, checkout, new branch, merge, rebase, compare, worktree, update, push, rename y delete) con preflight y resumen.
- mflogin y el resto de repos con color 11 pasan de marrón a gris azulado.

## 0.0.1

- Fase 0: esqueleto de la extensión, detección de repos y Output channel.
- Fase 1: vista Repositorios con ↑/↓ y badge de cambios, barra de estado, auto-refresh y auto-fetch.
