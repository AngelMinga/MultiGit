# Changelog

## 0.3.2

- Menús, comandos y ajustes en **inglés y español** según el idioma de VS Code (`package.nls`).
- Corrige el submenú **Group By** del menú ⋯ de Changes, que VS Code descartaba por estar repetido.
- Menos consumo en repos grandes: los repos que no abrió la extensión Git ya no se vigilan con
  `**/*`, solo `.git` y los archivos que VS Code guarda, crea, borra o renombra.
- Interno: `extension.ts` dividido por área, tests dentro de VS Code real (e2e) y CI en Linux,
  macOS y Windows.

## 0.3.1

- Corrige la vista Repositorios: el repo en una rama distinta a la mayoría (`≠`) no se mostraba.

## 0.3.0

- **Credenciales**: askpass propio. MultiGit pide en VS Code el usuario, token, passphrase SSH o la
  confirmación del host cuando git los necesita (antes fetch/pull/push fallaban), una sola vez para
  todos los repos.
- **Operaciones a medias**: aviso en la barra de estado y en Repositorios con Resolve Conflicts,
  Continue, Skip y Abort, por repo o en todos.
- **Ramas desalineadas**: aviso `⎇ rama ⚠N`, marca `≠` en Repositorios y acción **Alinear** en el
  popup de ramas (`multigit.warnBranchMismatch`).
- **Rollback Changes** como diálogo de IntelliJ: árbol repo → carpetas → archivos con casillas,
  contador, *Delete local copies of added files* y diff con doble clic.
- Submenú **Add to .gitignore ›** en Changes y contadores **↑/↓** en las ramas (vista Ramas y Git Log).
- **CI y releases**: workflows de GitHub Actions (tests en Linux y macOS, empaquetado) y publicación
  por tag en Marketplace, Open VSX y GitHub Releases.

## 0.2.5

- Changes: **Group By ›** en el menú ⋯ (además del botón ☰) con **Directory**, **Repository** y
  **Module** (carpeta con `package.json`, `pubspec.yaml`, `build.gradle`…), combinables en el orden
  Repository → Module → Directory, como IntelliJ.
- **Show Ignored Files**: sección *Ignored Files* (carpetas ignoradas como una sola entrada, sin
  checkbox; clic → mostrar en el Explorer).

## 0.2.4

- Vista **Ramas** (barra lateral): menú ⋯ como IntelliJ con **On Single Click** (Show Actions /
  Update Branch Filter / Navigate Log to Branch Head), **Group by Directory**, **Group by Repository**
  y **Show Tags**. Las opciones se recuerdan.
- Tags en la vista Ramas, con sus acciones (Checkout, Show in Git Log, Navigate Log to Tag, Compare).

## 0.2.3

- Git Log: menú ⋮ en el árbol de ramas como IntelliJ: **On Single Click** (Update Branch Filter /
  Navigate Log to Branch Head), Group by Directory, Group by Repository y **Show Tags**. Las opciones
  se recuerdan.
- Navigate Log to Branch Head: selecciona y desplaza hasta el último commit de la rama o tag (carga
  más páginas si hace falta), sin filtrar el log.
- Sección Tags en el árbol de ramas; clic en un tag filtra o navega igual que una rama.

## 0.2.2

- Submenú **Git (MultiGit)** en el Explorer, el editor y Changes, como IntelliJ: Commit File…, Add,
  Annotate with Git Blame, Show Diff, Compare with Revision…, Compare with Branch or Tag…,
  **Show History**, Show Current Revision, Rollback…, Push…, Pull… y Branches….
- **Show History**: Git Log del archivo (en HEAD, siguiendo renombres); al elegir un commit se abre
  el diff de ese archivo.
- Submenú **Local History** (el historial local de VS Code): Show History…, Show Project History…
  y Put Label….

## 0.2.1

- Clic derecho en Changes como IntelliJ: Commit File/Directory…, Rollback… (⌥⌘Z), Show Diff (⌘D),
  Open File, Delete… (a la papelera), Add to VCS (⌥⌘A), .git/info/exclude, Add to .gitignore,
  Copy as Patch to Clipboard, Shelve Changes…, Refresh y submenú Git (Push, Pull, Fetch, Branches,
  New Branch, Show Git Log).
- Selección múltiple en Changes.

## 0.2.0

- **Generar con Claude** en la caja Commit: mensaje Conventional Commits a partir de los archivos
  marcados de todos los repos, con el CLI de Claude Code (streaming, otra propuesta al volver a
  pulsar, cancelar). Reutiliza los módulos de *Commit Messages for Claude Code* y su configuración.
- Configuración `multigit.claude.*`.

## 0.1.5

- La vista **Proyecto** (botones de proyecto y rama) pasa al Explorer, junto al árbol de archivos.

## 0.1.4

- Botón ⎇ en la barra del Explorer: acceso directo al popup de ramas.

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
