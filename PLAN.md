# Prompt para Claude en VS Code: extensión "MultiGit" (Git multi-repo estilo IntelliJ)

Cómo usarlo: guarda este archivo en la raíz del proyecto de la extensión como PLAN.md. En Claude escribe: "Lee PLAN.md y ejecuta la Fase 0. Detente al terminarla." Cuando la revises y funcione: "Continúa con la Fase 1", y así hasta el final.

## Contexto

Eres un desarrollador senior de extensiones de VS Code. Vamos a construir MultiGit, una extensión gratuita que replica el manejo de Git de IntelliJ IDEA para workspaces con varios repositorios.

Caso real: un proyecto de micro-frontends con 9 repos Git independientes (mfbankingservice, mfcomponents, mfconsolidatedposition, mflogin, mfmassivetransferspeople, mfservicepay, mftheme, mftransfer, shell) que casi siempre están en la misma rama (por ejemplo dev-afminga-push-notifications). Las ramas base son develop y production-lt.

## Stack y reglas técnicas

- TypeScript estricto, empaquetado con esbuild.
- Extension host en Node. Para correr git usa `child_process.execFile('git', args, { cwd })`, nunca exec con strings concatenados (evita inyección de comandos).
- Para descubrir repos usa la API de la extensión integrada `vscode.git` (`getAPI(1)`). Si no está, escanea las carpetas del workspace buscando `.git` (profundidad configurable, por defecto 2).
- UI nativa siempre que se pueda: TreeView (con checkboxes), QuickPick (con separadores) y `window.withProgress`.
- Webview con React + Vite solo donde no alcance lo nativo (diálogo de Push, Log). Comunicación host↔webview con mensajes tipados (type + payload).
- Usa los colores del tema de VS Code (`var(--vscode-*)`) para que se vea bien en modo oscuro y claro.
- Asigna a cada repo un color estable (hash del nombre → paleta). Ese color se usa en todas las vistas, igual que en IntelliJ.
- Los textos de la UI van en español.
- Sin dependencias de pago. Licencia MIT.

## Reglas de trabajo (obligatorias)

1. Trabaja una fase a la vez. Al terminar cada fase detente, muestra un resumen de lo que hiciste y cómo probarlo (F5 → Extension Development Host), y espera mi confirmación.
2. Antes de escribir código en cada fase, lista en 3 a 6 líneas los archivos que vas a crear o modificar.
3. Un servicio central GitService (por repo) y un RepoManager (todos los repos). Ninguna vista llama a git directamente.
4. Operaciones destructivas (rollback, delete de rama, reset, borrar archivos): siempre con un modal de confirmación que liste exactamente qué se va a perder.
5. Operaciones en varios repos (checkout, merge, rebase, pull, push):
   - Antes de empezar haz un preflight: revisa `git status --porcelain` y el estado de merge/rebase en cada repo. Si alguno impide la operación, muestra cuál y por qué, y no toques ninguno.
   - Ejecuta repo por repo, con progreso ("3/9 mftheme…").
   - Si uno falla (conflicto, rechazo), detente y muestra un resumen: ✅ ok / ❌ falló + motivo / ⏭ no ejecutado.
6. Escribe tests unitarios (vitest) para el parseo de salidas de git y para la lógica de "ramas comunes" y "commits pendientes".
7. Al terminar cada fase, crea un commit con Conventional Commits, por ejemplo `feat(push): diálogo de push multi-repo`.

## Fase 0: Esqueleto

- package.json de la extensión (engines.vscode reciente, activationEvents de workspace con git).
- Estructura:

  ```
  src/
    extension.ts
    git/GitService.ts        // wrapper execFile + parsers
    git/RepoManager.ts       // descubre repos, eventos de cambio, color por repo
    git/parsers.ts
    views/                   // TreeViews y QuickPicks
    webview/                 // host de paneles webview
  webview-ui/                // app React + Vite (build a /dist/webview)
  test/
  ```

- Un contenedor propio en la Activity Bar llamado "MultiGit".
- Comando MultiGit: Refrescar repositorios.
- Scripts: build, watch, test, package (con @vscode/vsce).

**Listo cuando:** F5 abre la extensión, aparece el ícono MultiGit y el Output channel "MultiGit" muestra los repos detectados con su rama actual.

## Fase 1: Vista de repositorios + barra de estado

- TreeView "Repositorios": cada repo con su color, rama actual, ↑commits por subir / ↓por bajar (`git rev-list --left-right --count @{u}...HEAD`) y un indicador de cambios sin commit.
- Barra de estado: `⎇ dev-afminga-push-notifications` si todos están en la misma rama, o `⎇ 3 ramas` si difieren. Al hacer clic abre el popup de ramas (Fase 2).
- Auto-refresh cuando cambien los repos y un fetch periódico opcional (configuración `multigit.autoFetchMinutes`).

**Listo cuando:** se ven los 9 repos con su rama y contadores correctos.

## Fase 2: Popup de ramas (como el de IntelliJ)

QuickPick con búsqueda y estas secciones (usa separadores):

- **Acciones:** Update Project (pull en todos), Commit…, Push…, New Branch…, Checkout Tag or Revision…
- **Repositorios:** cada repo con su rama actual. Al elegirlo se muestran las ramas de solo ese repo.
- **Common Local Branches:** ramas locales que existen en todos los repos (intersección). La rama actual va marcada y las favoritas (develop, production-lt, configurables) arriba con ★.
- **Common Remote Branches:** agrupadas por remote (origin/...).

Al elegir una rama, un segundo QuickPick con las acciones (se ejecutan en todos los repos, con las reglas de la regla 5):

- Checkout
- New Branch from '<rama>'…
- Checkout and Rebase onto '<actual>'
- Compare with '<actual>' (lista de commits diferentes por repo)
- Rebase '<actual>' onto '<rama>'
- Merge '<rama>' into '<actual>'
- New Worktree from '<rama>'… (git worktree add)
- Update (pull de esa rama), Push…
- Rename… (F2), Delete (con confirmación; si no está mergeada, pregunta si forzar -D)

"New Branch…" crea la rama en todos los repos a la vez (opción: hacer checkout).

**Listo cuando:** puedo crear dev-afminga-prueba desde develop en los 9 repos y volver a develop con un solo flujo.

## Fase 3: Diálogo de Push Commits (webview)

- Panel webview, a la izquierda la lista de repos con:
  - Checkbox (marcados por defecto los que tienen algo por subir).
  - `rama-local → origin : rama-remota` y la etiqueta **New** si la rama no existe en el remote.
  - Botón "Edit all targets" para cambiar remote o rama destino de todos a la vez.
- A la derecha: los commits por subir del repo seleccionado (`git log @{u}..HEAD`, o contra `origin/develop` si es New) y, al elegir un commit, sus archivos cambiados.
- Abajo: checkbox "Push tags" (Todos / solo los del commit actual), un botón Push y un desplegable con "Force push (with lease)" que pide confirmación.
- Si la rama es New, usa `git push -u origin <rama>`.
- Resumen final por repo. Si el remote rechaza el push, ofrece "Pull y reintentar".

**Listo cuando:** el push de una rama nueva en los 9 repos funciona en un clic y muestra el resumen.

## Fase 4: Diálogo de Pull

- QuickPick encadenado: Repositorio (o "Todos") → Remote → Rama (con búsqueda en `git branch -r`; por defecto el upstream).
- Opciones: merge (por defecto) / rebase / --ff-only.
- Si hay conflictos, indica el repo y abre la vista de merge de VS Code.
- "Update Project" (desde la Fase 2) = fetch + pull del upstream en todos los repos.

**Listo cuando:** puedo hacer pull de origin/develop en mftheme solo, o en todos.

## Fase 5: Changes, Commit y Rollback

- TreeView "Changes" con checkboxes, agrupado por Repositorio → Directorio → Archivo (opción en la barra para cambiar entre agrupar por repo o por directorio, igual que IntelliJ). Cada repo muestra su rama al lado.
- Secciones: Changes y Unversioned Files.
- Ícono y color según el estado (M, A, D, R, ?). Al hacer clic en un archivo se abre el diff nativo (`vscode.diff` contra HEAD).
- Caja de commit: mensaje, checkbox Amend last commit, botones Commit y Commit and Push… (este último abre la Fase 3). Hace commit solo de los archivos marcados, en cada repo que tenga archivos marcados, con el mismo mensaje.
- Rollback…: modal con el mismo árbol de checkboxes, el contador "N modified" y el checkbox "Delete local copies of added files".
  - Modificados/borrados: `git restore --staged --worktree -- <archivos>`
  - Añadidos: `git rm --cached -- <archivos>` y, si la opción está marcada, borrarlos del disco.
  - Confirmación obligatoria (regla 4).
- Opcional: "Shelf" simple con `git stash push -- <archivos>` por repo, con nombre.

**Listo cuando:** puedo marcar 3 archivos de mfcomponents y 1 de mftheme, hacer commit de solo esos, y hacer rollback del resto.

## Fase 6: Log combinado (webview, sin grafo)

- Panel webview "Git Log" en el panel inferior (WebviewView).
- Izquierda: árbol de ramas HEAD / Local / Remote, con opciones "Group by Repository" y "Group by Directory". Al hacer clic en una rama se filtra el log.
- Centro: lista virtualizada (react-window) con los commits de todos los repos ordenados por fecha. Cada fila tiene una franja con el color del repo, el mensaje, etiquetas de ramas y tags, autor y fecha relativa ("Today 08:51").
- Carga de 300 en 300 (`--skip`) al hacer scroll.
- Filtros arriba: texto/hash (con regex y mayúsculas opcionales), Branch, User, Date, Paths y Repositorio.
- Derecha: detalle del commit seleccionado (archivos, mensaje completo) con doble clic para ver el diff.
- Menú de clic derecho: Copy hash, Checkout revision, Cherry-pick, Revert, Reset current branch to here (soft/mixed/hard, con confirmación), New branch here, New tag.

**Listo cuando:** veo el historial de los 9 repos mezclado y puedo filtrar por mi usuario y por la rama dev-afminga-scheduled-transfers.

## Fase 7: Grafo de commits

- Algoritmo propio de asignación de carriles por repo (no copies código de Git Graph de mhutchie, su licencia no es MIT).
- Render en SVG o canvas al lado de cada fila, sincronizado con la virtualización.
- Colores por rama dentro de cada repo y franja del color del repo.
- Tests del algoritmo con historias que tengan merges, ramas paralelas y octopus merges.

**Listo cuando:** el grafo se ve parecido al de IntelliJ y el scroll sigue fluido con 5 000 commits.

## Fase 8: Pulido y empaquetado

- Configuración: profundidad de búsqueda, ramas favoritas, repos ignorados, auto-fetch y confirmaciones.
- Atajos: Cmd+K commit, Cmd+Shift+K push, Cmd+T update project (configurables, sin pisar los de VS Code por defecto).
- README con capturas.
- `npm run package` → .vsix, instalable con `code --install-extension multigit-x.y.z.vsix`.

Empieza ahora con la Fase 0. No avances a la siguiente fase sin mi confirmación.
