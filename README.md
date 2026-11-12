# MultiGit

**Git multi-repositorio al estilo IntelliJ IDEA para VS Code.** Pensado para workspaces con varios
repos independientes (por ejemplo, micro-frontends) que casi siempre están en la misma rama: ves
todos los repos juntos y haces checkout, commit, push, pull o un merge en todos a la vez.

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
  *Unversioned Files*. *Agrupar por* Repositorio y/o Directorio, como IntelliJ. Clic → diff
  contra HEAD; los archivos en conflicto se abren en el merge editor.
- **Commit**: mensaje, *Amend last commit*, contador de archivos marcados, **Commit** y
  **Commit and Push…**. Hace commit solo de los archivos marcados, en cada repo que tenga
  alguno, con el mismo mensaje.
- **Rollback…** (con selección de archivos y confirmación que lista lo que se pierde) y
  **Shelve / Unshelve** con nombre.
- **Repositorios**: cada repo con su color, rama actual, `↑` commits por subir / `↓` por bajar
  y un badge con los cambios sin commit.
- **Ramas**: árbol Local / Remote agrupado por repositorio o por rama (`3/9` repos donde existe).

### Barra de estado y popup de ramas

`⎇ rama` si todos los repos están en la misma rama, o `⎇ N ramas` si difieren. Al hacer clic se
abre el popup de ramas, como el de IntelliJ:

- **Acciones**: Update Project, Commit…, Pull…, Push…, New Branch…, Checkout Tag or Revision…
- **Repositorios**: entra a las ramas de un solo repo.
- **Common Local / Remote Branches**: ramas que existen en todos los repos; favoritas arriba con ★.
- Por rama: Checkout, New Branch from…, Checkout and Rebase, Compare, Show in Git Log, Rebase,
  Merge, New Worktree, Update, Push…, Rename… (F2) y Delete.

### Push y Pull

- **Push Commits**: repos con checkbox y destino `rama → origin : rama` (**New** si la rama no
  existe en el remote, con `push -u`), commits por subir y sus archivos, *Edit all targets*,
  *Push tags*, **Force push (with lease)** con confirmación y **Pull y reintentar** si el remote
  rechaza el push.
- **Pull…**: Repositorio (o Todos) → Remote → Rama (por defecto el upstream) → Merge / Rebase /
  `--ff-only`. Si quedan conflictos, **Resolver conflictos** abre el merge editor.

### Git Log (panel inferior)

- Commits de todos los repos mezclados por fecha, con la franja de color del repo, **grafo de
  ramas** (las aristas largas se cortan con flechas, como IntelliJ), etiquetas, autor y fecha.
- Ramas a la izquierda (HEAD / Local / Remote, con buscador); clic → filtra el log.
- Filtros: texto o hash (regex y mayúsculas), Branch, User (botón **Yo**), Date, Paths y Repo.
- Detalle del commit con sus archivos (doble clic → diff).
- Clic derecho: Copy hash, Checkout revision, Cherry-pick, Revert, Reset current branch to here,
  New branch here y New tag.
- Lista virtualizada: carga de 300 en 300 y se mantiene fluida con miles de commits.

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

Los colores de los repos (`multigit.repo0` … `multigit.repo11`) se pueden cambiar en
`workbench.colorCustomizations`.

## Instalación

```bash
code --install-extension multigit-0.1.0.vsix
```

Requisitos: VS Code 1.100 o superior y Git 2.24 o superior en el `PATH` (o el que use la extensión
Git de VS Code).

## Privacidad

MultiGit no recolecta ni envía datos: no tiene telemetría y no se conecta a ningún servidor. Solo
ejecuta `git` en tu equipo; las operaciones de red (fetch, pull, push) van a los remotes de tus
repositorios con tus credenciales de Git.

## Desarrollo

```bash
npm install
npm run build          # typecheck + extensión (esbuild) + webviews (React + Vite)
npm run watch          # extensión en modo watch (y npm run watch:webview)
npm test               # vitest: parsers, ramas comunes, grafo e integración con git real
npm run package        # genera multigit-x.y.z.vsix
npm run dev -- <ruta>  # abre una ventana con la extensión en desarrollo
```

O abre esta carpeta en VS Code y pulsa **F5**. La hoja de ruta por fases está en [PLAN.md](PLAN.md).

## Licencia

[MIT](LICENSE)
