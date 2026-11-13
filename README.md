# MultiGit

**Git multi-repositorio al estilo IntelliJ IDEA para VS Code.** Pensado para workspaces con varios
repos independientes (por ejemplo, micro-frontends) que casi siempre están en la misma rama: ves
todos los repos juntos y haces checkout, commit, push, pull o un merge en todos a la vez.

**Idiomas**: inglés (por defecto) y español. MultiGit usa el idioma de VS Code (*Configure Display
Language*) en menús, mensajes, diálogos y paneles. Los nombres de acciones heredados de IntelliJ
(*Checkout*, *Rollback*, *Show Diff*…) se mantienen en inglés.

<!--
Capturas: agrega las imágenes en `images/` y descomenta estas líneas.
![Panel MultiGit: Changes, Commit, Repositorios y Ramas](images/panel.png)
![Popup de ramas](images/branches-popup.png)
![Git Log con grafo](images/git-log.png)
![Diálogo Push Commits](images/push.png)
-->

## Funciones

### Panel MultiGit (barra lateral)

- **Proyecto** (en el Explorer): botones como la barra superior de IntelliJ, `[B] proyecto ⌄` (proyectos recientes)
  y `⎇ rama ⌄` (popup de ramas; `⎇ 3 ramas` si difieren), y un resumen que abre el Git Log.
- **Changes**: archivos con cambios de todos los repos, con checkboxes, en *Changes* y
  *Unversioned Files* (y *Ignored Files* con *Show Ignored Files*). *Group By* Repository, Module y/o
  Directory, como IntelliJ. Clic → diff
  contra HEAD; los archivos en conflicto se abren en el merge editor.
- **Commit**: mensaje, *Amend last commit*, contador de archivos marcados, **Commit** y
  **Commit and Push…**. Hace commit solo de los archivos marcados, en cada repo que tenga
  alguno, con el mismo mensaje.
- **Comprobaciones antes del commit** (como las *Commit Checks* de IntelliJ): problemas que informa
  VS Code (errores; también avisos si quieres), `TODO`/`FIXME` nuevos, marcas de conflicto, posibles
  secretos (claves privadas, tokens, API keys, contraseñas) y archivos grandes. Si encuentra algo,
  pregunta **Revisar** (lista para ir a cada línea) o **Commit igualmente**. Se configuran en
  `multigit.commitChecks.*`.
- **Commit parcial** (ícono ☑ en un archivo modificado, o *Select Changes to Commit…* en su menú):
  el diff del archivo con una casilla por cambio (hunk) y otra por línea. Solo las líneas marcadas
  entran en el commit; el resto queda como cambio sin commit y el archivo en disco no se toca. En
  Changes se ve `2/4 líneas` junto al archivo. Si el archivo cambia después de elegir, el commit se
  bloquea en ese repo (sin tocar ninguno) hasta volver a elegir.
- **Generar con Claude** (`⌘G` en la caja de mensaje): escribe el mensaje en formato Conventional
  Commits a partir de los archivos marcados de **todos** los repos, con el CLI de
  [Claude Code](https://claude.com/claude-code) (`claude -p`, usa tu suscripción, sin API key).
  El mensaje aparece mientras se genera; púlsalo otra vez para pedir otra propuesta. Usa la misma
  lógica que la extensión *Commit Messages for Claude Code* y, si la tienes configurada, su
  configuración (`claudeCommit.*`); la propia de MultiGit está en `multigit.claude.*`.
- **Historial de mensajes** (botón 🕘 o `Ctrl+M` en la caja, o *Commit Message History…*): los
  mensajes usados en MultiGit y tus últimos commits en los repos; elige uno para reutilizarlo.
- **Ticket de la rama**: si la rama es `feature/ABC-123-login`, la caja vacía empieza con `ABC-123 `
  y los mensajes de Claude lo llevan. Se configura con `multigit.commit.ticketTemplate` (por
  ejemplo `{ticket}: {message}` o `{message} [{ticket}]`) y `multigit.commit.ticketPattern`.
- **Rollback…** (con selección de archivos y confirmación que lista lo que se pierde) y
  **Shelve / Unshelve** con nombre.
- **Repositorios**: cada repo con su color, rama actual, `↑` commits por subir / `↓` por bajar
  y un badge con los cambios sin commit.
- **Grupos de repos** (botón de filtro en Repositorios): por ejemplo *front* = `mftheme`, `mf*`. Con un
  grupo activo, MultiGit trabaja solo con sus repos: vistas, popup de ramas, checkout, commit, push,
  pull, fetch, Git Log… El grupo se ve en la barra de estado y en el título de Repositorios. Se crean
  con *Nuevo grupo…* (o en `multigit.repoGroups`) y se borran con el ícono de papelera.
- **Ramas**: árbol Local / Remote agrupado por repositorio o por rama (`3/9` repos donde existe).
- **Comparar** (*Compare Files with Current* en una rama, en la vista Ramas o en el popup): los
  archivos distintos entre esa rama y la actual, por repo, con su estado; clic → diff. Los repos sin
  diferencias se listan juntos. Se cierra con ✕.
- **Stashes**: los stashes de todos los repos. Un stash creado a la vez en varios repos (mismo
  mensaje) aparece una sola vez, con un hijo por repo. **Stash Changes…** (`+`, también en el menú ⋯
  de Changes) guarda los cambios de los repos elegidos con un mismo mensaje, con o sin archivos sin
  versionar y *Keep index*. Por stash: **Apply**, **Pop**, **Unstash as Branch…** y **Drop…** (con
  confirmación), en todos sus repos o solo en uno. Clic en un archivo → diff contra la base del
  stash. **Clear All Stashes…** en el menú ⋯.

### Barra de estado y popup de ramas

`⎇ rama` si todos los repos están en la misma rama, o `⎇ N ramas` si difieren. Al hacer clic se
abre el popup de ramas, como el de IntelliJ:

- **Acciones**: Update Project, Commit…, Pull…, Push…, New Branch…, Checkout Tag or Revision…
- **Repositorios**: entra a las ramas de un solo repo.
- **Common Local / Remote Branches**: ramas que existen en todos los repos; favoritas arriba con ★.
- Por rama: Checkout, New Branch from…, Checkout and Rebase, Compare, Show in Git Log, Rebase,
  Merge, New Worktree, Update, Push…, Rename… (F2) y Delete.

### Historial y acciones por archivo

Clic derecho en un archivo (Explorer, editor o Changes) → **Git (MultiGit)**: Commit File…, Add,
Annotate with Git Blame, Show Diff, Compare with Revision…, Compare with Branch or Tag…,
**Show History** (Git Log de ese archivo; al elegir un commit se abre su diff), Show Current
Revision, Rollback…, Push…, Pull… y Branches…. Y **Local History** (historial local de VS Code).

### Push y Pull

- **Push Commits**: repos con checkbox y destino `rama → origin : rama` (**New** si la rama no
  existe en el remote, con `push -u`), commits por subir y sus archivos, *Edit all targets*,
  *Push tags*, **Force push (with lease)** con confirmación y **Pull y reintentar** si el remote
  rechaza el push.
- **Pull…**: Repositorio (o Todos) → Remote → Rama (por defecto el upstream) → Merge / Rebase /
  `--ff-only`. Si quedan conflictos, **Resolver conflictos** abre el merge editor.
- **Crear pull requests…** (menú ⋯ de Repositorios, clic derecho en un repo o el popup de una rama):
  un PR por repo hacia la misma rama destino (las ramas por defecto de los remotos y las favoritas),
  solo en los repos con commits para integrar, con el mismo título y descripción. En **GitHub** se
  crea directamente con tu cuenta de GitHub de VS Code (si ya existía, se muestra ese); en **GitLab**,
  **Bitbucket** y **Azure DevOps** se abre la página de creación con todo puesto. Si la rama no está
  subida, ofrece hacer push primero. Al final, una lista con el enlace de cada PR.

### Git Log (panel inferior)

- Commits de todos los repos mezclados por fecha, con la franja de color del repo, **grafo de
  ramas** (las aristas largas se cortan con flechas, como IntelliJ), etiquetas, autor y fecha.
- Ramas a la izquierda (HEAD / Local / Remote, con buscador); clic → filtra el log; clic derecho → el
  mismo menú que la vista Ramas.
- Filtros: texto o hash (regex y mayúsculas), Branch, User (botón **Yo**), Date, Paths y Repo.
- Detalle del commit con sus archivos (doble clic → diff).
- Clic derecho: Copy hash, Checkout revision, Cherry-pick, Revert, Reset current branch to here,
  New branch here y New tag.
- **Interactively rebase from here…** (clic derecho en un commit de la rama actual): los commits desde
  ese hasta HEAD, del más viejo al más nuevo, con **Pick**, **Reword** (mensaje nuevo ahí mismo),
  **Squash**, **Fixup** y **Drop**, y ↑/↓ para reordenar (teclas P R S F D y Alt+↑/↓). Pide el working
  tree limpio; si hay conflictos, el rebase queda a medias y se sigue desde la barra de operaciones.
  No admite rangos con commits de merge.
- Lista virtualizada: carga de 300 en 300 y se mantiene fluida con miles de commits.

## Credenciales, conflictos y ramas desalineadas

- **Credenciales**: si git o ssh necesitan usuario, contraseña/token, la passphrase de la clave o
  confirmar la huella de un servidor, MultiGit lo pide en un cuadro de VS Code (como la extensión
  Git integrada). En un fetch/push de varios repos al mismo servidor pregunta una sola vez (la
  respuesta se recuerda unos minutos, solo en memoria). Si tus credenciales están en el llavero o en
  el agente SSH, no pregunta nada.
- **Operaciones a medias**: si un merge, rebase, cherry-pick o revert queda en conflicto, el repo se
  marca `⚠ REBASE · 2 conflictos` y la barra de estado muestra el aviso, con **Resolve Conflicts**,
  **Continue** (marca los resueltos y continúa), **Skip** y **Abort**, por repo o en todos.
- **Ramas desalineadas**: si la mayoría de los repos está en una rama y algunos en otra, la barra de
  estado muestra `⎇ dev-x ⚠1`, el repo se marca `≠` y el popup de ramas ofrece **Alinear** (checkout
  de la rama, o creándola desde `origin`). Aviso desactivable con `multigit.warnBranchMismatch`.

## Operaciones seguras

- **Preflight**: antes de una operación en varios repos (checkout, merge, rebase, pull, push…) se
  revisa el estado de todos. Si alguno la impide (conflictos, merge/rebase a medias, cambios sin
  commit cuando hacen falta), se muestra cuál y por qué y **no se toca ninguno**.
- **Repo por repo**, con progreso (`3/9 mftheme…`). Si uno falla, se detiene y muestra el resumen
  ✅ ok / ❌ falló + motivo / ⏭ no ejecutado.
- **Confirmación obligatoria** en lo destructivo (rollback, delete, reset, force push), listando
  exactamente qué se pierde.
- Git se ejecuta siempre con `execFile` y argumentos separados (nunca una línea de shell), sin
  pedir credenciales en una terminal oculta.

## Atajos de teclado

| Atajo (macOS / Windows-Linux) | Acción | Cuándo |
| --- | --- | --- |
| `⌘K` / `Ctrl+K` | Commit… (caja de commit) | con el foco en una vista de MultiGit |
| `⌘⇧K` / `Ctrl+Shift+K` | Push Commits… | con el foco en una vista de MultiGit |
| `⌘T` / `Ctrl+T` | Update Project | con el foco en una vista de MultiGit |
| `⌘⇧⌥B` / `Ctrl+Shift+Alt+B` | Popup de ramas | siempre |
| `F2` | Renombrar rama | en el popup o en la vista Ramas |
| `⌘Enter` / `⌘⇧Enter` | Commit / Commit and Push… | en la caja de commit |
| `⌘G` / `Ctrl+G` | Generar el mensaje con Claude | en la caja de commit |

Los atajos estilo IntelliJ solo se activan con el foco en MultiGit, así no reemplazan los de VS Code.
Para usarlos en todas partes, cámbialos en *Preferences → Keyboard Shortcuts* (busca `MultiGit`).

## Configuración

| Clave | Por defecto | Descripción |
| --- | --- | --- |
| `multigit.scanDepth` | `2` | Profundidad para buscar carpetas `.git` en cada carpeta del workspace. |
| `multigit.ignoredRepos` | `[]` | Repos a ocultar, por nombre o ruta; admite `*` y `**`. |
| `multigit.favoriteBranches` | `["develop", "production-lt"]` | Ramas que van arriba con ★. |
| `multigit.autoFetchMinutes` | `0` | `git fetch --all --prune` periódico (`0` = desactivado). |
| `multigit.confirmCheckoutWithChanges` | `true` | Avisar antes de un checkout en repos con cambios. |
| `multigit.warnBranchMismatch` | `true` | Avisar cuando algún repo queda en otra rama que la mayoría. |
| `multigit.commit.ticketPattern` | `[A-Z][A-Z0-9]+-\d+` | Regex que saca el ticket del nombre de la rama (`feature/ABC-123-login` → `ABC-123`). Vacío: sin ticket. |
| `multigit.pullRequests.*` | — | `useGitHubApi` (`true`), `draft` (`false`) y `providers` (servicio de tus servidores Git propios por host, p. ej. `{ "git.empresa.com": "gitlab" }`). |
| `multigit.repoGroups` | `{}` | Grupos de repos: nombre → repos (admite `*`). |
| `multigit.commitChecks.*` | activadas | Comprobaciones antes del commit: `enabled`, `diagnostics` (`off`/`errors`/`warnings`), `todo`, `conflictMarkers`, `secrets`, `largeFileMB` (`5`; `0` = no). |
| `multigit.commit.ticketTemplate` | `{ticket} {message}` | Dónde va el ticket en el mensaje (`{ticket}`, `{branch}`, `{message}`). Vacío: desactivado. |
| `multigit.claude.*` | — | Modelo, esfuerzo, idioma, modo rápido, estilo del repo, scope, instrucciones, timeout y ruta de `claude` para *Generar con Claude*. |

Los colores de los repos (`multigit.repo0` … `multigit.repo11`) se pueden cambiar en
`workbench.colorCustomizations`.

MultiGit cambia además el valor por defecto de dos ajustes de VS Code para que los diffs se abran
siempre en dos paneles (original | cambios), como IntelliJ, aunque el editor sea angosto:
`diffEditor.renderSideBySide: true` y `diffEditor.useInlineViewWhenSpaceIsLimited: false`. Si
tienes un valor propio en tu `settings.json`, ese manda.

## Instalación

```bash
code --install-extension multigit-0.1.0.vsix
```

Requisitos: VS Code 1.100 o superior y Git 2.24 o superior en el `PATH` (o el que use la extensión
Git de VS Code).

## Privacidad

MultiGit no tiene telemetría ni se conecta a ningún servidor propio. Ejecuta `git` en tu equipo; las
operaciones de red (fetch, pull, push) van a los remotes de tus repositorios con tus credenciales.

**Generar con Claude** solo envía datos cuando pulsas el botón: pasa al CLI `claude` de tu equipo el
diff de los archivos marcados (hasta 15 000 caracteres por archivo y 100 000 en total; de los locks,
minificados y carpetas generadas solo la ruta), los nombres de los repos y la rama, los títulos de
los últimos 20 commits (desactivable con `multigit.claude.imitateRepoStyle`), tus instrucciones
adicionales y, en modo rápido, la sección de commits del `CLAUDE.md` del proyecto. El CLI lo envía a
**Anthropic** con tu cuenta de Claude, bajo tu acuerdo con Anthropic y su
[política de privacidad](https://www.anthropic.com/legal/privacy). No marques archivos con secretos
si no quieres que se envíen.

## Desarrollo

```bash
npm install
npm run build          # typecheck + extensión (esbuild) + webviews (React + Vite)
npm run watch          # extensión en modo watch (y npm run watch:webview)
npm test               # vitest: parsers, ramas comunes, grafo e integración con git real
npm run test:e2e       # tests dentro de un VS Code real (descarga VS Code la primera vez)
npm run package        # genera multigit-x.y.z.vsix
npm run dev -- <ruta>  # abre una ventana con la extensión en desarrollo
```

O abre esta carpeta en VS Code y pulsa **F5**.

**Traducciones**: el texto se escribe en inglés con `t('…')` (`src/i18n.ts` en la extensión,
`webview-ui/src/i18n.ts` en los webviews) y la traducción va en `l10n/bundle.l10n.<idioma>.json`; los
menús y comandos están en `package.nls.<idioma>.json`. `test/i18n.test.ts` comprueba que cada clave
del bundle tiene los mismos `{n}` que su traducción.

**CI**: cada push a `main` y cada PR corre typecheck, tests (Linux, macOS y Windows), los tests e2e y empaqueta el `.vsix`.
**Release**: con un tag `vX.Y.Z` igual a la versión de `package.json` se publica en el VS Code
Marketplace (secreto `VSCE_PAT`), en Open VSX (`OVSX_PAT`) y se crea el GitHub Release con el `.vsix`. La hoja de ruta por fases está en [PLAN.md](PLAN.md).

## Licencia

[MIT](LICENSE)
